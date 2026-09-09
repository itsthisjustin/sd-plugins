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
  const plugins = ['hello', 'organize-by-author', 'protected-content', 'dictionaries', 'month-wallpaper'];
  for (const plugin of plugins) {
    const manifest = JSON.parse(await readFile(new URL(plugin + '/manifest.json', root), 'utf8'));
    assert.equal(typeof manifest.title, 'string', plugin + ' needs a title');
    assert.ok(manifest.title.trim(), plugin + ' needs a non-empty title');
    // mount is only meaningful for a plugin with a browser plugin.js; device-only
    // plugins omit it. Validate it only when present.
    if (manifest.mount !== undefined) {
      assert.ok(['files', 'settings'].includes(manifest.mount), plugin + ' has an invalid mount');
    }
  }
});

test('month-wallpaper device.json is a well-formed browse+download manifest', async () => {
  const raw = await readFile(new URL('month-wallpaper/device.json', root), 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') < 8192, 'device.json must stay under the 8 KB manifest cap');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.title, 'Month Wallpaper');
  assert.equal(manifest.config.file, '/.crosspoint/month-wallpaper.json');
  // Browse the hosted server's catalog, shaped by the config file.
  assert.equal(manifest.browse.format, 'json');
  assert.match(manifest.browse.url, /^https:\/\/[^/]+\/catalog\?/);
  assert.match(manifest.browse.url, /\bw=\{cfg\.width\}/);
  assert.match(manifest.browse.url, /\bcountry=\{cfg\.country\}/);
  assert.equal(manifest.browse.items, 'months');
  assert.equal(manifest.browse.fields.title, 'title');
  assert.equal(manifest.browse.fields.url, 'url');
  assert.ok(manifest.browse.page_size <= 16, 'page_size cannot exceed the firmware max of 16');
  // Download the selected month's BMP straight into the sleep folder.
  assert.equal(manifest.download.url, '{url}');
  assert.equal(manifest.download.dest_dir, '/sleep');
  assert.equal(manifest.download.filename, 'calendar.bmp');
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

async function protectedContentFixture(options = {}) {
  const writes = [];
  const downloads = [];
  const deletes = [];
  const fulfillmentOperations = [];
  const files = new Map();
  const relayCalls = [];
  const cryptoCalls = [];
  const confirmations = [];
  let savedCredential = '';
  let randomCounter = 0;
  let activationRedirected = false;
  const crypto = async (op, fields = {}) => {
    cryptoCalls.push({ op, fields });
    if (options.pauseCrypto) await options.pauseCrypto;
    const zeros = (length) => btoa(String.fromCharCode(...new Uint8Array(length)));
    if (op === 'random') return { data: Buffer.alloc(fields.len, ++randomCounter).toString('base64') };
    if (op === 'sha1') return { data: createHash('sha1').update(Buffer.from(fields.data, 'base64')).digest('base64') };
    if (op === 'keygen') return { public: 'cHVibGlj', private: 'cHJpdmF0ZQ==' };
    if (op === 'pubencrypt') return { data: zeros(128) };
    if (op === 'aesenc') return { data: zeros(16) };
    if (op === 'aesdec') return { data: 'cHJpdmF0ZQ==' };
    if (op === 'pkcs12') return { key: 'c2lnbmluZy1rZXk=', cert: 'c2lnbmluZy1jZXJ0' };
    if (op === 'sign') return { data: zeros(128) };
    throw new Error('unexpected crypto op: ' + op);
  };
  const relay = async (method, url, headers, requestBody) => {
    relayCalls.push({ method, url, body: requestBody });
    assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent'), false);
    let body;
    if (url.endsWith('/ActivationServiceInfo') && !activationRedirected) {
      activationRedirected = true;
      return {
        status: 302,
        body: '',
        headers: [['location', '/adept/ActivationServiceInfo2']],
      };
    } else if ((url.endsWith('/ActivationServiceInfo2') || url.endsWith('/ActivationServiceInfo'))) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:authURL>https://adeactivate.adobe.com/adept</adept:authURL>' +
        '<adept:userInfoURL>https://adeactivate.adobe.com/user</adept:userInfoURL>' +
        '<adept:certificate>Y2VydA==</adept:certificate></adept:service>';
    } else if (url.endsWith('/AuthenticationServiceInfo')) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:certificate>YXV0aC1jZXJ0</adept:certificate></adept:service>';
    } else if (url.endsWith('/SignInDirect')) {
      if (options.failSignIn) throw new Error('sign-in transport failed');
      body = '<adept:credentials xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:user>urn:uuid:user</adept:user><adept:pkcs12>cDEy</adept:pkcs12>' +
        '<adept:licenseCertificate>bGljLWNlcnQ=</adept:licenseCertificate>' +
        '<adept:encryptedPrivateLicenseKey>ZW5j</adept:encryptedPrivateLicenseKey>' +
        '</adept:credentials>';
    } else if (url.endsWith('/Activate')) {
      if (options.activationFailure === 'lost reply') throw new Error('lost reply');
      if (options.activationFailure === 'reject') return { status: 400, body: '<adept:error data="E_ACT_TOO_MANY_ACTIVATIONS"/>', headers: [] };
      if (options.activationFailure === 'redirect') return { status: 307, body: '', headers: [['Location', url]] };
      body = '<adept:activationToken xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:device>urn:uuid:device</adept:device></adept:activationToken>';
    } else if (url.includes('/LicenseServiceInfo?')) {
      assert.match(url, /licenseURL=https%3A%2F%2Flicense\.example\.overdrive\.com%2Fservice/);
      body = '<adept:licenseServiceInfo xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:certificate>bGljZW5zZS1jZXJ0</adept:certificate></adept:licenseServiceInfo>';
    } else if (url.endsWith('/Fulfill')) {
      body = '<adept:fulfillmentResult xmlns:adept="http://ns.adobe.com/adept" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><adept:resourceItemInfo>' +
        '<adept:src>https://download.example.overdrive.com/book.epub</adept:src>' +
        '<adept:licenseToken><adept:licenseURL>' +
        'https://license.example.overdrive.com/service</adept:licenseURL>' +
        '<adept:encryptedKey>a2V5</adept:encryptedKey></adept:licenseToken>' +
        '</adept:resourceItemInfo><dc:title>Test Book</dc:title></adept:fulfillmentResult>';
    } else if (url.endsWith('/Auth') || url.endsWith('/InitLicenseService')) {
      body = '<adept:ok xmlns:adept="http://ns.adobe.com/adept"/>';
    } else {
      throw new Error('unexpected relay: ' + method + ' ' + url);
    }
    return { status: 200, body, headers: [] };
  };
  const api = {
    crypto,
    relay,
    async writeFile(path, data) {
      writes.push({ path, data });
      if (options.failWrite && options.failWrite(path, data)) {
        if (options.truncateCredential && path === '/.crosspoint/content.key') {
          savedCredential = 'truncated';
          files.set(path, savedCredential);
        }
        throw new Error('SD write failed');
      }
      files.set(path, Buffer.from(data, 'base64').toString('utf8'));
      if (path === '/.crosspoint/content.key') {
        savedCredential = Buffer.from(data, 'base64').toString('utf8');
      } else if (path.endsWith('.rights')) {
        fulfillmentOperations.push('rights');
      }
      return { ok: true, bytes: data.length };
    },
    async fetchToSd(url, dest, headers) {
      downloads.push({ url, dest, headers });
      fulfillmentOperations.push('download');
      return { status: 200, bytes: 1234 };
    },
  };
  const acsm =
    '<adept:fulfillmentToken xmlns:adept="http://ns.adobe.com/adept">' +
    '<adept:operatorURL>https://fulfill.example.overdrive.com/acs/</adept:operatorURL>' +
    '<adept:hmac>aG1hYw==</adept:hmac></adept:fulfillmentToken>';
  async function fetch(url, request = {}) {
    if (url === '/api/status') return response({ json: { hardwareMac: options.mac === undefined ? '02:11:22:33:44:55' : options.mac } });
    if (url === '/delete') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
      deletes.push(new URLSearchParams(request.body).get('path'));
      return response();
    }
    if (url.startsWith('/api/files')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (path === '/.crosspoint') {
        return response({ json: [...files.keys()].filter((path) => path.startsWith('/.crosspoint/')).map((path) => ({ name: path.split('/').pop(), isDirectory: false })) });
      }
      if (path === '/Loans') {
        return response({ json: [{ name: 'library-loan.acsm', isDirectory: false }] });
      }
      return response({ json: [{ name: 'Test Book.epub', isDirectory: false }] });
    }
    if (url.startsWith('/download')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (files.has(path)) return response({ text: files.get(path) });
      if (path === '/Loans/library-loan.acsm') return response({ text: acsm });
    }
    throw new Error('unexpected fetch: ' + url);
  }

  async function loadPage() {
    const document = fakeDocument([
      'lib-account-state', 'lib-user', 'lib-pass', 'lib-go', 'lib-acsm',
      'lib-refresh', 'lib-fulfill', 'lib-status',
    ]);
    const { render } = await loadPlugin('protected-content/plugin.js', {
      document, window: {
        location: { search: '?path=%2FLoans' },
        confirm(message) { confirmations.push(message); return options.confirmRetry === true; },
      }, fetch,
    });
    await render({ innerHTML: '' }, api);
    return document;
  }
  const document = await loadPage();
  async function activate(doc = document, user = 'reader@example.com', pass = 'secret') {
    doc.elements['lib-user'].value = user;
    doc.elements['lib-pass'].value = pass;
    await doc.elements['lib-go'].onclick();
  }
  return { document, loadPage, activate, api, fetch, files, writes, downloads, deletes, fulfillmentOperations,
    relayCalls, cryptoCalls, confirmations, credential: () => savedCredential,
    activationCount: () => relayCalls.filter(({ url }) => url.endsWith('/Activate')).length };
}

