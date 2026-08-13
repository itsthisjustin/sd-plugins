// Dictionaries — install monolingual dictionaries for the reader's built-in
// dictionary lookup (long-press a word while reading), and pick the active one.
//
// These explain a word in its own language — English words defined in English,
// Spanish in Spanish — for looking up words in a book, not translating. The
// reader loads dictionaries from /dictionaries/<name>/ as loose StarDict files
// (plain .idx + .dict.dz); a scheduled workflow in this repo builds them from
// each language's own Wiktionary edition (plus Webster's 1913 for English) and
// hosts them as GitHub release assets. The active dictionary lives in
// /.crosspoint/settings.json under "dictionaryName" — written here directly,
// so no firmware changes are needed.
CrossPoint.registerPlugin(async (container, api) => {
  const INDEX_URL = 'https://raw.githubusercontent.com/itsthisjustin/sd-plugins/refs/heads/main/dictionaries/catalog/index.json';
  const INDEX_CACHE = '/.crosspoint/dictionaries-index.json';
  const DICT_DIR = '/dictionaries';
  const SETTINGS_PATH = '/.crosspoint/settings.json';

  let catalog = [];         // [{id, title, author, base, files, bytes, edition}]
  let installed = new Set() // folder names under /dictionaries
  let filter = '';

  container.innerHTML =
    '<h2>Dictionaries</h2>' +
    '<p id="fd-status">Loading dictionary catalog…</p>' +
    '<h3 style="margin:0.5em 0 0.2em">Active dictionary</h3>' +
    '<div class="setting-row">' +
    '<span class="setting-control"><select id="fd-active" style="width:100%"></select></span>' +
    '<button type="button" class="btn-small btn-add" id="fd-set-active">Set active</button></div>' +
    '<p id="fd-active-note" style="color:#666">Takes effect after the reader restarts. You can also pick it on the device under Settings &gt; Dictionary once a dictionary is installed.</p>' +
    '<h3 style="margin:0.8em 0 0.2em">Available dictionaries</h3>' +
    '<div class="setting-row"><span class="setting-control">' +
    '<input type="text" id="fd-search" placeholder="Filter, e.g. english or deu" style="width:100%"></span></div>' +
    '<div id="fd-list"></div>' +
    '<p style="color:#666">Dictionaries install to <code>/dictionaries/&lt;name&gt;/</code>. ' +
    'You can also browse and download them on the reader itself under Settings &gt; System &gt; Plugins &gt; Dictionaries. ' +
    'Built from each language\'s <a href="https://en.wiktionary.org" target="_blank">Wiktionary</a> (CC BY-SA) via <a href="https://kaikki.org" target="_blank">kaikki.org</a>, plus Webster\'s 1913 for English.</p>';

  const status = (t) => { document.getElementById('fd-status').textContent = t; };
  const listEl = document.getElementById('fd-list');
  const activeSel = document.getElementById('fd-active');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // UTF-8-safe base64 for writeFile.
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  async function post(path, params) {
    return fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  }

  // --- catalog + installed state -------------------------------------------
  async function loadCatalog() {
    // The browser usually reaches GitHub directly (raw.githubusercontent.com
    // sends CORS headers). If it can't, let the device download the index to
    // SD and read it back through the same-origin /download endpoint.
    try {
      const r = await fetch(INDEX_URL, { cache: 'no-store' });
      if (r.ok) return (await r.json()).items || [];
    } catch (e) {}
    const res = await api.fetchToSd(INDEX_URL, INDEX_CACHE, {});
    if (res.error || (res.status && (res.status < 200 || res.status >= 300))) {
      throw new Error('catalog download failed (' + (res.status || res.error) + ')');
    }
    const r = await fetch('/download?path=' + encodeURIComponent(INDEX_CACHE));
    if (!r.ok) throw new Error('catalog readback failed');
    return JSON.parse(await r.text()).items || [];
  }

  async function loadInstalled() {
    try {
      const r = await fetch('/api/files?path=' + encodeURIComponent(DICT_DIR));
      if (!r.ok) return new Set();
      return new Set((await r.json()).filter((e) => e.isDirectory).map((e) => e.name));
    } catch (e) {
      return new Set();
    }
  }

  async function readSettings() {
    const r = await fetch('/download?path=' + encodeURIComponent(SETTINGS_PATH));
    if (r.status === 404) return {};
    if (!r.ok) throw new Error('cannot read settings (' + r.status + ')');
    const text = await r.text();
    return text.trim() ? JSON.parse(text) : {};
  }

  // --- install / remove ----------------------------------------------------
  // GitHub release-asset URLs answer with a redirect, and the device's
  // /api/fetch does not follow redirects — resolve the hops here via the
  // relay (HEAD keeps the 32 KB relay cap irrelevant), then stream the final
  // URL straight to SD.
  async function resolveUrl(url) {
    for (let hop = 0; hop < 5; hop++) {
      let r;
      try { r = await api.relay('HEAD', url, {}, ''); } catch (e) { return url; }
      const s = r.status | 0;
      if (s < 300 || s >= 400) return url;
      let loc = '';
      for (const h of r.headers || []) if (String(h[0]).toLowerCase() === 'location') loc = h[1];
      if (!loc) return url;
      url = new URL(loc, url).toString();
    }
    return url;
  }

  async function installDict(dict, onProgress) {
    const base = dict.base.replace(/\/*$/, '/');
    const dir = DICT_DIR + '/' + dict.id;
    const files = dict.files || [];
    const written = [];
    try {
      for (let i = 0; i < files.length; i++) {
        if (onProgress) onProgress(i, files.length);
        const url = await resolveUrl(base + files[i]);
        const dest = dir + '/' + files[i];
        const res = await api.fetchToSd(url, dest, {});
        if (res.error || (res.status && (res.status < 200 || res.status >= 300))) {
          throw new Error('download failed for ' + files[i] + ' (' + (res.status || res.error) + ')');
        }
        written.push(dest);
      }
    } catch (e) {
      // Roll back a half-installed folder: the reader treats it as a broken
      // dictionary otherwise.
      for (const path of written) { try { await post('/delete', { path }); } catch (e2) {} }
      try { await post('/delete', { path: dir }); } catch (e2) {}
      throw e;
    }
    if (onProgress) onProgress(files.length, files.length);
  }

  async function removeDict(id) {
    const dir = DICT_DIR + '/' + id;
    // Delete everything in the folder — the reader adds .qidx/.sidx sidecars
    // beside the installed files on first lookup.
    try {
      const r = await fetch('/api/files?path=' + encodeURIComponent(dir));
      if (r.ok) {
        for (const entry of await r.json()) {
          if (!entry.isDirectory) await post('/delete', { path: dir + '/' + entry.name });
        }
      }
    } catch (e) {}
    await post('/delete', { path: dir });
  }

  // --- active dictionary ---------------------------------------------------
  function renderActive(current) {
    const names = Array.from(installed).sort();
    activeSel.innerHTML = '<option value="">None</option>' +
      names.map((n) => '<option value="' + escapeHtml(n) + '"' + (n === current ? ' selected' : '') + '>' +
        escapeHtml(n) + '</option>').join('');
    activeSel.value = current && installed.has(current) ? current : '';
  }

  document.getElementById('fd-set-active').onclick = async () => {
    const name = activeSel.value;
    try {
      // Read-modify-write so every other setting survives. The firmware only
      // reads this file at boot, hence the restart note; changing settings on
      // the device before restarting can write the old value back.
      const settings = await readSettings();
      if (name) settings.dictionaryName = name;
      else delete settings.dictionaryName;
      const res = await api.writeFile(SETTINGS_PATH, b64(JSON.stringify(settings)));
      if (res && res.ok === false) throw new Error('write failed');
      status(name
        ? 'Active dictionary set to "' + name + '". Restart the reader to apply.'
        : 'Active dictionary cleared. Restart the reader to apply.');
    } catch (e) {
      status('Error saving active dictionary: ' + e.message);
    }
  };

  // --- dictionary list -----------------------------------------------------
  function matches(dict) {
    if (!filter) return true;
    const hay = (dict.id + ' ' + dict.title).toLowerCase();
    return filter.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function renderList() {
    const visible = catalog.filter(matches);
    listEl.innerHTML = visible.map((d) => {
      const isInstalled = installed.has(d.id);
      return '<div class="setting-row">' +
        '<span class="setting-name"><strong>' + escapeHtml(d.title) + '</strong>' +
        (isInstalled ? ' <span style="color:#27ae60">Installed</span>' : '') +
        '<br><span style="color:#666">' + escapeHtml(d.author || '') + '</span></span>' +
        '<span class="setting-control">' +
        '<button type="button" class="btn-small btn-add" id="fd-install-' + escapeHtml(d.id) + '">' +
        (isInstalled ? 'Reinstall' : 'Install') + '</button>' +
        (isInstalled ? ' <button type="button" class="btn-small" id="fd-remove-' + escapeHtml(d.id) + '">Remove</button>' : '') +
        '</span></div>';
    }).join('') || '<p style="color:#888">No dictionaries match.</p>';

    for (const d of visible) {
      const btn = document.getElementById('fd-install-' + d.id);
      btn.onclick = async () => {
        btn.disabled = true;
        status('Installing ' + d.title + '…');
        try {
          await installDict(d, (done, total) => { btn.textContent = done + '/' + total; });
          installed.add(d.id);
          status('Installed ' + d.title + '. Set it active above, or on the device under Settings > Dictionary.');
          renderActive(activeSel.value);
          renderList();
        } catch (e) {
          status('Error installing ' + d.title + ': ' + e.message);
          btn.textContent = installed.has(d.id) ? 'Reinstall' : 'Install';
          btn.disabled = false;
        }
      };
      if (installed.has(d.id)) {
        const rm = document.getElementById('fd-remove-' + d.id);
        rm.onclick = async () => {
          rm.disabled = true;
          status('Removing ' + d.title + '…');
          try {
            await removeDict(d.id);
            installed.delete(d.id);
            status('Removed ' + d.title + '.');
            renderActive(activeSel.value);
            renderList();
          } catch (e) {
            status('Error removing ' + d.title + ': ' + e.message);
            rm.disabled = false;
          }
        };
      }
    }
  }

  document.getElementById('fd-search').oninput = function () {
    filter = this.value.trim();
    renderList();
  };

  // --- boot ----------------------------------------------------------------
  try {
    installed = await loadInstalled();
    let current = '';
    try { current = (await readSettings()).dictionaryName || ''; } catch (e) {}
    renderActive(current);
    catalog = await loadCatalog();
    status(catalog.length + ' dictionaries available.');
    renderList();
  } catch (e) {
    status('Error: ' + e.message);
  }
});
