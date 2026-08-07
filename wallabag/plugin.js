// Wallabag setup for CrossPoint. Collects the server URL, API client
// credentials, and login in the browser and stores them in
// /.crosspoint/wallabag.json. The on-device Wallabag screen (device.json) then
// mints a bearer token from those credentials, lists unread articles, and
// downloads each as an EPUB — Wallabag exports articles as EPUB natively, so no
// conversion is needed. Works with a self-hosted server or app.wallabag.it.
CrossPoint.registerPlugin(async (container, api) => {
  const CONFIG_PATH = '/.crosspoint/wallabag.json';

  container.innerHTML =
    '<h2>Wallabag</h2>' +
    '<p id="wb-status">Checking configuration…</p>' +
    '<div class="setting-row"><span class="setting-name">Server URL</span>' +
    '<span class="setting-control"><input type="text" id="wb-url" placeholder="https://app.wallabag.it"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Client ID</span>' +
    '<span class="setting-control"><input type="text" id="wb-cid"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Client secret</span>' +
    '<span class="setting-control"><input type="password" id="wb-csec"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Username</span>' +
    '<span class="setting-control"><input type="text" id="wb-user" autocomplete="username"></span></div>' +
    '<div class="setting-row"><span class="setting-name">Password</span>' +
    '<span class="setting-control"><input type="password" id="wb-pass" autocomplete="current-password"></span></div>' +
    '<div class="setting-row">' +
    '<button type="button" class="btn-small btn-add" id="wb-save">Save</button> ' +
    '<button type="button" class="btn-small" id="wb-test">Test</button> ' +
    '<button type="button" class="btn-small" id="wb-clear" style="display:none">Clear</button>' +
    '</div>' +
    '<p style="color:#666">Create an API client in Wallabag under Settings → API clients management ' +
    'to get the Client ID and secret. Works with app.wallabag.it or your own server. ' +
    'Credentials are stored in plain text on the SD card.</p>';

  const el = (id) => document.getElementById(id);
  const status = (t) => { el('wb-status').textContent = t; };
  const clearBtn = el('wb-clear');

  function trimUrl(u) { return u.trim().replace(/\/+$/, ''); }

  function currentConfig() {
    const url = trimUrl(el('wb-url').value);
    if (!url) throw new Error('server URL is required');
    return {
      url,
      client_id: el('wb-cid').value.trim(),
      client_secret: el('wb-csec').value.trim(),
      username: el('wb-user').value,
      password: el('wb-pass').value
    };
  }

  function writeConfig(cfg) {
    return api.writeFile(CONFIG_PATH, btoa(JSON.stringify(cfg)));
  }

  async function loadConfig() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(CONFIG_PATH));
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    } catch (e) {
      return null;
    }
  }

  el('wb-save').onclick = async () => {
    try {
      await writeConfig(currentConfig());
      clearBtn.style.display = '';
      status('Saved. Browse from the device: Settings → System → Plugins → Wallabag.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  el('wb-test').onclick = async () => {
    let cfg;
    try {
      cfg = currentConfig();
    } catch (e) {
      status('Error: ' + e.message);
      return;
    }
    status('Testing sign-in…');
    try {
      // Same OAuth2 password grant the device performs, via the relay.
      const body = JSON.stringify({
        grant_type: 'password',
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        username: cfg.username,
        password: cfg.password
      });
      const r = await api.relay('POST', cfg.url + '/oauth/v2/token',
        { 'Content-Type': 'application/json' }, body);
      let parsed = null;
      try { parsed = JSON.parse(r.body); } catch (e) {}
      if (parsed && parsed.access_token) status('Sign-in OK — token received.');
      else if (parsed && parsed.error) status('Sign-in failed: ' + (parsed.error_description || parsed.error));
      else status('Unexpected response (HTTP ' + (r.status || r.error) + ').');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  clearBtn.onclick = async () => {
    try {
      await writeConfig({});
      ['wb-url', 'wb-cid', 'wb-csec', 'wb-user', 'wb-pass'].forEach((id) => { el(id).value = ''; });
      clearBtn.style.display = 'none';
      status('Configuration cleared.');
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  const existing = await loadConfig();
  if (existing && existing.url) {
    el('wb-url').value = existing.url;
    el('wb-cid').value = existing.client_id || '';
    el('wb-csec').value = existing.client_secret || '';
    el('wb-user').value = existing.username || '';
    el('wb-pass').value = existing.password || '';
    clearBtn.style.display = '';
    status('Configured. Browse from the device, or update below.');
  } else {
    status('Not configured yet.');
  }
});
