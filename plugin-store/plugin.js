// Plugin Store — a plugin that installs other plugins.
//
// Point it at one or more catalog URLs (e.g. GitHub raw links to a catalog.json
// that lists plugins). Each catalog is fetched, and its plugins are installed
// by writing their files into /.crosspoint/plugins/<name>/ on the SD card. One
// store plugin can therefore aggregate several independent stores. Uses only
// existing device capabilities (relay, /mkdir, writeFile, /delete) — no
// firmware changes; publishing a plugin means adding it to a catalog.
CrossPoint.registerPlugin(async (container, api) => {
  const CONFIG_PATH = '/.crosspoint/plugin-store.json';
  const PLUGINS_DIR = '/.crosspoint/plugins';
  const DEFAULT_CATALOG = 'https://raw.githubusercontent.com/itsthisjustin/sd-plugins/main/catalog.json';

  let catalogs = [];  // list of catalog URLs

  container.innerHTML =
    '<h2>Plugin Store</h2>' +
    '<h3 style="margin:0.5em 0 0.2em">Stores</h3>' +
    '<div id="ps-stores"></div>' +
    '<div class="setting-row">' +
    '<span class="setting-control"><input type="text" id="ps-new" placeholder="https://.../catalog.json" style="width:100%"></span>' +
    '<button type="button" class="btn-small btn-add" id="ps-add">Add store</button></div>' +
    '<div class="setting-row"><button type="button" class="btn-small btn-add" id="ps-refresh">Save &amp; refresh</button></div>' +
    '<p id="ps-status"></p>' +
    '<div id="ps-list"></div>';

  const storesEl = document.getElementById('ps-stores');
  const listEl = document.getElementById('ps-list');
  const status = (t) => { document.getElementById('ps-status').textContent = t; };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return url; } }

  // UTF-8-safe base64 for writeFile (btoa alone breaks on non-Latin1 text).
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  async function loadStoreConfig() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(CONFIG_PATH));
      if (r.ok) return JSON.parse(await r.text());
    } catch (e) {}
    return {};
  }
  function saveStoreConfig() { return api.writeFile(CONFIG_PATH, b64(JSON.stringify({ catalogs }))); }

  async function installedNames() {
    try {
      const r = await fetch('/api/files?path=' + encodeURIComponent(PLUGINS_DIR));
      if (!r.ok) return new Set();
      const entries = await r.json();
      return new Set(entries.filter((e) => e.isDirectory).map((e) => e.name));
    } catch (e) {
      return new Set();
    }
  }

  async function relayText(url) {
    const r = await api.relay('GET', url, {}, '');
    if (r.error || (r.status && (r.status < 200 || r.status >= 300))) {
      throw new Error('HTTP ' + (r.status || r.error));
    }
    return r.body;
  }

  async function mkdir(path) {
    try {
      await fetch('/mkdir', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'path=' + encodeURIComponent(path)
      });
    } catch (e) {}
  }

  async function installPlugin(p) {
    const dir = PLUGINS_DIR + '/' + p.name;
    await mkdir(dir);
    const base = p.base.replace(/\/*$/, '/');
    for (const file of p.files) {
      const rel = file.replace(/^\/+/, '');
      // Create any intermediate folders for files like "assets/icon.bin".
      const segs = rel.split('/');
      segs.pop();
      let cur = dir;
      for (const seg of segs) { cur += '/' + seg; await mkdir(cur); }
      const body = await relayText(base + rel);
      const res = await api.writeFile(dir + '/' + rel, b64(body));
      if (!res.ok) throw new Error('could not write ' + rel);
    }
  }

  async function uninstallPlugin(p) {
    const dir = PLUGINS_DIR + '/' + p.name;
    for (const file of (p.files || [])) {
      try {
        await fetch('/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'path=' + encodeURIComponent(dir + '/' + file)
        });
      } catch (e) {}
    }
    try {
      await fetch('/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'path=' + encodeURIComponent(dir)
      });
    } catch (e) {}
  }

  // --- stores editor -------------------------------------------------------
  function renderStores() {
    storesEl.innerHTML = '';
    catalogs.forEach((url, i) => {
      const row = document.createElement('div');
      row.className = 'setting-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = url;
      input.style.width = '100%';
      input.oninput = () => { catalogs[i] = input.value.trim(); };
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn-small';
      rm.textContent = 'Remove';
      rm.onclick = () => { catalogs.splice(i, 1); renderStores(); };
      const control = document.createElement('span');
      control.className = 'setting-control';
      control.appendChild(input);
      row.appendChild(control);
      row.appendChild(rm);
      storesEl.appendChild(row);
    });
    if (catalogs.length === 0) storesEl.innerHTML = '<p style="color:#888">No stores yet — add a catalog URL below.</p>';
  }

  document.getElementById('ps-add').onclick = () => {
    const input = document.getElementById('ps-new');
    const url = input.value.trim();
    if (!url) return;
    catalogs.push(url);
    input.value = '';
    renderStores();
  };

  // --- plugin list ---------------------------------------------------------
  function pluginCard(p, storeName, installed) {
    const card = document.createElement('div');
    card.className = 'setting-row';
    const isInstalled = installed.has(p.name);
    const meta = document.createElement('span');
    meta.className = 'setting-name';
    meta.innerHTML = '<strong>' + escapeHtml(p.title || p.name) + '</strong>' +
      (p.author ? ' <span style="color:#888">by ' + escapeHtml(p.author) + '</span>' : '') +
      '<br><span style="color:#666">' + escapeHtml(p.description || '') + '</span>';
    const controls = document.createElement('span');
    controls.className = 'setting-control';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small btn-add';
    btn.textContent = isInstalled ? 'Reinstall' : 'Install';
    btn.onclick = async () => {
      btn.disabled = true;
      status('Installing ' + (p.title || p.name) + '…');
      try {
        await installPlugin(p);
        status('Installed ' + (p.title || p.name) + '. Reconnect or reopen Settings to use it.');
        refresh();
      } catch (e) {
        status('Error installing ' + (p.title || p.name) + ': ' + e.message);
        btn.disabled = false;
      }
    };
    controls.appendChild(btn);
    if (isInstalled) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn-small';
      rm.textContent = 'Remove';
      rm.onclick = async () => {
        rm.disabled = true;
        status('Removing ' + (p.title || p.name) + '…');
        try {
          await uninstallPlugin(p);
          status('Removed ' + (p.title || p.name) + '.');
          refresh();
        } catch (e) {
          status('Error: ' + e.message);
          rm.disabled = false;
        }
      };
      controls.appendChild(document.createTextNode(' '));
      controls.appendChild(rm);
    }
    card.appendChild(meta);
    card.appendChild(controls);
    return card;
  }

  async function refresh() {
    await saveStoreConfig();
    listEl.innerHTML = '';
    if (catalogs.length === 0) { status('Add a store URL to browse plugins.'); return; }
    status('Loading ' + catalogs.length + ' store' + (catalogs.length === 1 ? '' : 's') + '…');
    const installed = await installedNames();
    let total = 0;
    const errors = [];
    for (const url of catalogs) {
      let catalog;
      try {
        catalog = JSON.parse(await relayText(url));
      } catch (e) {
        errors.push(hostOf(url) + ': ' + e.message);
        continue;
      }
      const storeName = catalog.name || hostOf(url);
      const plugins = catalog.plugins || [];
      if (plugins.length) {
        const header = document.createElement('h3');
        header.textContent = storeName;
        header.style.margin = '0.8em 0 0.2em';
        listEl.appendChild(header);
      }
      plugins.forEach((p) => { listEl.appendChild(pluginCard(p, storeName, installed)); total += 1; });
    }
    let msg = total + ' plugin' + (total === 1 ? '' : 's') + ' available.';
    if (errors.length) msg += ' (' + errors.length + ' store' + (errors.length === 1 ? '' : 's') + ' failed: ' + errors.join('; ') + ')';
    status(msg);
  }

  document.getElementById('ps-refresh').onclick = refresh;

  const cfg = await loadStoreConfig();
  // Migrate the old single-catalog shape; seed with the default when empty.
  catalogs = Array.isArray(cfg.catalogs) ? cfg.catalogs : (cfg.catalog ? [cfg.catalog] : [DEFAULT_CATALOG]);
  renderStores();
  refresh();
});
