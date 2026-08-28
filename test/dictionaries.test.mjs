import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';

// End-to-end build over a synthetic kaikki source: form_of/alt_of entries must
// resolve to the lemma's definition (the reader's direct .idx hit preempts its
// .syn and stemming fallbacks, so a bare "plural of cat" stub would otherwise
// be all the user ever sees).

const root = new URL('../', import.meta.url);
const script = fileURLToPath(new URL('scripts/build-dictionaries.mjs', root));

const kaikkiLines = [
  { word: 'cat', pos: 'noun', senses: [{ glosses: ['small domesticated feline'] }] },
  { word: 'cats', pos: 'noun', senses: [{ glosses: ['plural of cat'], form_of: [{ word: 'cat' }] }] },
  // Lemma missing from the source: the stub is the best we have, keep it.
  { word: 'mice', pos: 'noun', senses: [{ glosses: ['plural of mouse'], form_of: [{ word: 'mouse' }] }] },
  // Mixed headword: own sense in one block, form-of in another.
  { word: 'find', pos: 'verb', senses: [{ glosses: ['to locate something'] }] },
  { word: 'found', pos: 'verb', senses: [{ glosses: ['simple past of find'], form_of: [{ word: 'find' }] }] },
  { word: 'found', pos: 'verb', senses: [{ glosses: ['to establish an organization'] }] },
  // Chain: runnin' -> running -> run.
  { word: 'run', pos: 'verb', senses: [{ glosses: ['to move fast'] }] },
  { word: 'running', pos: 'verb', senses: [{ glosses: ['present participle of run'], form_of: [{ word: 'run' }] }] },
  { word: "runnin'", pos: 'verb', senses: [{ glosses: ['alternative spelling of running'], alt_of: [{ word: 'running' }] }] },
  // Case-merged lemma group: marched must land on the merged march/March body.
  { word: 'March', pos: 'noun', senses: [{ glosses: ['the third month'] }] },
  { word: 'march', pos: 'verb', senses: [{ glosses: ['to walk in step'] }] },
  { word: 'marched', pos: 'verb', senses: [{ glosses: ['simple past of march'], form_of: [{ word: 'march' }] }] },
];

const tmp = mkdtempSync(join(tmpdir(), 'dict-test-'));
const jsonlGz = join(tmp, 'test.jsonl.gz');
writeFileSync(jsonlGz, gzipSync(kaikkiLines.map((l) => JSON.stringify(l)).join('\n')));

execFileSync(process.execPath, [
  script,
  '--only', 'test',
  '--source', 'test=file://' + jsonlGz,
  '--out', join(tmp, 'dist'),
  '--catalog-dir', join(tmp, 'catalog'),
], { stdio: 'pipe' });

const idxBuf = readFileSync(join(tmp, 'dist', 'assets', 'test.idx'));
const dictBuf = gunzipSync(readFileSync(join(tmp, 'dist', 'assets', 'test.dict.dz')));

const index = new Map();  // headword -> {offset, size}
{
  let pos = 0;
  while (pos < idxBuf.length) {
    const nul = idxBuf.indexOf(0, pos);
    index.set(idxBuf.subarray(pos, nul).toString('utf8'), {
      offset: idxBuf.readUInt32BE(nul + 1),
      size: idxBuf.readUInt32BE(nul + 5),
    });
    pos = nul + 9;
  }
}
const body = (word) => {
  const loc = index.get(word);
  assert.ok(loc, `"${word}" missing from .idx`);
  assert.ok(loc.offset + loc.size <= dictBuf.length, `"${word}" points out of bounds`);
  return dictBuf.subarray(loc.offset, loc.offset + loc.size).toString('utf8');
};

test('pure form aliases the lemma definition at zero size cost', () => {
  assert.match(body('cats'), /small domesticated feline/);
  assert.doesNotMatch(body('cats'), /plural of cat/);
  assert.deepEqual(index.get('cats'), index.get('cat'));
});

test('form whose lemma is missing keeps its stub', () => {
  assert.match(body('mice'), /plural of mouse/);
});

test('mixed headword keeps its own senses and appends the lemma', () => {
  assert.match(body('found'), /to establish an organization/);
  assert.match(body('found'), /to locate something/);
});

test('alias chains resolve to the material end', () => {
  assert.match(body("runnin'"), /to move fast/);
  assert.deepEqual(index.get("runnin'"), index.get('run'));
});

test('alias lands on the case-merged lemma group', () => {
  assert.match(body('marched'), /the third month/);
  assert.match(body('marched'), /to walk in step/);
});

test('.ifo wordcount matches the .idx rows', () => {
  const ifo = readFileSync(join(tmp, 'dist', 'assets', 'test.ifo'), 'utf8');
  assert.equal(Number(ifo.match(/wordcount=(\d+)/)[1]), index.size);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