test('protected content restores content.key, writes rights first, and fulfills without rewriting credentials', async () => {
  const f = await protectedContentFixture();
  const { document, api, fetch, writes, downloads, deletes, fulfillmentOperations } = f;
  assert.match(document.elements['lib-account-state'].textContent, /No content account/);
  assert.equal(document.elements['lib-acsm'].value, 'library-loan.acsm');
  document.elements['lib-user'].value = 'reader@example.com';
  document.elements['lib-pass'].value = 'secret';
  await document.elements['lib-go'].onclick();

  assert.equal(f.activationCount(), 1);
  assert.equal(document.elements['lib-pass'].value, '');
  assert.equal(writes.at(-1).path, '/.crosspoint/content.key');
  assert.equal(writes[0].path, '/.crosspoint/content-activation.json');
  assert.match(f.credential(), /^FREEINK-CONTENT-KEY 1/m);
  assert.match(f.credential(), /^protectedContentState: /m);
  const credentialAfterActivation = f.credential();

  // Simulate reopening the File Manager: content.key should restore the
  // signing session, and the uploaded ACSM should be ready without pasting it.
  const reloadedDocument = fakeDocument([
    'lib-account-state', 'lib-user', 'lib-pass', 'lib-go', 'lib-acsm',
    'lib-refresh', 'lib-fulfill', 'lib-status',
  ]);
  const { render: renderReloaded } = await loadPlugin('protected-content/plugin.js', {
    document: reloadedDocument,
    window: { location: { search: '?path=%2FLoans' } },
    fetch,
  });
  await renderReloaded({ innerHTML: '' }, api);
  assert.match(reloadedDocument.elements['lib-account-state'].textContent, /Connected as reader@example\.com/);
  assert.equal(reloadedDocument.elements['lib-acsm'].value, 'library-loan.acsm');
  assert.equal(reloadedDocument.elements['lib-fulfill'].disabled, false);
  await reloadedDocument.elements['lib-fulfill'].onclick();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'http://download.example.overdrive.com/book.epub');
  assert.equal(downloads[0].dest, '/Loans/Test Book.epub');
  assert.equal(Object.keys(downloads[0].headers).length, 0);
  assert.equal(writes.at(-1).path, '/Loans/Test Book.epub.rights');
  assert.equal(writes.filter(({path}) => path === '/.crosspoint/content.key').length, 1);
  assert.equal(f.activationCount(), 1);
  assert.deepEqual(fulfillmentOperations, ['rights', 'download']);
  assert.equal(f.credential(), credentialAfterActivation);
  assert.deepEqual(deletes, ['/Loans/library-loan.acsm']);
  assert.match(reloadedDocument.elements['lib-status'].textContent, /Fetched “Test Book”/);
});

