#!/usr/bin/env node
// Build the monolingual dictionary mirror + catalog for the dictionaries plugin.
//
// The reader's dictionary lookup wants a word explained in the language of the
// book (English word -> English definition), not translated — so the sources
// here are each language's own Wiktionary edition (machine-readable extracts
// from kaikki.org, CC BY-SA/GFDL) plus Webster's 1913 for English. No prebuilt
// StarDict files exist for most of these, so this script generates them:
//
//   <id>.ifo   <id>.idx (plain, uncompressed)   <id>.dict.dz (dictzip)
//
// matched to the reader's implementation (verified against Dictionary.cpp):
//   - .idx sorted with asciiCaseCmp: bytewise, ASCII tolower per byte
//   - headwords equal under that comparator share one merged definition
//     (otherwise only the first of "march"/"March" is ever reachable)
//   - headwords < 256 bytes, definitions < 64 KB, 32-bit offsets
//   - dictzip chunks decompress independently (raw deflate per chunk),
//     chunk table <= 8192 entries (~460 MB uncompressed ceiling)
//
// Outputs:
//   <out>/assets/            flat files to upload to the rolling GitHub
//                            release (tag: dictionaries)
//   dictionaries/catalog/    paged browse JSON committed to the repo
//                            (index.json + all-<p>.json)
//
// No npm dependencies; needs curl (and unzip for Webster) on PATH.
//
// Usage: node scripts/build-dictionaries.mjs [--out dist] [--only id,id]
//        node scripts/build-dictionaries.mjs --from-index   # catalog only

import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, openSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { createGunzip, createDeflateRaw, gunzipSync, crc32, constants as zconst } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const RELEASE_BASE = 'https://github.com/itsthisjustin/sd-plugins/releases/download/dictionaries/';
const CATALOG_DIR = new URL('../dictionaries/catalog/', import.meta.url).pathname;
const PAGE_SIZE = 8;

// One entry per language: its own Wiktionary edition, so definitions are in
// the same language as the headwords. Verified URLs; sizes are the .jsonl.gz.
const kaikki = (edition, dir) =>
  `https://kaikki.org/${edition}/${dir}/kaikki.org-dictionary-${dir.replace(/%20/g, '')}.jsonl.gz`;
const SOURCES = [
  { id: 'english', title: 'English', kind: 'kaikki', url: kaikki('dictionary', 'English') },
  { id: 'webster1913', title: 'English (Webster 1913)', kind: 'webster',
    url: 'https://s3.amazonaws.com/jsomers/dictionary.zip' },
  { id: 'spanish', title: 'Spanish', kind: 'kaikki', url: kaikki('eswiktionary', 'Espa%C3%B1ol') },
  { id: 'french', title: 'French', kind: 'kaikki', url: kaikki('frwiktionary', 'Fran%C3%A7ais') },
  { id: 'german', title: 'German', kind: 'kaikki', url: kaikki('dewiktionary', 'Deutsch') },
  { id: 'italian', title: 'Italian', kind: 'kaikki', url: kaikki('itwiktionary', 'Italiano') },
  { id: 'portuguese', title: 'Portuguese', kind: 'kaikki', url: kaikki('ptwiktionary', 'Portugu%C3%AAs') },
  { id: 'russian', title: 'Russian', kind: 'kaikki', url: kaikki('ruwiktionary', '%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9') },
  { id: 'dutch', title: 'Dutch', kind: 'kaikki', url: kaikki('nlwiktionary', 'Nederlands') },
  { id: 'polish', title: 'Polish', kind: 'kaikki', url: kaikki('plwiktionary', 'j%C4%99zyk%20polski') },
  { id: 'czech', title: 'Czech', kind: 'kaikki', url: kaikki('cswiktionary', '%C4%8De%C5%A1tina') },
  { id: 'greek', title: 'Greek', kind: 'kaikki', url: kaikki('elwiktionary', 'Greek') },
  { id: 'turkish', title: 'Turkish', kind: 'kaikki', url: kaikki('trwiktionary', 'T%C3%BCrk%C3%A7e') },
  { id: 'japanese', title: 'Japanese', kind: 'kaikki', url: kaikki('jawiktionary', '%E6%97%A5%E6%9C%AC%E8%AA%9E') },
  { id: 'korean', title: 'Korean', kind: 'kaikki', url: kaikki('kowiktionary', '%ED%95%9C%EA%B5%AD%EC%96%B4') },
  { id: 'chinese', title: 'Chinese', kind: 'kaikki', url: kaikki('zhwiktionary', '%E6%BC%A2%E8%AA%9E') },
  { id: 'vietnamese', title: 'Vietnamese', kind: 'kaikki', url: kaikki('viwiktionary', 'Ti%E1%BA%BFng%20Vi%E1%BB%87t') },
  { id: 'thai', title: 'Thai', kind: 'kaikki', url: kaikki('thwiktionary', '%E0%B9%84%E0%B8%97%E0%B8%A2') },
  { id: 'indonesian', title: 'Indonesian', kind: 'kaikki', url: kaikki('idwiktionary', 'Bahasa%20Indonesia') },
  { id: 'malay', title: 'Malay', kind: 'kaikki', url: kaikki('mswiktionary', 'Bahasa%20Melayu') },
  { id: 'kurdish', title: 'Kurdish (Kurmanji)', kind: 'kaikki', url: kaikki('kuwiktionary', 'Kurmanc%C3%AE') },
];

