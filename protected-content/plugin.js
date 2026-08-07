// Browser-side account activation and fulfillment using generic device APIs:
//   /api/relay      outbound HTTP(S) (browsers can't, due to CORS)
//   /api/crypto     wolfSSL primitives (keygen, sign, AES, PKCS#12, hash, random)
//   /api/fetch      download a URL straight to SD (book bytes never touch the page)
//   /api/plugin-fs  write a small file to SD (the credential + rights sidecar)

CrossPoint.registerPlugin(async (container, api) => {
  const ADEPT_NS = 'http://ns.adobe.com/adept';
  const ACS = 'https://adeactivate.adobe.com/adept';
  const ADEPT_CT = 'application/vnd.adobe.adept+xml';
  const CREDENTIAL_PATH = '/.crosspoint/content.key';
  const HOBBES = '10.0.4';
  const currentFolder = new URLSearchParams(window.location.search).get('path') || '/';

  // Everything the activate + fulfill flow needs. It is persisted as an
  // SDK-ignored field in content.key so uploaded ACSMs also work after reload.
  let session = null; // { salt, device, act }

  // ======================================================================== //
  // device capability wrappers
  // ======================================================================== //
  async function dcrypto(op, fields) {
    const j = await api.crypto(op, fields || {});
    if (j.error) throw new Error('crypto ' + op + ': ' + j.error);
    return j;
  }
  function responseHeader(response, wantedName) {
    const wanted = wantedName.toLowerCase();
    const match = (response.headers || []).find(([name]) => String(name).toLowerCase() === wanted);
    return match ? String(match[1]) : '';
  }
  async function relayFollow(method, url, headers, body) {
    let activeMethod = method;
    let activeUrl = url;
    let activeHeaders = headers;
    let activeBody = body;
    for (let hop = 0; hop <= 5; hop++) {
      let response;
      try {
        response = await api.relay(activeMethod, activeUrl, activeHeaders, activeBody);
      } catch (e) {
        let host = activeUrl;
        try { host = new URL(activeUrl).host; } catch (ignored) {}
        throw new Error(e.message + ' while requesting ' + host);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = responseHeader(response, 'location');
      if (!location) return response;
      if (hop === 5) throw new Error('too many redirects from ' + url);
      activeUrl = new URL(location, activeUrl).href;
      if (response.status === 303 ||
          ((response.status === 301 || response.status === 302) && activeMethod === 'POST')) {
        activeMethod = 'GET';
        activeHeaders = {};
        activeBody = '';
      }
    }
    throw new Error('too many redirects from ' + url);
  }
  async function httpGet(url) {
    const r = await relayFollow('GET', url, {}, '');
    if (r.error) throw new Error('relay: ' + r.error);
    if (r.status < 200 || r.status >= 300) {
      throw new Error('HTTP ' + r.status + ' from ' + url);
    }
    return r; // { status, body }
  }
  async function sendAdept(url, doc) {
    const r = await relayFollow('POST', url,
      { 'Content-Type': ADEPT_CT }, serialize(doc));
    if (r.error) throw new Error('relay: ' + r.error);
    let root;
    try {
      root = parseXml(r.body);
    } catch (e) {
      if (r.status < 200 || r.status >= 300) {
        throw new Error('HTTP ' + r.status + ' from ' + url);
      }
      throw e;
    }
    if (root.name === 'error' || root.name.endsWith(':error')) {
      throw new Error(root.attrs.data || ('ACS error (HTTP ' + r.status + ')'));
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error('HTTP ' + r.status + ' from ' + url);
    }
    return root;
  }

  // ======================================================================== //
  // base64 <-> bytes (arbitrary binary; btoa/atob are latin1-only)
  // ======================================================================== //
  const te = new TextEncoder();
  const td = new TextDecoder();
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(b) { return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); }
  function concatBytes(arrays) {
    let n = 0;
    for (const a of arrays) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  }
  function utf8ToB64(value) { return bytesToB64(te.encode(value)); }
  function b64ToUtf8(value) { return td.decode(b64ToBytes(value)); }

  // ======================================================================== //
  // XML model
  // ======================================================================== //
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent) => {
      if (ent[0] === '#') {
        const code = (ent[1] === 'x' || ent[1] === 'X') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[ent] || m;
    });
  }
  function escapeText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }
  function el(name, attrs, children) { return { name, attrs: attrs || {}, children: children || [] }; }
  function textEl(name, text, attrs) { return el(name, attrs, [text]); }
  function serialize(node) { return '<?xml version="1.0"?>\n' + serializeNode(node); }
  function serializeNode(node) {
    let attrs = '';
    for (const k of Object.keys(node.attrs)) attrs += ' ' + k + '="' + escapeAttr(node.attrs[k]) + '"';
    if (node.children.length === 0) return '<' + node.name + attrs + '/>';
    let inner = '';
    for (const c of node.children) inner += (typeof c === 'string') ? escapeText(c) : serializeNode(c);
    return '<' + node.name + attrs + '>' + inner + '</' + node.name + '>';
  }
  function child(node, name) {
    return node.children.find((c) => typeof c !== 'string' && (c.name === name || c.name.endsWith(':' + name)));
  }
  function childText(node, name) {
    const c = child(node, name);
    if (!c) return undefined;
    const t = textContent(c).trim();
    return t === '' ? undefined : t;
  }
  function textContent(node) {
    return node.children.map((c) => (typeof c === 'string' ? decodeEntities(c) : textContent(c))).join('');
  }
  function find(node, name) {
    if (node.name === name || node.name.endsWith(':' + name)) return node;
    for (const c of node.children) {
      if (typeof c !== 'string') { const hit = find(c, name); if (hit) return hit; }
    }
    return undefined;
  }
  function deepCopy(node) {
    return { name: node.name, attrs: Object.assign({}, node.attrs),
      children: node.children.map((c) => (typeof c === 'string' ? c : deepCopy(c))) };
  }
  function removeFirst(root, name) {
    for (let i = 0; i < root.children.length; i++) {
      const c = root.children[i];
      if (typeof c !== 'string' && (c.name === name || c.name.endsWith(':' + name))) {
        root.children.splice(i, 1); return c;
      }
    }
    for (const c of root.children) {
      if (typeof c !== 'string') { const hit = removeFirst(c, name); if (hit) return hit; }
    }
    return undefined;
  }
  function findTagEnd(src, start) {
    let quote = null;
    for (let i = start + 1; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') return i;
    }
    throw new Error('malformed XML: unclosed tag');
  }
  function parseTag(content) {
    const nameMatch = /^[^\s/>]+/.exec(content);
    if (!nameMatch) throw new Error('malformed XML tag');
    const name = nameMatch[0];
    const attrs = {};
    const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
    let m;
    while ((m = attrRe.exec(content)) !== null) attrs[m[1] || m[3]] = decodeEntities(m[2] || m[4] || '');
    return { name, attrs, children: [] };
  }
  function parseXml(src) {
    let i = 0; const stack = []; let root = null;
    const pushText = (raw) => {
      if (stack.length === 0 || raw === '' || raw.trim() === '') return;
      stack[stack.length - 1].children.push(decodeEntities(raw));
    };
    while (i < src.length) {
      if (src[i] === '<') {
        if (src.startsWith('<?', i)) {
          const end = src.indexOf('?>', i);
          if (end === -1) throw new Error('malformed XML: unclosed declaration');
          i = end + 2; continue;
        }
        if (src.startsWith('<!--', i)) {
          const end = src.indexOf('-->', i);
          if (end === -1) throw new Error('malformed XML: unclosed comment');
          i = end + 3; continue;
        }
        if (src.startsWith('<![CDATA[', i)) {
          const end = src.indexOf(']]>', i);
          if (end === -1) throw new Error('malformed XML: unclosed CDATA');
          if (stack.length > 0) stack[stack.length - 1].children.push(src.slice(i + 9, end));
          i = end + 3; continue;
        }
        if (src.startsWith('<!', i)) {
          const end = src.indexOf('>', i);
          if (end === -1) throw new Error('malformed XML: unclosed directive');
          i = end + 1; continue;
        }
        if (src[i + 1] === '/') {
          const end = src.indexOf('>', i);
          if (end === -1) throw new Error('malformed XML: unclosed end tag');
          const closing = src.slice(i + 2, end).trim();
          const opened = stack.pop();
          if (!opened || opened.name !== closing) {
            throw new Error('malformed XML: mismatched </' + closing + '>');
          }
          i = end + 1; continue;
        }
        const end = findTagEnd(src, i);
        let tagContent = src.slice(i + 1, end).trim();
        const selfClose = tagContent.endsWith('/');
        if (selfClose) tagContent = tagContent.slice(0, -1).trimEnd();
        const node = parseTag(tagContent);
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        else if (!root) root = node;
        else throw new Error('malformed XML: multiple roots');
        if (!selfClose) stack.push(node);
        i = end + 1;
      } else {
        const end = src.indexOf('<', i);
        pushText(src.slice(i, end === -1 ? src.length : end));
        i = end === -1 ? src.length : end;
      }
    }
    if (!root) throw new Error('malformed XML: no root');
    if (stack.length !== 0) throw new Error('malformed XML: unclosed <' + stack[stack.length - 1].name + '>');
    return root;
  }

  // ======================================================================== //
  // Request-signing canonicalization
  //
  // The signature input is SHA-1 over a custom binary serialization of the XML
  // tree (namespace URIs resolved, attributes sorted, text trimmed). Must match
  // the RMSDK canonicalization byte-for-byte or the server rejects signatures.
  // ======================================================================== //
  const ASN_NS_TAG = 0x01, ASN_CHILD = 0x02, ASN_END_TAG = 0x03, ASN_TEXT = 0x04, ASN_ATTRIBUTE = 0x05;
  function canonBytes(node) {
    const chunks = [];
    const pushTag = (t) => chunks.push(new Uint8Array([t]));
    const pushString = (s) => {
      const bytes = te.encode(s);
      const len = new Uint8Array(2);
      len[0] = (bytes.length >> 8) & 0xff; len[1] = bytes.length & 0xff; // uint16 BE
      chunks.push(len, bytes);
    };
    const walk = (n, nsHash) => {
      for (const k of Object.keys(n.attrs)) {
        if (k === 'xmlns') nsHash.set('GENERICNS', n.attrs[k]);
        else if (k.startsWith('xmlns:')) nsHash.set(k.slice('xmlns:'.length), n.attrs[k]);
      }
      let name = n.name;
      const colon = name.indexOf(':');
      if (colon !== -1) {
        pushTag(ASN_NS_TAG); pushString(nsHash.get(name.slice(0, colon)) || '');
        name = name.slice(colon + 1);
      } else if (nsHash.has('GENERICNS')) {
        pushTag(ASN_NS_TAG); pushString(nsHash.get('GENERICNS'));
      }
      pushString(name);
      const attrNames = Object.keys(n.attrs).filter((a) => a.indexOf('xmlns') === -1).sort();
      for (const attrName of attrNames) {
        pushTag(ASN_ATTRIBUTE); pushString(''); pushString(attrName); pushString(n.attrs[attrName]);
      }
      pushTag(ASN_CHILD);
      for (const c of n.children) {
        if (typeof c === 'string') {
          const trimmed = c.trim();
          if (trimmed !== '') { pushTag(ASN_TEXT); pushString(trimmed); }
        } else walk(c, nsHash);
      }
      pushTag(ASN_END_TAG);
    };
    walk(node, new Map());
    return concatBytes(chunks);
  }
  // SHA-1 of the canonicalization (device-side, since http:// has no SubtleCrypto).
  async function hashNode(node) {
    const bytes = canonBytes(node);
    return (await dcrypto('sha1', { data: bytesToB64(bytes) })).data; // base64, 20 bytes
  }
  async function signNode(root) {
    const hashB64 = await hashNode(root);
    const sig = await dcrypto('sign', { private: session.act.signingKey, hash: hashB64 });
    root.children.push(textEl('adept:signature', sig.data));
  }

  // ======================================================================== //
  // nonce / expiration — ported from crypto.ts
  // ======================================================================== //
  function makeNonce() {
    const now = Date.now();
    const low = (now >>> 0);
    const high = Math.floor(now / 0x100000000) >>> 0;
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, (0x6f046000 + low) >>> 0, true);
    dv.setUint32(4, (0x388a + high) >>> 0, true);
    dv.setUint32(8, 0, true);
    return bytesToB64(buf);
  }
  function makeExpiration() {
    return new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  }
  function addNonce(root) {
    root.children.push(textEl('adept:nonce', makeNonce()));
    root.children.push(textEl('adept:expiration', makeExpiration()));
  }

  // ======================================================================== //
  // device-key AES wrap/unwrap — ported from crypto.ts (iv || AES-128-CBC)
  // ======================================================================== //
  async function deviceKeyEncrypt(saltB64, dataB64) {
    const ivB64 = (await dcrypto('random', { len: 16 })).data;
    const ctB64 = (await dcrypto('aesenc', { key: saltB64, iv: ivB64, data: dataB64 })).data;
    return bytesToB64(concatBytes([b64ToBytes(ivB64), b64ToBytes(ctB64)]));
  }
  async function deviceKeyDecrypt(saltB64, wrappedB64) {
    const wrapped = b64ToBytes(wrappedB64);
    const iv = bytesToB64(wrapped.slice(0, 16));
    const ct = bytesToB64(wrapped.slice(16));
    let plain = b64ToBytes((await dcrypto('aesdec', { key: saltB64, iv, data: ct })).data);
    const pad = plain[plain.length - 1]; // strip PKCS#7 (aesdec returns raw)
    if (pad >= 1 && pad <= 16) plain = plain.slice(0, plain.length - pad);
    return bytesToB64(plain);
  }

  // ======================================================================== //
  // 1. identity  2. bootstrap  3. sign-in  4. activate  — ported from client.ts
  // ======================================================================== //
  async function makeIdentity() {
    const salt = (await dcrypto('random', { len: 16 })).data;
    const serialBytes = b64ToBytes((await dcrypto('sha1', { data: (await dcrypto('random', { len: 20 })).data })).data);
    const serial = [...serialBytes].map((x) => x.toString(16).padStart(2, '0')).join('');
    // fingerprint = base64(sha1(utf8(serial) || salt))
    const fpInput = bytesToB64(concatBytes([te.encode(serial), b64ToBytes(salt)]));
    const fingerprint = (await dcrypto('sha1', { data: fpInput })).data;
    return {
      salt,
      device: {
        serial, fingerprint,
        deviceClass: 'Desktop', deviceType: 'standalone', deviceName: 'browser',
        hobbes: HOBBES, clientOS: 'Linux', clientLocale: 'en_US',
      },
    };
  }

  async function bootstrap() {
    const info = parseXml((await httpGet(ACS + '/ActivationServiceInfo')).body);
    const authURL = req(find(info, 'authURL'), 'authURL');
    const userInfoURL = req(find(info, 'userInfoURL'), 'userInfoURL');
    const certificate = req(find(info, 'certificate'), 'certificate');
    const authInfo = parseXml((await httpGet(authURL + '/AuthenticationServiceInfo')).body);
    const authenticationCertificate = req(find(authInfo, 'certificate'), 'certificate');
    return {
      acsServer: ACS, authURL, userInfoURL, activationURL: ACS,
      certificate, authenticationCertificate, operatorUrls: [], licenseServiceCerts: {},
    };
  }
  function req(node, what) {
    const t = node ? textContent(node).trim() : '';
    if (!node || t === '') throw new Error('service info missing ' + what);
    return t;
  }

  async function signIn(user, pass) {
    status('Signing in…');
    const salt = session.salt, act = session.act;
    // signInData = RSA(authCert, salt | len u | u | len p | p)
    const userBytes = te.encode(user);
    const passBytes = te.encode(pass);
    if (userBytes.length > 255 || passBytes.length > 255) throw new Error('account ID or password is too long');
    const cred = concatBytes([
      b64ToBytes(salt), new Uint8Array([userBytes.length]), userBytes,
      new Uint8Array([passBytes.length]), passBytes,
    ]);
    const signInData = (await dcrypto('pubencrypt', { cert: act.authenticationCertificate, data: bytesToB64(cred) })).data;

    const authPair = await dcrypto('keygen');    // { public: SPKI, private: PKCS8 } (base64 DER)
    const licPair = await dcrypto('keygen');
    const reqDoc = el('adept:signIn', { 'xmlns:adept': ADEPT_NS, method: 'AdobeID' }, [
      textEl('adept:signInData', signInData),
      textEl('adept:publicAuthKey', authPair.public),
      textEl('adept:encryptedPrivateAuthKey', await deviceKeyEncrypt(salt, authPair.private)),
      textEl('adept:publicLicenseKey', licPair.public),
      textEl('adept:encryptedPrivateLicenseKey', await deviceKeyEncrypt(salt, licPair.private)),
    ]);

    const creds = await sendAdept(act.authURL + '/SignInDirect', reqDoc);
    if (!creds.name.endsWith('credentials')) throw new Error('unexpected sign-in reply <' + creds.name + '>');

    const userUuid = req(find(creds, 'user'), 'user');
    const pkcs12 = req(find(creds, 'pkcs12'), 'pkcs12');
    const licenseCertificate = req(find(creds, 'licenseCertificate'), 'licenseCertificate');
    const encLicenseKey = req(find(creds, 'encryptedPrivateLicenseKey'), 'encryptedPrivateLicenseKey');

    // license private key: device-key-decrypt to clear PKCS#8 (base64)
    const privateLicenseKey = await deviceKeyDecrypt(salt, encLicenseKey);
    // signing keypair from the PKCS#12 (passphrase = base64(salt))
    const p12 = await dcrypto('pkcs12', { data: pkcs12, password: salt });

    Object.assign(act, { username: user, userUuid, licenseCertificate, privateLicenseKey,
      signingKey: p12.key, signingCert: p12.cert });
  }

  async function activateDevice() {
    status('Activating device…');
    const d = session.device, act = session.act;
    const target = el('adept:targetDevice', {}, [
      textEl('adept:softwareVersion', d.hobbes),
      textEl('adept:clientOS', d.clientOS),
      textEl('adept:clientLocale', d.clientLocale),
      textEl('adept:clientVersion', d.deviceClass),
      textEl('adept:deviceType', d.deviceType),
      textEl('adept:fingerprint', d.fingerprint),
    ]);
    const reqDoc = el('adept:activate', { 'xmlns:adept': ADEPT_NS, requestType: 'initial' }, [
      textEl('adept:fingerprint', d.fingerprint),
      textEl('adept:deviceType', d.deviceType),
      textEl('adept:clientOS', d.clientOS),
      textEl('adept:clientLocale', d.clientLocale),
      textEl('adept:clientVersion', d.deviceClass),
      target,
    ]);
    addNonce(reqDoc);
    reqDoc.children.push(textEl('adept:user', act.userUuid));
    await signNode(reqDoc);

    const token = await sendAdept(act.activationURL + '/Activate', reqDoc);
    act.deviceUuid = req(find(token, 'device'), 'device (activation token)');
  }

  // ======================================================================== //
  // operator auth + fulfillment — ported from client.ts
  // ======================================================================== //
  function authBaseFrom(fulfillURL) {
    const withoutTrailingSlash = fulfillURL.replace(/\/+$/, '');
    return withoutTrailingSlash.endsWith('/Fulfill')
      ? withoutTrailingSlash.slice(0, -'/Fulfill'.length)
      : withoutTrailingSlash;
  }
  function buildAuthRequest(act) {
    const certDerB64 = String(act.signingCert); // pkcs12 op already returns DER base64
    return el('adept:credentials', { 'xmlns:adept': ADEPT_NS }, [
      textEl('adept:user', act.userUuid),
      textEl('adept:certificate', certDerB64),
      textEl('adept:licenseCertificate', act.licenseCertificate),
      textEl('adept:authenticationCertificate', act.authenticationCertificate),
    ]);
  }
  async function doOperatorAuth(fulfillURL) {
    const act = session.act;
    const authBase = authBaseFrom(fulfillURL);
    await sendAdept(authBase + '/Auth', buildAuthRequest(act));
    const initReq = el('adept:licenseServiceRequest', { 'xmlns:adept': ADEPT_NS, identity: 'user' }, [
      textEl('adept:operatorURL', authBase),
    ]);
    addNonce(initReq);
    initReq.children.push(textEl('adept:user', act.userUuid));
    await signNode(initReq);
    await sendAdept(act.activationURL + '/InitLicenseService', initReq);
    if (act.operatorUrls.indexOf(fulfillURL) === -1) act.operatorUrls.push(fulfillURL);
  }
  async function operatorAuth(fulfillURL) {
    if (session.act.operatorUrls.indexOf(fulfillURL) !== -1) return;
    await doOperatorAuth(fulfillURL);
  }

  async function fetchLicenseServiceCertificate(operatorURL, licenseURL) {
    const act = session.act;
    if (act.licenseServiceCerts[licenseURL]) return;
    const reply = parseXml((await httpGet(
      operatorURL + '/LicenseServiceInfo?licenseURL=' + encodeURIComponent(licenseURL))).body);
    act.licenseServiceCerts[licenseURL] = req(find(reply, 'certificate'), 'license service certificate');
  }
  async function notifyServer(reply) {
    const act = session.act;
    const notify = find(reply, 'notify');
    if (!notify) return;
    const notifyUrl = childText(notify, 'notifyURL');
    const body = child(notify, 'body');
    if (!notifyUrl || !body) return;
    try {
      const bodyCopy = deepCopy(body); bodyCopy.attrs.xmlns = ADEPT_NS;
      const reqDoc = el('adept:notification', { 'xmlns:adept': ADEPT_NS }, [
        textEl('adept:user', act.userUuid), textEl('adept:device', act.deviceUuid), bodyCopy,
      ]);
      addNonce(reqDoc);
      await signNode(reqDoc);
      await sendAdept(notifyUrl, reqDoc);
    } catch (e) { /* notify is best-effort */ }
  }

  async function uniqueBookDestination(title, destDir) {
    // The book and its rights sidecar land next to the .acsm — in the folder
    // the File Manager is showing, or wherever a queued job's .acsm lives.
    const dir = destDir || currentFolder;
    const response = await fetch('/api/files?path=' + encodeURIComponent(dir));
    if (!response.ok) throw new Error('could not inspect this folder (HTTP ' + response.status + ')');
    const entries = await response.json();
    const names = new Set(entries.map((entry) => String(entry.name).toLowerCase()));
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? '' : ' (' + n + ')';
      const name = title + suffix + '.epub';
      if (!names.has(name.toLowerCase()) && !names.has((name + '.rights').toLowerCase())) {
        return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
      }
    }
    throw new Error('too many books named “' + title + '”');
  }

  async function fulfill(acsmText, destDir) {
    const d = session.device, act = session.act;
    const acsmRoot = parseXml(acsmText);
    if (!acsmRoot.name.endsWith('fulfillmentToken')) throw new Error('not an .acsm (root <' + acsmRoot.name + '>)');

    const operatorURL = req(find(acsmRoot, 'operatorURL'), 'operatorURL').replace(/\/+$/, '');
    const fulfillURL = operatorURL + '/Fulfill';

    status('Building fulfillment request…');
    const reqDoc = el('adept:fulfill', { 'xmlns:adept': ADEPT_NS }, [
      textEl('adept:user', act.userUuid),
      textEl('adept:device', act.deviceUuid),
      textEl('adept:deviceType', d.deviceType),
      deepCopy(acsmRoot),
      el('adept:targetDevice', {}, [
        textEl('adept:softwareVersion', d.hobbes),
        textEl('adept:clientOS', d.clientOS),
        textEl('adept:clientLocale', d.clientLocale),
        textEl('adept:clientVersion', d.deviceClass),
        textEl('adept:deviceType', d.deviceType),
        textEl('adept:fingerprint', d.fingerprint),
        el('adept:activationToken', {}, [
          textEl('adept:user', act.userUuid), textEl('adept:device', act.deviceUuid),
        ]),
      ]),
    ]);
    // Sign the request with the hmac removed, then restore it (the server
    // verifies the hmac against the UNSIGNED token).
    const hmac = removeFirst(reqDoc, 'hmac');
    if (!hmac) throw new Error('hmac element not found in .acsm');
    const hmacText = textContent(hmac);
    await signNode(reqDoc);
    find(reqDoc, 'fulfillmentToken').children.push(el('hmac', {}, [hmacText]));

    status('Authenticating to distributor…');
    await operatorAuth(fulfillURL);

    status('Fulfilling…');
    let reply;
    try {
      reply = await sendAdept(fulfillURL, reqDoc);
    } catch (e) {
      if (String(e.message).indexOf('E_ADEPT_DISTRIBUTOR_AUTH') !== -1) {
        await doOperatorAuth(fulfillURL);
        reply = await sendAdept(fulfillURL, reqDoc);
      } else throw e;
    }

    const itemInfo = find(reply, 'resourceItemInfo');
    if (!itemInfo) throw new Error('fulfillment reply missing resourceItemInfo');
    const downloadUrl = req(child(itemInfo, 'src'), 'src (download URL)');
    const licenseToken = child(itemInfo, 'licenseToken');
    if (!licenseToken) throw new Error('fulfillment reply missing licenseToken');
    const licenseURL = req(find(licenseToken, 'licenseURL'), 'licenseURL');
    const titleNode = find(reply, 'title');
    const title = titleNode ? textContent(titleNode).trim() : ('book-' + Date.now());

    await fetchLicenseServiceCertificate(operatorURL, licenseURL);
    await notifyServer(reply);

    // rights.xml (licenseToken + licenseServiceInfo) — delivered as a sidecar.
    const tokenForRights = deepCopy(licenseToken);
    if (!tokenForRights.attrs.xmlns) tokenForRights.attrs.xmlns = ADEPT_NS;
    const rights = el('adept:rights', { 'xmlns:adept': ADEPT_NS }, [
      tokenForRights,
      el('adept:licenseServiceInfo', {}, [
        textEl('adept:licenseURL', licenseURL),
        textEl('adept:certificate', act.licenseServiceCerts[licenseURL] || ''),
      ]),
    ]);
    const rightsXml = serialize(rights);

    const safeTitle = title
      .replace(/[\/\\:*?"<>|]/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 60) || 'book';
    const dest = await uniqueBookDestination(safeTitle, destDir);
    // Persist the license before starting the long transfer. If the phone
    // disconnects after the device finishes the EPUB but before the browser
    // receives that completion response, the downloaded book is still usable.
    status('Saving rights for “' + safeTitle + '”…');
    const rightsWrite = await api.writeFile(dest + '.rights', bytesToB64(te.encode(rightsXml)));
    if (!rightsWrite.ok) throw new Error('could not write the book rights sidecar');

    status('Downloading “' + safeTitle + '” to the device…');
    // The payload is already content-encrypted end to end, so transport TLS
    // protects only the URL token — and on the device it costs ~40KB of heap,
    // the main source of truncated downloads. Prefer plain HTTP (the delivery
    // CDN serves the same object on both) and fall back to the original HTTPS
    // URL if anything but a clean 2xx comes back. Tampering self-detects: a
    // modified payload fails decryption when the book is opened.
    const attempts = [downloadUrl.replace(/^https:/, 'http:'), downloadUrl];
    let dl = null;
    let lastError = null;
    for (const url of attempts) {
      try {
        dl = await api.fetchToSd(url, dest, {});
      } catch (e) {
        lastError = e;
        dl = null;
        continue;
      }
      if (!dl.error && (!dl.status || (dl.status >= 200 && dl.status < 300))) break;
    }
    if (!dl) {
      throw new Error('download request failed: ' + (lastError ? lastError.message : 'unknown'));
    }
    if (dl.error || (dl.status && (dl.status < 200 || dl.status >= 300))) {
      if (dl.status >= 300 && dl.status < 400) {
        throw new Error('download URL redirected (HTTP ' + dl.status +
          '); this device needs the fulfillment service to return the final EPUB URL');
      }
      throw new Error('download failed (HTTP ' + (dl.status || dl.error) + ').');
    }
    return { title: safeTitle, dest, bytes: dl.bytes };
  }

  // ======================================================================== //
  // credential file the on-device reader loads (unwraps book content keys)
  // ======================================================================== //
  async function writeCredential() {
    const d = session.device, act = session.act;
    const pluginState = utf8ToB64(JSON.stringify({ version: 1, session }));
    const lines = [
      'FREEINK-CONTENT-KEY 1',
      'username: ' + (act.username || ''),
      'userUuid: ' + act.userUuid,
      'deviceUuid: ' + act.deviceUuid,
      'serial: ' + d.serial,
      'fingerprint: ' + d.fingerprint,
      'privateLicenseKey: ' + act.privateLicenseKey,
      'devicesalt: ' + session.salt,
      // Unknown fields are deliberately ignored by the SDK credential parser.
      'protectedContentState: ' + pluginState,
    ];
    const write = await api.writeFile(CREDENTIAL_PATH, bytesToB64(te.encode(lines.join('\n') + '\n')));
    if (!write.ok) throw new Error('could not write ' + CREDENTIAL_PATH);
  }

  function parseCredential(text) {
    const fields = {};
    const lines = String(text).split(/\r?\n/);
    if (!lines.length || !lines[0].startsWith('FREEINK-CONTENT-KEY')) {
      throw new Error('content.key has an unsupported format');
    }
    for (const line of lines.slice(1)) {
      const split = line.indexOf(': ');
      if (split > 0) fields[line.slice(0, split)] = line.slice(split + 2);
    }
    return fields;
  }

  function restorePluginSession(fields) {
    if (!fields.protectedContentState) return null;
    const saved = JSON.parse(b64ToUtf8(fields.protectedContentState));
    const restored = saved && saved.version === 1 ? saved.session : null;
    if (!restored || !restored.salt || !restored.device || !restored.act ||
        !restored.device.serial || !restored.device.fingerprint ||
        !restored.act.userUuid || !restored.act.deviceUuid ||
        !restored.act.signingKey || !restored.act.signingCert) {
      throw new Error('content.key does not contain a complete plugin session');
    }
    restored.act.operatorUrls = Array.isArray(restored.act.operatorUrls) ? restored.act.operatorUrls : [];
    restored.act.licenseServiceCerts = restored.act.licenseServiceCerts || {};
    return restored;
  }

  async function loadCredentialFromSd() {
    const listing = await fetch('/api/files?path=' + encodeURIComponent('/.crosspoint'));
    if (!listing.ok) throw new Error('could not inspect the credential folder (HTTP ' + listing.status + ')');
    const entries = await listing.json();
    const exists = entries.some((entry) => !entry.isDirectory && entry.name === 'content.key');
    if (!exists) return null;
    const response = await fetch('/download?path=' + encodeURIComponent(CREDENTIAL_PATH));
    if (!response.ok) throw new Error('could not read content.key (HTTP ' + response.status + ')');
    return parseCredential(await response.text());
  }

  function folderPath(name) {
    return (currentFolder === '/' ? '' : currentFolder.replace(/\/+$/, '')) + '/' + name;
  }

  async function deleteFile(path) {
    const response = await fetch('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'path=' + encodeURIComponent(path),
    });
    if (!response.ok) {
      throw new Error('content fetched, but could not delete ' + path +
        ' (HTTP ' + response.status + ')');
    }
  }

  async function refreshAcsmFiles() {
    const select = document.getElementById('lib-acsm');
    const response = await fetch('/api/files?path=' + encodeURIComponent(currentFolder));
    if (!response.ok) throw new Error('could not inspect this folder (HTTP ' + response.status + ')');
    const entries = await response.json();
    const files = entries
      .filter((entry) => !entry.isDirectory && /\.acsm$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    select.innerHTML = files.length
      ? files.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('')
      : '<option value="">No .acsm files in this folder</option>';
    select.disabled = files.length === 0;
    if (files.length && !files.includes(select.value)) select.value = files[0];
    updateFulfillButton();
  }

  function updateFulfillButton() {
    const select = document.getElementById('lib-acsm');
    document.getElementById('lib-fulfill').disabled =
      !session || !select || select.disabled || !select.value;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ======================================================================== //
  // UI
  // ======================================================================== //
  container.innerHTML =
    '<h2>Protected Content</h2>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;">' +
    'Connect a content account to open protected content. The protocol runs in this ' +
    'page; the device encrypts the credentials for the account service before ' +
    'relaying them. Need an account? ' +
    '<a href="https://dtsbytebooks.com/register" target="_blank" rel="noopener noreferrer" ' +
    'style="color:var(--accent-color);">Sign up at DTS ByteBooks</a>.</p>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;' +
    'padding:8px 10px;border:1px solid var(--border-color,#ddd);border-radius:4px;">' +
    '<strong>Network required:</strong> Device activation and book fetching only work when ' +
    'File Transfer is started in <strong>Join Network</strong> mode, not Hotspot mode.</p>' +
    '<div id="lib-account-state" style="margin-bottom:12px;color:var(--label-color);font-size:0.9em;">' +
    'Checking the SD card for an existing account…</div>' +
    '<div class="setting-row"><label class="setting-name" for="lib-user">Account ID</label>' +
    '<span class="setting-control"><input id="lib-user" name="account-id" type="text" autocomplete="username" placeholder="email"></span></div>' +
    '<div class="setting-row"><label class="setting-name" for="lib-pass">Password</label>' +
    '<span class="setting-control"><input id="lib-pass" name="password" type="password" autocomplete="current-password"></span></div>' +
    '<div style="margin-top:12px;text-align:center;">' +
    '<button type="button" class="btn-small" id="lib-go">Activate device</button></div>' +
    '<hr style="margin:16px 0;border:none;border-top:1px solid var(--border-color,#ddd)">' +
    '<label class="setting-name" for="lib-acsm" style="display:block;margin-bottom:6px;">Uploaded authorization file</label>' +
    '<p style="color:var(--label-color);font-size:0.85em;margin:0 0 8px;">' +
    'Upload an .acsm with the File Manager into <strong>' + escapeHtml(currentFolder) + '</strong>, then select it here.</p>' +
    '<select id="lib-acsm" name="authorization-file" style="width:100%;box-sizing:border-box;"></select>' +
    '<div style="margin-top:8px;text-align:center;">' +
    '<button type="button" class="btn-small" id="lib-refresh">Refresh files</button> ' +
    '<button type="button" class="btn-small btn-add" id="lib-fulfill" disabled>Fetch selected book</button></div>' +
    '<div id="lib-status" style="margin-top:12px;color:var(--label-color);font-size:0.9em;white-space:pre-line;"></div>';

  const statusEl = document.getElementById('lib-status');
  function status(m) { statusEl.textContent = m; }

  async function initialize() {
    const accountState = document.getElementById('lib-account-state');
    try {
      const fields = await loadCredentialFromSd();
      if (!fields) {
        accountState.textContent = 'No content account found on this SD card.';
      } else {
        document.getElementById('lib-user').value = fields.username || '';
        try {
          session = restorePluginSession(fields);
          accountState.textContent = 'Connected' +
            (fields.username ? ' as ' + fields.username : '') + ' — content.key found on the SD card.';
          document.getElementById('lib-go').textContent = 'Replace account';
        } catch (e) {
          accountState.textContent = 'content.key found' +
            (fields.username ? ' for ' + fields.username : '') +
            ', but it predates saved fulfillment sessions. Activate once to upgrade it.';
        }
      }
      await refreshAcsmFiles();
    } catch (e) {
      accountState.textContent = 'Could not check account state: ' + e.message;
      try { await refreshAcsmFiles(); } catch (refreshError) { status('Error: ' + refreshError.message); }
    }
    updateFulfillButton();
  }

  document.getElementById('lib-acsm').onchange = updateFulfillButton;
  document.getElementById('lib-refresh').onclick = async () => {
    const btn = document.getElementById('lib-refresh');
    btn.disabled = true;
    try {
      await refreshAcsmFiles();
      status('Authorization files refreshed.');
    } catch (e) {
      status('Error: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('lib-go').onclick = async () => {
    const user = document.getElementById('lib-user').value.trim();
    const pass = document.getElementById('lib-pass').value;
    if (!user || !pass) { status('Enter your account ID and password.'); return; }
    const btn = document.getElementById('lib-go');
    const fulfillBtn = document.getElementById('lib-fulfill');
    btn.disabled = true;
    fulfillBtn.disabled = true;
    session = null;
    try {
      status('Preparing device identity…');
      const id = await makeIdentity();
      session = { salt: id.salt, device: id.device, act: null };
      status('Contacting activation server…');
      session.act = await bootstrap();
      await signIn(user, pass);
      await activateDevice();
      await writeCredential();
      document.getElementById('lib-account-state').textContent =
        'Connected as ' + session.act.username + ' — content.key found on the SD card.';
      document.getElementById('lib-go').textContent = 'Replace account';
      status('Device activated as ' + session.act.userUuid + '.\n' +
        'Credential written to ' + CREDENTIAL_PATH + '. You can now fetch uploaded content below.');
      updateFulfillButton();
    } catch (e) {
      session = null;
      status('Error: ' + e.message);
    } finally {
      document.getElementById('lib-pass').value = '';
      btn.disabled = false;
    }
  };

  document.getElementById('lib-fulfill').onclick = async () => {
    if (!session || !session.act || !session.act.deviceUuid) { status('Activate the device first.'); return; }
    const selected = document.getElementById('lib-acsm').value;
    if (!selected) { status('Upload and select an .acsm file first.'); return; }
    const btn = document.getElementById('lib-fulfill');
    btn.disabled = true;
    try {
      const acsmPath = folderPath(selected);
      const acsmResponse = await fetch('/download?path=' + encodeURIComponent(acsmPath));
      if (!acsmResponse.ok) throw new Error('could not read ' + selected + ' (HTTP ' + acsmResponse.status + ')');
      const r = await fulfill(await acsmResponse.text());
      // Fulfillment adds distributor URLs and license-service certificates to
      // the in-memory session cache. They are safe to discover again after a
      // page reload; do not risk the permanent content credential by rewriting
      // it for disposable cache state.
      await deleteFile(acsmPath);
      await refreshAcsmFiles();
      status('Fetched “' + r.title + '” (' + (r.bytes || '?') + ' bytes) to ' + r.dest + '.\n' +
        'Open it from the reader — it decrypts on-device.');
    } catch (e) {
      status('Error: ' + e.message);
    } finally {
      updateFulfillButton();
    }
  };

  // Queued-job entry point: lets an external system (companion app, script)
  // fulfill an uploaded .acsm without this page's UI. Enqueue with
  //   POST /api/plugin-jobs {plugin:"protected-content", action:"fulfill",
  //                          args:{path:"/folder/book.acsm"}}
  // while any page hosting this plugin is open (e.g. /plugins-run), then poll
  // /api/plugin-jobs/status?id=N. The book and rights sidecar land in the
  // .acsm's folder.
  if (api.registerAction) {
    api.registerAction('fulfill', async (args) => {
      const path = String((args && args.path) || '');
      if (!path.startsWith('/')) throw new Error('args.path must be an absolute .acsm path');
      if (!session || !session.act || !session.act.deviceUuid) {
        throw new Error('device not activated; open the plugin UI once to sign in');
      }
      const acsmResponse = await fetch('/download?path=' + encodeURIComponent(path));
      if (!acsmResponse.ok) throw new Error('could not read ' + path + ' (HTTP ' + acsmResponse.status + ')');
      const destDir = path.slice(0, path.lastIndexOf('/')) || '/';
      const r = await fulfill(await acsmResponse.text(), destDir);
      await writeCredential();
      await deleteFile(path);
      return { title: r.title, dest: r.dest, bytes: r.bytes || 0 };
    });
  }

  await initialize();
});