const activationPath = '/.crosspoint/content-activation.json';
const credentialPath = '/.crosspoint/content.key';
function checkpoint(f) { return JSON.parse(f.files.get(activationPath)); }

const flatCredential = 'FREEINK-CONTENT-KEY 1\n' + Object.entries({
  username: 'reader@example.com', devicesalt: 'c2FsdA==',
  serial: 'saved-serial', fingerprint: 'saved-fingerprint',
  userUuid: 'urn:uuid:saved-user', deviceUuid: 'urn:uuid:saved-device',
  activationURL: 'https://adeactivate.adobe.com/adept',
  authenticationCertificate: 'YXV0aC1jZXJ0', licenseCertificate: 'bGljLWNlcnQ=',
  privateLicenseKey: 'cHJpdmF0ZQ==',
  signingKeyPkcs8: 'c2F2ZWQtc2lnbmluZy1rZXk=', signingCertDer: 'c2F2ZWQtY2VydA==',
}).map(([key, value]) => `${key}: ${value}\n`).join('');

test('flat signing credentials restore and fulfill without signing in, activating, or rewriting the file', async () => {
  const f = await protectedContentFixture({ mac: '' });
  f.files.set(credentialPath, flatCredential);
  const page = await f.loadPage();
  assert.match(page.elements['lib-account-state'].textContent, /Connected as reader@example.com/);
  assert.equal(page.elements['lib-fulfill'].disabled, false);
  await f.activate(page, 'READER@example.com', '');
  assert.equal(f.relayCalls.length, 0);
  assert.equal(f.cryptoCalls.length, 0);
  await page.elements['lib-fulfill'].onclick();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.activationCount(), 0);
  assert.equal(f.relayCalls.some(({ url }) => url.endsWith('/SignInDirect')), false);
  assert.ok(f.cryptoCalls.filter(({ op }) => op === 'sign').every(
    ({ fields }) => fields.private === 'c2F2ZWQtc2lnbmluZy1rZXk='));
  assert.match(f.relayCalls.find(({ url }) => url.endsWith('/Fulfill')).body, /urn:uuid:saved-device/);
  assert.equal(f.files.get(credentialPath), flatCredential);
  assert.equal(f.writes.some(({ path }) => path === credentialPath || path === activationPath), false);
});