const MAX_HEADWORD_BYTES = 200;   // reader's word buffer is 256 bytes
const MAX_DEFINITION_BYTES = 60000;  // reader caps definitions at 64 KB
const DICTZIP_CHUNK = 58315;      // uncompressed bytes per chunk (dictzip default)
const MAX_CHUNKS = 8192;          // reader's chunk-table cap

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = flag('out', 'dist');
const ONLY = (flag('only', '') || '').split(',').filter(Boolean);
const FROM_INDEX = args.includes('--from-index');

function curl(url, dest) {
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '5', '-o', dest, url], { stdio: 'inherit' });
}

// --- StarDict output --------------------------------------------------------

// The reader's comparator, mirrored: ASCII tolower per byte, bytewise.
function foldKey(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b >= 0x41 && b <= 0x5a) out[i] = b + 32;
  }
  return out;
}

// Valid gzip AND random-access-decompressible: one deflate stream with a
// Z_FULL_FLUSH at every chunk boundary (each chunk starts with reset history,
// so the reader can inflate any chunk independently), plus the dictzip RA
// chunk table in the gzip FEXTRA field.
async function dictzip(dictBuf, dest) {
  const chunkCount = Math.ceil(dictBuf.length / DICTZIP_CHUNK) || 1;
  if (chunkCount > MAX_CHUNKS) {
    throw new Error(`dict is ${dictBuf.length} bytes — over the reader's ${MAX_CHUNKS * DICTZIP_CHUNK} byte dictzip ceiling`);
  }
  const z = createDeflateRaw({ level: 9 });
  const collected = [];
  let collectedBytes = 0;
  z.on('data', (d) => { collected.push(d); collectedBytes += d.length; });
  const sizes = [];
  let prevEnd = 0;
  for (let i = 0; i < chunkCount; i++) {
    z.write(dictBuf.subarray(i * DICTZIP_CHUNK, (i + 1) * DICTZIP_CHUNK));
    if (i < chunkCount - 1) {
      await new Promise((resolve) => z.flush(zconst.Z_FULL_FLUSH, resolve));
    } else {
      // Wait for the readable side to end: z.end()'s callback fires before the
      // final compressed bytes are emitted.
      await new Promise((resolve, reject) => { z.once('error', reject); z.once('end', resolve); z.end(); });
    }
    const size = collectedBytes - prevEnd;
    if (size > 0xffff) throw new Error('compressed chunk over 64 KB');
    sizes.push(size);
    prevEnd = collectedBytes;
  }
  const chunks = collected;
  const subLen = 6 + chunkCount * 2;
  const extra = Buffer.alloc(4 + subLen);
  extra.write('RA', 0, 'ascii');
  extra.writeUInt16LE(subLen, 2);
  extra.writeUInt16LE(1, 4);              // version
  extra.writeUInt16LE(DICTZIP_CHUNK, 6);  // uncompressed chunk length
  extra.writeUInt16LE(chunkCount, 8);
  sizes.forEach((s, i) => extra.writeUInt16LE(s, 10 + i * 2));
  const header = Buffer.alloc(12);
  header[0] = 0x1f; header[1] = 0x8b;     // gzip magic
  header[2] = 8;                          // deflate
  header[3] = 0x04;                       // FEXTRA
  header[9] = 0xff;                       // OS: unknown
  header.writeUInt16LE(extra.length, 10);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(dictBuf) >>> 0, 0);
  trailer.writeUInt32LE(dictBuf.length >>> 0, 4);
  writeFileSync(dest, Buffer.concat([header, extra, ...chunks, trailer]));
}

