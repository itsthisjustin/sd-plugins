import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);

async function loadPlugin(path, globals = {}) {
  let render;
  const context = vm.createContext({
    CrossPoint: {
      registerPlugin(fn) { render = fn; },
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    Map,
    Date,
    Math,
    Array,
    String,
    Number,
    Object,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
    setTimeout,
    ...globals,
  });
  const source = await readFile(new URL(path, root), 'utf8');
  vm.runInContext(source, context, { filename: path });
  assert.equal(typeof render, 'function', path + ' should register a render function');
  return { render, context };
}

function fakeDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: id === 'lib-fulfill',
    onclick: null,
    onchange: null,
  }]));
  return {
    elements,
    getElementById(id) {
      assert.ok(elements[id], 'unexpected element lookup: ' + id);
      return elements[id];
    },
  };
}

function response({ status = 200, json, body = new ArrayBuffer(0), text = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return json; },
    async arrayBuffer() { return body; },
    async text() { return text; },
  };
}

class XmlElement {
  constructor(attrs, text = '') {
    this.attrs = attrs;
    this.textContent = text;
  }
  getAttribute(name) { return this.attrs[name] || null; }
}

class TinyXmlDocument {
  constructor(source) {
    this.source = source;
  }
  getElementsByTagName(name) {
    return name === 'parsererror' ? [] : [];
  }
  getElementsByTagNameNS(_namespace, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paired = new RegExp(
      '<(?:[\\w.-]+:)?' + escaped + '\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + escaped + '>',
      'gi');
    const selfClosing = new RegExp('<(?:[\\w.-]+:)?' + escaped + '\\b([^>]*)\\/\\s*>', 'gi');
    const out = [];
    let match;
    while ((match = paired.exec(this.source))) {
      out.push(new XmlElement(parseAttrs(match[1]), stripTags(match[2]).trim()));
    }
    while ((match = selfClosing.exec(this.source))) {
      out.push(new XmlElement(parseAttrs(match[1])));
    }
    return out;
  }
}

function parseAttrs(source) {
  const attrs = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) attrs[match[1]] = match[2] ?? match[3] ?? '';
  return attrs;
}

function stripTags(source) {
  return source.replace(/<[^>]+>/g, '');
}

class TinyDomParser {
  parseFromString(source) { return new TinyXmlDocument(source); }
}

test('all plugin manifests satisfy the manifest contract', async () => {
  const plugins = ['hello', 'organize-by-author', 'dictionaries'];
  for (const plugin of plugins) {
    const manifest = JSON.parse(await readFile(new URL(plugin + '/manifest.json', root), 'utf8'));
    assert.equal(typeof manifest.title, 'string', plugin + ' needs a title');
    assert.ok(manifest.title.trim(), plugin + ' needs a non-empty title');
    assert.ok(['files', 'settings'].includes(manifest.mount), plugin + ' has an invalid mount');
  }
});

test('hello renders its settings card', async () => {
  const { render } = await loadPlugin('hello/plugin.js');
  const container = { innerHTML: '' };
  render(container, { name: 'hello' });
  assert.match(container.innerHTML, /Hello from the SD card/);
  assert.match(container.innerHTML, /plugin\.js/);
});