for (const credential of [
  flatCredential.replace(/^signingCertDer:.*\n/m, ''),
  flatCredential + 'protectedContentState: not-json\n',
]) {
  test('damaged saved signing credentials do not suggest another activation', async () => {
    const f = await protectedContentFixture();
    f.files.set(credentialPath, credential);
    const page = await f.loadPage();
    assert.match(page.elements['lib-account-state'].textContent, /Could not restore/);
    assert.equal(page.elements['lib-fulfill'].disabled, true);
    await f.activate(page);
    assert.equal(f.activationCount(), 0);
    assert.equal(f.files.get(credentialPath), credential);
  });
}

test('activation serial is MAC-derived and existing activation is reused without a password', async () => {
  const a = await protectedContentFixture();
  const b = await protectedContentFixture({ mac: '02:11:22:33:44:66' });
  await a.activate();
  await b.activate();
  assert.notEqual(checkpoint(a).session.device.serial, checkpoint(b).session.device.serial);
  assert.equal(checkpoint(a).session.device.serial,
    createHash('sha1').update('crosspoint:protected-content:v1:02:11:22:33:44:55').digest('hex'));
  assert.equal(a.cryptoCalls.some(({ op, fields }) => op === 'random' && fields.len === 20), false);
  const cryptoCount = a.cryptoCalls.length;
  const page = await a.loadPage();
  await a.activate(page, 'READER@example.com', '');
  assert.equal(a.activationCount(), 1);
  assert.equal(a.cryptoCalls.length, cryptoCount);
  assert.match(page.elements['lib-status'].textContent, /already activated/);
});