// entries: Map<headword, blockText>. Writes <id>.ifo/.idx/.dict.dz into dir
// and returns catalog metadata.
async function writeStardict(dir, id, title, entries) {
  // Group headwords that the reader's case-insensitive comparator cannot tell
  // apart; each gets its own .idx row pointing at the shared merged text.
  const groups = new Map();
  for (const [word, text] of entries) {
    const wordBuf = Buffer.from(word, 'utf8');
    if (wordBuf.length === 0 || wordBuf.length > MAX_HEADWORD_BYTES || wordBuf.includes(0)) continue;
    const key = foldKey(wordBuf).toString('latin1');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { words: [], texts: [] }));
    g.words.push(wordBuf);
    g.texts.push(text);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1')));

  const dictParts = [];
  const idxParts = [];
  let offset = 0;
  let wordCount = 0;
  for (const key of keys) {
    const g = groups.get(key);
    let body = Buffer.from(g.texts.join('\n\n'), 'utf8');
    if (body.length > MAX_DEFINITION_BYTES) body = truncateUtf8(body, MAX_DEFINITION_BYTES);
    dictParts.push(body);
    for (const wordBuf of g.words) {
      const row = Buffer.alloc(wordBuf.length + 9);
      wordBuf.copy(row);
      row.writeUInt32BE(offset, wordBuf.length + 1);
      row.writeUInt32BE(body.length, wordBuf.length + 5);
      idxParts.push(row);
      wordCount++;
    }
    offset += body.length;
  }
  if (offset > 0xffffffff) throw new Error('dict over 4 GB (32-bit offsets)');

  const dictBuf = Buffer.concat(dictParts);
  const idxBuf = Buffer.concat(idxParts);
  await dictzip(dictBuf, join(dir, id + '.dict.dz'));
  writeFileSync(join(dir, id + '.idx'), idxBuf);
  writeFileSync(join(dir, id + '.ifo'),
    "StarDict's dict ifo file\nversion=2.4.2\n" +
    `bookname=${title} (Wiktionary)\nwordcount=${wordCount}\nidxfilesize=${idxBuf.length}\n` +
    'sametypesequence=m\n');

  // Verify what was written: the .dict.dz must gunzip back to the source text
  // (dictzip is valid gzip), and the .idx must be sorted for the reader's
  // binary search.
  if (!gunzipSync(readFileSync(join(dir, id + '.dict.dz'))).equals(dictBuf)) {
    throw new Error('dictzip round-trip mismatch');
  }
  verifyIdxSorted(idxBuf, id);
  return { words: wordCount, dictBytes: dictBuf.length };
}

function truncateUtf8(buf, max) {
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;  // don't split a code point
  return buf.subarray(0, end);
}

