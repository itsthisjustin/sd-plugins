import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const catalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));

// The on-device store (and the browser store) badge a plugin "Update available"
// whenever the catalog version differs from the installed plugin's
// manifest.json version. They must therefore agree for every catalog entry, or
// an up-to-date install shows a phantom update forever.
for (const entry of catalog.plugins) {
  test(`${entry.name}: catalog version matches manifest.json`, async () => {
    const manifest = JSON.parse(
      await readFile(new URL(`${entry.name}/manifest.json`, root), 'utf8'),
    );
    assert.equal(
      manifest.version,
      entry.version,
      `catalog.json lists ${entry.name} ${entry.version} but ${entry.name}/manifest.json is ${manifest.version}`,
    );
  });
}
