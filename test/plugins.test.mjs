import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

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
  const plugins = ['hello', 'organize-by-author', 'protected-content'];
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

test('protected content restores content.key, writes rights first, and fulfills without rewriting credentials', async () => {
  const document = fakeDocument([
    'lib-account-state', 'lib-user', 'lib-pass', 'lib-go', 'lib-acsm',
    'lib-refresh', 'lib-fulfill', 'lib-status',
  ]);
  const writes = [];
  const downloads = [];
  const deletes = [];
  const fulfillmentOperations = [];
  let savedCredential = '';
  let activationRedirected = false;
  const crypto = async (op, fields = {}) => {
    const zeros = (length) => btoa(String.fromCharCode(...new Uint8Array(length)));
    if (op === 'random') return { data: zeros(fields.len) };
    if (op === 'sha1') return { data: zeros(20) };
    if (op === 'keygen') return { public: 'cHVibGlj', private: 'cHJpdmF0ZQ==' };
    if (op === 'pubencrypt') return { data: zeros(128) };
    if (op === 'aesenc') return { data: zeros(16) };
    if (op === 'aesdec') return { data: 'cHJpdmF0ZQ==' };
    if (op === 'pkcs12') return { key: 'c2lnbmluZy1rZXk=', cert: 'c2lnbmluZy1jZXJ0' };
    if (op === 'sign') return { data: zeros(128) };
    throw new Error('unexpected crypto op: ' + op);
  };
  const relay = async (method, url, headers) => {
    assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent'), false);
    let body;
    if (url.endsWith('/ActivationServiceInfo') && !activationRedirected) {
      activationRedirected = true;
      return {
        status: 302,
        body: '',
        headers: [['location', '/adept/ActivationServiceInfo2']],
      };
    } else if (url.endsWith('/ActivationServiceInfo2')) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:authURL>https://adeactivate.adobe.com/adept</adept:authURL>' +
        '<adept:userInfoURL>https://adeactivate.adobe.com/user</adept:userInfoURL>' +
        '<adept:certificate>Y2VydA==</adept:certificate></adept:service>';
    } else if (url.endsWith('/AuthenticationServiceInfo')) {
      body = '<adept:service xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:certificate>YXV0aC1jZXJ0</adept:certificate></adept:service>';
    } else if (url.endsWith('/SignInDirect')) {
      body = '<adept:credentials xmlns:adept="http://ns.adobe.com/adept">' +
        '<adept:user>urn:uuid:user</adept:user><adept:pkcs12>cDEy</adept:pkcs12>' +
        '<adept:licenseCertificate>bGljLWNlcnQ=</adept:licenseCertificate>' +
        '<adept:encryptedPrivateLicenseKey>ZW5j</adept:encryptedPrivateLicenseKey>' +
        '</adept:credentials>';
    } else if (url.endsWith('/Activate')) {
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
  async function fetch(url, options = {}) {
    if (url === '/delete') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      deletes.push(new URLSearchParams(options.body).get('path'));
      return response();
    }
    if (url.startsWith('/api/files')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (path === '/.crosspoint') {
        return response({ json: savedCredential
          ? [{ name: 'content.key', isDirectory: false }]
          : [] });
      }
      if (path === '/Loans') {
        return response({ json: [{ name: 'library-loan.acsm', isDirectory: false }] });
      }
      return response({ json: [{ name: 'Test Book.epub', isDirectory: false }] });
    }
    if (url.startsWith('/download')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path');
      if (path === '/.crosspoint/content.key') return response({ text: savedCredential });
      if (path === '/Loans/library-loan.acsm') return response({ text: acsm });
    }
    throw new Error('unexpected fetch: ' + url);
  }

  const { render } = await loadPlugin('protected-content/plugin.js', {
    document,
    window: { location: { search: '?path=%2FLoans' } },
    fetch,
  });
  await render({ innerHTML: '' }, api);
  assert.match(document.elements['lib-account-state'].textContent, /No content account/);
  assert.equal(document.elements['lib-acsm'].value, 'library-loan.acsm');
  document.elements['lib-user'].value = 'reader@example.com';
  document.elements['lib-pass'].value = 'secret';
  await document.elements['lib-go'].onclick();

  assert.equal(activationRedirected, true);
  assert.equal(document.elements['lib-pass'].value, '');
  assert.equal(writes[0].path, '/.crosspoint/content.key');
  assert.match(savedCredential, /^FREEINK-CONTENT-KEY 1/m);
  assert.match(savedCredential, /^protectedContentState: /m);
  const credentialAfterActivation = savedCredential;

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
  assert.equal(writes[1].path, '/Loans/Test Book.epub.rights');
  assert.equal(writes.length, 2);
  assert.deepEqual(fulfillmentOperations, ['rights', 'download']);
  assert.equal(savedCredential, credentialAfterActivation);
  assert.deepEqual(deletes, ['/Loans/library-loan.acsm']);
  assert.match(reloadedDocument.elements['lib-status'].textContent, /Fetched “Test Book”/);
});