function verifyIdxSorted(idxBuf, id) {
  let pos = 0;
  let prev = null;
  while (pos < idxBuf.length) {
    const nul = idxBuf.indexOf(0, pos);
    const key = foldKey(idxBuf.subarray(pos, nul));
    if (prev && Buffer.compare(prev, key) > 0) {
      throw new Error(`${id}.idx not sorted at byte ${pos}`);
    }
    prev = key;
    pos = nul + 9;
  }
}

// --- kaikki (Wiktionary) source --------------------------------------------
// One JSONL line per word+part-of-speech: {word, pos, senses:[{glosses:[...]}]}.
// Keep the glosses (the numbered meanings); everything else — etymology,
// examples, translations — is dropped to keep dictionaries reader-sized.
async function buildKaikki(src, tmp) {
  const jsonl = join(tmp, src.id + '.jsonl.gz');
  curl(src.url, jsonl);

  const blocks = new Map();  // word -> [ "word (pos)\n1. ...\n2. ...", ... ]
  const rl = createInterface({ input: createReadStream(jsonl).pipe(createGunzip()), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    lines++;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (!e.word || !Array.isArray(e.senses)) continue;
    const glosses = [];
    for (const sense of e.senses) {
      const g = Array.isArray(sense.glosses) ? sense.glosses.filter(Boolean).join('; ') : '';
      if (g) glosses.push(g);
      if (glosses.length >= 30) break;
    }
    if (!glosses.length) continue;
    const header = e.word + (e.pos ? ` (${e.pos})` : '');
    const text = header + '\n' + glosses.map((g, i) => `${i + 1}. ${g}`).join('\n');
    let list = blocks.get(e.word);
    if (!list) blocks.set(e.word, (list = []));
    if (list.length < 8) list.push(text);  // cap runaway homographs
  }
  rmSync(jsonl, { force: true });
  console.log(`  ${lines} lines -> ${blocks.size} headwords`);

  const entries = new Map();
  for (const [word, list] of blocks) entries.set(word, list.join('\n\n'));
  return writeStardict(join(OUT, 'assets'), src.id, src.title, entries);
}

// --- Webster 1913 (prebuilt StarDict) --------------------------------------
async function buildWebster(src, tmp) {
  const zip = join(tmp, 'webster.zip');
  const dir = join(tmp, 'webster');
  curl(src.url, zip);
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const found = {};
  const tarballs = [];
  (function walk(d) {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name.startsWith('._') || name.name === '__MACOSX') continue;  // AppleDouble junk
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.tar\.(bz2|gz|xz)$/.test(name.name)) tarballs.push(p);
      else if (name.name.endsWith('.ifo')) found.ifo = p;
      else if (name.name.endsWith('.idx')) found.idx = p;
      else if (name.name.endsWith('.idx.gz')) found.idxgz = p;
      else if (name.name.endsWith('.dict.dz')) found.dz = p;
    }
  })(dir);
  // The jsomers zip nests the actual StarDict files inside a tarball.
  if (!found.ifo && tarballs.length) {
    for (const t of tarballs) execFileSync('tar', ['-xf', t, '-C', dir]);
    for (const t of tarballs) rmSync(t, { force: true });
    (function walk(d) {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        if (name.name.startsWith('._')) continue;
        const p = join(d, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith('.ifo')) found.ifo = p;
        else if (name.name.endsWith('.idx')) found.idx = p;
        else if (name.name.endsWith('.idx.gz')) found.idxgz = p;
        else if (name.name.endsWith('.dict.dz')) found.dz = p;
      }
    })(dir);
  }
  if (!found.ifo || !(found.idx || found.idxgz) || !found.dz) throw new Error('unexpected zip layout');
  const ifo = readFileSync(found.ifo, 'utf8').slice(0, 2048);
  if (/idxoffsetbits\s*=\s*64/.test(ifo)) throw new Error('64-bit offsets');
  const assets = join(OUT, 'assets');
  copyFileSync(found.ifo, join(assets, src.id + '.ifo'));
  copyFileSync(found.dz, join(assets, src.id + '.dict.dz'));
  if (found.idx) copyFileSync(found.idx, join(assets, src.id + '.idx'));
  else writeFileSync(join(assets, src.id + '.idx'), gunzipSync(readFileSync(found.idxgz)));
  rmSync(zip, { force: true });
  rmSync(dir, { recursive: true, force: true });
  const words = Number((ifo.match(/wordcount=(\d+)/) || [])[1]) || 0;
  return { words, dictBytes: 0 };
}