for (const reload of [false, true]) for (const truncateCredential of [false, true]) {
  test(`credential save retry avoids activation (reload=${reload}, truncated=${truncateCredential})`, async () => {
    const options = { truncateCredential, failWrite: (path) => path === credentialPath };
    const f = await protectedContentFixture(options);
    await f.activate();
    assert.equal(f.activationCount(), 1);
    const saved = checkpoint(f).session;
    assert.equal(saved.act.deviceUuid, 'urn:uuid:device');
    options.failWrite = null;
    const page = reload ? await f.loadPage() : f.document;
    await f.activate(page, 'reader@example.com', '');
    assert.equal(f.activationCount(), 1);
    assert.equal(checkpoint(f).session.device.fingerprint, saved.device.fingerprint);
    assert.match(f.credential(), /^FREEINK-CONTENT-KEY 1/);
    assert.match(page.elements['lib-status'].textContent, /Activation saved/);
  });
}

for (const failedWrite of [1, 2, 3]) {
  test(`checkpoint write ${failedWrite} failure does not replay a successful activation`, async () => {
    let writes = 0;
    const options = { failWrite: (path) => path === activationPath && ++writes === failedWrite };
    const f = await protectedContentFixture(options);
    await f.activate();
    assert.equal(f.activationCount(), failedWrite === 3 ? 1 : 0);
    options.failWrite = null;
    await f.activate();
    assert.equal(f.activationCount(), 1);
    assert.match(f.credential(), /^FREEINK-CONTENT-KEY 1/);
  });
}

test('sign-in failure and page reload retain the MAC identity and random salt', async () => {
  const options = { failSignIn: true };
  const f = await protectedContentFixture(options);
  await f.activate();
  assert.equal(f.activationCount(), 0);
  const identity = checkpoint(f).session;
  options.failSignIn = false;
  await f.activate(await f.loadPage());
  assert.equal(f.activationCount(), 1);
  assert.deepEqual(checkpoint(f).session.device, identity.device);
  assert.equal(checkpoint(f).session.salt, identity.salt);
});

for (const activationFailure of ['lost reply', 'redirect']) {
  test(`${activationFailure} stops activation replay across retries and reloads`, async () => {
    const options = { activationFailure };
    const f = await protectedContentFixture(options);
    await f.activate();
    assert.equal(f.activationCount(), 1);
    options.activationFailure = null;
    await f.activate();
    const page = await f.loadPage();
    await f.activate(page);
    assert.equal(f.activationCount(), 1);
    assert.match(page.elements['lib-status'].textContent, /no saved reply/);
  });
}

test('pending activation explains recovery on reload and cancellation leaves saved progress unchanged', async () => {
  const f = await protectedContentFixture({ activationFailure: 'lost reply' });
  await f.activate();
  const saved = f.files.get(activationPath);
  assert.equal(checkpoint(f).lastError, 'lost reply');
  const page = await f.loadPage();
  assert.equal(page.elements['lib-go'].textContent, 'Retry activation');
  assert.equal(page.elements['lib-user'].value, 'reader@example.com');
  assert.match(page.elements['lib-account-state'].textContent, /Last error: lost reply/);
  await f.activate(page, 'reader@example.com', '');
  assert.match(f.confirmations[0], /another activation slot/);
  assert.equal(f.activationCount(), 1);
  assert.equal(f.files.get(activationPath), saved);
});

