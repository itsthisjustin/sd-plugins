// WebDAV setup for CrossPoint. Collects the server URL and credentials in the
// browser and writes them to /.crosspoint/webdav.json, which the on-device
// WebDAV screen (device.json) reads to browse and download. Browsing and
// downloading then happen on the reader under Settings > System > Plugins >
// WebDAV — no computer needed after setup.
CrossPoint.registerPlugin(async (container, api) => {
  const CONFIG_PATH = '/.crosspoint/webdav.json';

  container.innerHTML =
    '<h2>WebDAV</h2>' +
    '<p id="wd-status">Checking configuration…</p>' +
    '<div class="setting-row"><span class="setting-name">Server URL</span>' +
    '<span class="setting-control"><input type="text" id="wd-url" placeholder="https://host/dav/Books/"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Username</span>' +
    '<span class="setting-control"><input type="text" id="wd-user" autocomplete="username"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Password</span>' +
    '<span class="setting-control"><input type="password" id="wd-pass" autocomplete="current-password"></span></div>' +
    '<div class="setting-row">' +
    '<button type="button" class="btn-small btn-add" id="wd-save">Save</button> ' +
    '<button type="button" class="btn-small" id="wd-test">Test</button> ' +
    '<button type="button" class="btn-small" id="wd-clear" style="display:none">Clear</button>' +
    '</div>' +
    '<p style="color:#666">The URL should point at the folder to browse, ending in a slash. ' +
    'Credentials are stored in plain text on the SD card.</p>';

  const urlEl = document.getElementById('wd-url');
  const userEl = document.getElementById('wd-user');
  const passEl = document.getElementById('wd-pass');
  const clearBtn = document.getElementById('wd-clear');
  const status = (t) => { document.getElementById('wd-status').textContent = t; };

  async function loadConfig() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(CONFIG_PATH));
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    } catch (e) {
      return null;
    }
  }

  function writeConfig(cfg) {
    return api.writeFile(CONFIG_PATH, btoa(JSON.stringify(cfg)));
  }

  function currentConfig() {
    const url = urlEl.value.trim();
    const user = userEl.value;
    const pass = passEl.value;
    if (!url) throw new Error('server URL is required');
    // {cfg.auth} is the base64 for the browse PROPFIND's Authorization header;
    // {cfg.user}/{cfg.pass} feed the device's file download (Basic auth).
    return { url, user, pass, auth: btoa(user + ':' + pass) };
  }

  document.getElementById('wd-save').onclick = async () => {
    try {
      await writeConfig(currentConfig());
      clearBtn.style.display = '';
      status('Saved. Browse from the device: Settings > System > Plugins > WebDAV.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  document.getElementById('wd-test').onclick = async () => {
    let cfg;
    try {
      cfg = currentConfig();
    } catch (e) {
      status('Error: ' + e.message);
      return;
    }
    status('Testing…');
    try {
      // PROPFIND depth 0 just checks the URL + credentials reach the server.
      const r = await api.relay('PROPFIND', cfg.url,
        { Authorization: 'Basic ' + cfg.auth, Depth: '0' }, '');
      if (r.status >= 200 && r.status < 300) status('Connection OK (HTTP ' + r.status + ').');
      else if (r.status === 401 || r.status === 403) status('Authentication failed (HTTP ' + r.status + ').');
      else status('Server returned HTTP ' + (r.status || r.error) + '.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  clearBtn.onclick = async () => {
    try {
      await writeConfig({});
      urlEl.value = userEl.value = passEl.value = '';
      clearBtn.style.display = 'none';
      status('Configuration cleared.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  const existing = await loadConfig();
  if (existing && existing.url) {
    urlEl.value = existing.url;
    userEl.value = existing.user || '';
    passEl.value = existing.pass || '';
    clearBtn.style.display = '';
    status('Configured. Browse from the device, or update below.');
  } else {
    status('Not configured yet.');
  }
});