// --- main -------------------------------------------------------------------
const entries = [];
const failures = [];

if (FROM_INDEX) {
  entries.push(...JSON.parse(readFileSync(join(CATALOG_DIR, 'index.json'), 'utf8')).items);
  console.log(`Loaded ${entries.length} dictionaries from the existing index`);
} else {
  const tmp = join(tmpdir(), 'dict-build');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  const selected = ONLY.length ? SOURCES.filter((s) => ONLY.includes(s.id)) : SOURCES;
  for (const src of selected) {
    console.log(`\n== ${src.id} (${src.title})`);
    try {
      const stats = src.kind === 'webster' ? await buildWebster(src, tmp) : await buildKaikki(src, tmp);
      const files = [src.id + '.ifo', src.id + '.idx', src.id + '.dict.dz'];
      let bytes = 0;
      for (const f of files) bytes += statSync(join(OUT, 'assets', f)).size;
      const mb = bytes / (1024 * 1024);
      const k = stats.words >= 1000 ? Math.round(stats.words / 1000) + 'k' : String(stats.words);
      entries.push({
        id: src.id,
        title: src.title,
        author: `${k} entries, ${mb < 0.1 ? '0.1' : mb.toFixed(1)} MB`,
        base: RELEASE_BASE,
        files,
        bytes,
      });
      console.log(`  ok: ${stats.words} words, ${mb.toFixed(1)} MB on SD`);
    } catch (e) {
      console.error(`FAILED ${src.id}: ${e.message}`);
      failures.push(`${src.id}: ${e.message}`);
    }
  }
  // Partial runs (--only, or sources that failed) keep the previous catalog
  // entries for everything not rebuilt this time.
  try {
    const builtIds = new Set(entries.map((e) => e.id));
    for (const old of JSON.parse(readFileSync(join(CATALOG_DIR, 'index.json'), 'utf8')).items) {
      if (!builtIds.has(old.id)) entries.push(old);
    }
  } catch (e) {}
}

// Keep catalog order stable and English-first; the rest alphabetical.
entries.sort((a, b) => a.title.localeCompare(b.title, 'en'));
const engFirst = entries.filter((e) => e.id === 'english');
const rest = entries.filter((e) => e.id !== 'english');
const ordered = [...engFirst, ...rest];

mkdirSync(CATALOG_DIR, { recursive: true });
for (const name of readdirSync(CATALOG_DIR)) {
  if (name.endsWith('.json')) rmSync(join(CATALOG_DIR, name));
}
const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
for (let p = 1; p <= pageCount; p++) {
  const start = (p - 1) * PAGE_SIZE;
  // PAGE_SIZE items plus one lookahead: the firmware treats a full
  // page_size+1 response as "more pages exist".
  const slice = ordered.slice(start, start + PAGE_SIZE + 1).map(({ bytes, ...item }) => item);
  writeFileSync(join(CATALOG_DIR, `all-${p}.json`), JSON.stringify({ items: slice }));
}
writeFileSync(join(CATALOG_DIR, 'index.json'), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  items: ordered,
}, null, 1));

console.log(`\nDone: ${ordered.length} dictionaries over ${pageCount} pages, catalog in ${CATALOG_DIR}`);
if (failures.length) {
  console.error(`${failures.length} failed:\n  ` + failures.join('\n  '));
  process.exitCode = ONLY.length ? 1 : 0;  // full builds tolerate stragglers
}