test('confirmed retry sends one activation with the saved identity and keys, without signing in again', async () => {
  const options = { activationFailure: 'lost reply' };
  const f = await protectedContentFixture(options);
  await f.activate();
  const original = checkpoint(f).session;
  const signIns = f.relayCalls.filter(({ url }) => url.endsWith('/SignInDirect')).length;
  const keygens = f.cryptoCalls.filter(({ op }) => op === 'keygen').length;
  options.activationFailure = null;
  options.confirmRetry = true;
  await f.activate(await f.loadPage(), 'reader@example.com', '');
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.activationCount(), 2);
  const recovered = checkpoint(f).session;
  assert.deepEqual(recovered.device, original.device);
  assert.equal(recovered.salt, original.salt);
  assert.equal(recovered.act.signingKey, original.act.signingKey);
  assert.equal(recovered.act.privateLicenseKey, original.act.privateLicenseKey);
  assert.equal(f.relayCalls.filter(({ url }) => url.endsWith('/SignInDirect')).length, signIns);
  assert.equal(f.cryptoCalls.filter(({ op }) => op === 'keygen').length, keygens);
  assert.equal(checkpoint(f).lastError, undefined);
  assert.match(f.credential(), /deviceUuid: urn:uuid:device/);
  await f.activate(await f.loadPage(), 'reader@example.com', '');
  assert.equal(f.activationCount(), 2);
  assert.equal(f.confirmations.length, 1);
});

test('a failed recovery request requires fresh confirmation and cannot be duplicated concurrently', async () => {
  const options = { activationFailure: 'lost reply', confirmRetry: true };
  const f = await protectedContentFixture(options);
  await f.activate();
  const page = await f.loadPage();
  let resume;
  options.pauseCrypto = new Promise(resolve => { resume = resolve; });
  const first = f.activate(page, 'reader@example.com', '');
  const duplicate = f.activate(page, 'reader@example.com', '');
  resume();
  await Promise.all([first, duplicate]);
  assert.equal(f.activationCount(), 2);
  assert.equal(f.confirmations.length, 1);
  options.confirmRetry = false;
  await f.activate(page, 'reader@example.com', '');
  assert.equal(f.activationCount(), 2);
  assert.equal(f.confirmations.length, 2);
});

test('a failed recovery checkpoint write keeps the original attempt pending', async () => {
  const options = { activationFailure: 'lost reply', confirmRetry: true };
  const f = await protectedContentFixture(options);
  await f.activate();
  options.activationFailure = null;
  options.failWrite = path => path === activationPath;
  const page = await f.loadPage();
  await f.activate(page, 'reader@example.com', '');
  assert.equal(f.activationCount(), 1);
  assert.equal(checkpoint(f).phase, 'requested');
  options.failWrite = null;
  options.confirmRetry = false;
  await f.activate(page, 'reader@example.com', '');
  assert.equal(f.activationCount(), 1);
  assert.equal(f.confirmations.length, 2);
});

test('checkpoints from older versions remain recoverable when the original error is missing', async () => {
  const options = { activationFailure: 'lost reply' };
  const f = await protectedContentFixture(options);
  await f.activate();
  const old = checkpoint(f);
  delete old.lastError;
  f.files.set(activationPath, JSON.stringify(old));
  const page = await f.loadPage();
  assert.match(page.elements['lib-account-state'].textContent, /original error was not saved/);
  options.activationFailure = null;
  options.confirmRetry = true;
  await f.activate(page, 'reader@example.com', '');
  assert.equal(f.activationCount(), 2);
  assert.match(f.credential(), /deviceUuid: urn:uuid:device/);
});

test('pending recovery cannot send its credentials for a different account', async () => {
  const f = await protectedContentFixture({ activationFailure: 'lost reply', confirmRetry: true });
  await f.activate();
  const page = await f.loadPage();
  await f.activate(page, 'other@example.com');
  assert.equal(f.activationCount(), 1);
  assert.equal(f.confirmations.length, 0);
  assert.match(page.elements['lib-status'].textContent, /Retry that account first/);
});

test('a rejected recovery returns to ordinary activation and preserves the service error', async () => {
  const options = { activationFailure: 'lost reply', confirmRetry: true };
  const f = await protectedContentFixture(options);
  await f.activate();
  options.activationFailure = 'reject';
  const page = await f.loadPage();
  await f.activate(page, 'reader@example.com', '');
  assert.equal(f.activationCount(), 2);
  assert.equal(checkpoint(f).phase, 'identity');
  assert.equal(checkpoint(f).lastError, 'E_ACT_TOO_MANY_ACTIVATIONS');
  assert.equal(page.elements['lib-go'].textContent, 'Activate device');
});