test('organizer uses the creator file-as and moves a rights sidecar', async () => {
  const document = fakeDocument(['org-go', 'org-status']);
  const moves = [];
  const files = new Map([
    ['META-INF/container.xml',
      "<container><rootfiles><rootfile full-path='OPS/package.opf'/></rootfiles></container>"],
    ['OPS/package.opf',
      '<package xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<metadata><dc:title opf:file-as="Wrong Title">Title</dc:title>' +
      '<dc:creator id="author" opf:file-as="Le Guin, Ursula">Ursula K. Le Guin</dc:creator>' +
      '</metadata></package>'],
  ]);
  const JSZip = {
    async loadAsync() {
      return {
        file(path) {
          const content = files.get(path);
          return content === undefined ? null : { async: async () => content };
        },
      };
    },
  };
  async function fetch(url, options = {}) {
    if (url.startsWith('/api/files')) {
      return response({ json: [
        { name: 'Earthsea.epub', isDirectory: false, isEpub: true },
        { name: 'Earthsea.epub.rights', isDirectory: false, isEpub: false },
      ] });
    }
    if (url.startsWith('/download')) return response();
    if (url === '/mkdir') return response();
    if (url === '/move') {
      const form = new URLSearchParams(options.body);
      moves.push({ path: form.get('path'), dest: form.get('dest') });
      return response();
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('organize-by-author/plugin.js', {
    document,
    window: { location: { search: '?path=%2FBooks' } },
    DOMParser: TinyDomParser,
    JSZip,
    fetch,
  });
  const container = { innerHTML: '' };
  render(container, { name: 'organize-by-author' });
  await document.elements['org-go'].onclick();

  assert.deepEqual(moves, [
    { path: '/Books/Earthsea.epub', dest: '/Books/Le Guin, Ursula' },
    { path: '/Books/Earthsea.epub.rights', dest: '/Books/Le Guin, Ursula' },
  ]);
  assert.match(document.elements['org-status'].textContent, /Filed 1/);
});

test('dictionaries installs through redirects and sets the active dictionary without clobbering settings', async () => {
  const document = fakeDocument([
    'fd-status', 'fd-list', 'fd-active', 'fd-set-active', 'fd-search', 'fd-active-note',
    'fd-install-afr-deu', 'fd-install-eng-deu', 'fd-remove-afr-deu', 'fd-remove-eng-deu',
  ]);
  const index = { items: [
    { id: 'afr-deu', title: 'Afrikaans - German', author: '4k entries, 0.1 MB',
      base: 'https://github.com/example/releases/download/freedict/',
      files: ['afr-deu.ifo', 'afr-deu.idx', 'afr-deu.dict.dz'] },
    { id: 'eng-deu', title: 'English - German', author: '460k entries, 31.3 MB',
      base: 'https://github.com/example/releases/download/freedict/',
      files: ['eng-deu.ifo', 'eng-deu.idx', 'eng-deu.dict.dz'] },
  ] };
  const writes = [];
  const downloads = [];
  const api = {
    async relay(method, url) {
      assert.equal(method, 'HEAD');
      if (url.includes('github.com/example')) {
        return { status: 302, body: '', headers: [['Location', url.replace('github.com/example', 'objects.example.com')]] };
      }
      return { status: 200, body: '', headers: [] };
    },
    async writeFile(path, dataB64) {
      writes.push({ path, data: Buffer.from(dataB64, 'base64').toString('utf8') });
      return { ok: true, bytes: dataB64.length };
    },
    async fetchToSd(url, dest) {
      downloads.push({ url, dest });
      return { status: 200, bytes: 1000, complete: true };
    },
  };
  async function fetch(url) {
    if (url.startsWith('https://raw.githubusercontent.com/')) return response({ json: index });
    if (url.startsWith('/api/files')) return response({ json: [{ name: 'afr-deu', isDirectory: true }] });
    if (url.startsWith('/download?path=%2F.crosspoint%2Fsettings.json')) {
      return response({ text: '{"fontPointSize":12,"dictionaryName":"afr-deu"}' });
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('dictionaries/plugin.js', { document, fetch });
  await render({ innerHTML: '' }, api);

  assert.match(document.elements['fd-status'].textContent, /2 dictionaries available/);
  assert.match(document.elements['fd-active'].innerHTML, /afr-deu/);
  assert.equal(document.elements['fd-active'].value, 'afr-deu');
  assert.match(document.elements['fd-list'].innerHTML, /English - German/);

  // Install follows the release-asset redirect before streaming to SD.
  await document.elements['fd-install-eng-deu'].onclick();
  assert.equal(downloads.length, 3);
  assert.equal(downloads[0].url, 'https://objects.example.com/releases/download/freedict/eng-deu.ifo');
  assert.equal(downloads[0].dest, '/dictionaries/eng-deu/eng-deu.ifo');
  assert.equal(downloads[2].dest, '/dictionaries/eng-deu/eng-deu.dict.dz');

  // Setting the active dictionary rewrites settings.json but keeps other keys.
  document.elements['fd-active'].value = 'eng-deu';
  await document.elements['fd-set-active'].onclick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/.crosspoint/settings.json');
  const saved = JSON.parse(writes[0].data);
  assert.equal(saved.dictionaryName, 'eng-deu');
  assert.equal(saved.fontPointSize, 12);
});