test('pending recovery with missing signing credentials is blocked before confirmation or activation', async () => {
  const f = await protectedContentFixture({ activationFailure: 'lost reply', confirmRetry: true });
  await f.activate();
  const damaged = checkpoint(f);
  delete damaged.session.act.signingKey;
  f.files.set(activationPath, JSON.stringify(damaged));
  const page = await f.loadPage();
  assert.match(page.elements['lib-account-state'].textContent, /Saved activation progress is damaged/);
  await f.activate(page);
  assert.equal(f.activationCount(), 1);
  assert.equal(f.confirmations.length, 0);
});

test('explicit service rejection permits retry using the same identity', async () => {
  const options = { activationFailure: 'reject' };
  const f = await protectedContentFixture(options);
  await f.activate();
  const identity = checkpoint(f).session.device;
  options.activationFailure = null;
  await f.activate(await f.loadPage());
  assert.equal(f.activationCount(), 2);
  assert.deepEqual(checkpoint(f).session.device, identity);
});

test('duplicate handler calls cannot start concurrent activation sequences', async () => {
  let resume;
  const options = { pauseCrypto: new Promise((resolve) => { resume = resolve; }) };
  const f = await protectedContentFixture(options);
  const first = f.activate();
  const duplicate = f.document.elements['lib-go'].onclick();
  resume();
  await Promise.all([first, duplicate]);
  assert.equal(f.activationCount(), 1);
});

test('legacy credential upgrade preserves its identity', async () => {
  const f = await protectedContentFixture();
  f.files.set(credentialPath, 'FREEINK-CONTENT-KEY 1\nusername: reader@example.com\n' +
    'serial: legacy-serial\nfingerprint: legacy-fingerprint\ndevicesalt: bGVnYWN5\n');
  await f.activate(await f.loadPage());
  assert.equal(f.activationCount(), 1);
  assert.equal(checkpoint(f).session.device.serial, 'legacy-serial');
  assert.equal(checkpoint(f).session.device.fingerprint, 'legacy-fingerprint');
  assert.equal(checkpoint(f).session.salt, 'bGVnYWN5');
});

for (const mac of ['', 'not-a-mac']) {
  test(`missing or invalid hardware identity blocks activation: ${mac}`, async () => {
    const f = await protectedContentFixture({ mac });
    await f.activate();
    assert.equal(f.activationCount(), 0);
    assert.equal(f.cryptoCalls.length, 0);
    assert.match(f.document.elements['lib-status'].textContent, /factory MAC/);
  });
}

test('damaged checkpoint is not discarded to create a new activation', async () => {
  const f = await protectedContentFixture();
  f.files.set(activationPath, '{"version":1}');
  await f.activate(await f.loadPage());
  assert.equal(f.activationCount(), 0);
  assert.equal(f.files.get(activationPath), '{"version":1}');
});

test('account replacement keeps the existing device identity', async () => {
  const f = await protectedContentFixture();
  await f.activate();
  const first = checkpoint(f).session;
  await f.activate(await f.loadPage(), 'other@example.com');
  assert.equal(f.activationCount(), 2);
  assert.deepEqual(checkpoint(f).session.device, first.device);
  assert.equal(checkpoint(f).session.salt, first.salt);
});

test('existing activation works on firmware without the new MAC field', async () => {
  const options = {};
  const f = await protectedContentFixture(options);
  await f.activate();
  options.mac = '';
  await f.activate(await f.loadPage(), 'reader@example.com', '');
  assert.equal(f.activationCount(), 1);
});

test('lost checkpoint after activation cannot silently reactivate after reload', async () => {
  let writes = 0;
  const options = { failWrite: (path) => path === activationPath && ++writes === 3 };
  const f = await protectedContentFixture(options);
  await f.activate();
  assert.equal(f.activationCount(), 1);
  options.failWrite = null;
  const page = await f.loadPage();
  await f.activate(page);
  assert.equal(f.activationCount(), 1);
  assert.match(page.elements['lib-status'].textContent, /no saved reply/);
});
