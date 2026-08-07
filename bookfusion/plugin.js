// BookFusion sign-in for CrossPoint. Runs the OAuth device-code flow in this
// browser (which is already the second device the flow wants) and writes the
// bearer token to the SD card, where the on-device catalog browser described
// by device.json picks it up. Browsing and downloading happen on the reader
// itself via Settings; this page only manages the sign-in.
CrossPoint.registerPlugin(async (container, api) => {
  const API_BASE = 'https://www.bookfusion.com/api/user';
  const HEADERS = { Accept: 'application/json; api_version=10', 'Content-Type': 'application/json' };
  const TOKEN_PATH = '/.crosspoint/bookfusion.json';
  const CLIENT_ID = 'koreader';

  let polling = false;

  container.innerHTML =
    '<h2>BookFusion</h2>' +
    '<p id="bf-status">Checking sign-in state…</p>' +
    '<div id="bf-code" style="display:none">' +
    '<p>On any device, open <strong id="bf-url"></strong> and enter:</p>' +
    '<p style="font-size:1.6em;letter-spacing:0.2em;text-align:center"><strong id="bf-user-code"></strong></p>' +
    '</div>' +
    '<div class="setting-row">' +
    '<button type="button" class="btn-small btn-add" id="bf-signin">Sign in</button> ' +
    '<button type="button" class="btn-small" id="bf-signout" style="display:none">Sign out</button>' +
    '</div>' +
    '<p style="color:#666">Once signed in, your library appears on the device under Settings &gt; System &gt; BookFusion.</p>';

  const statusEl = document.getElementById('bf-status');
  const codeBox = document.getElementById('bf-code');
  const signinBtn = document.getElementById('bf-signin');
  const signoutBtn = document.getElementById('bf-signout');
  const status = (text) => { statusEl.textContent = text; };

  function writeToken(token) {
    const body = JSON.stringify(token ? { token } : {});
    return api.writeFile(TOKEN_PATH, btoa(body));
  }

  async function hasToken() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(TOKEN_PATH));
      if (!r.ok) return false;
      const parsed = JSON.parse(await r.text());
      return !!parsed.token;
    } catch (e) {
      return false;
    }
  }

  function showSignedIn(signedIn) {
    signinBtn.style.display = signedIn ? 'none' : '';
    signoutBtn.style.display = signedIn ? '' : 'none';
    codeBox.style.display = 'none';
    status(signedIn ? 'Signed in. Browse your library from the device.' : 'Not signed in.');
  }

  async function relayJson(url, body) {
    const r = await api.relay('POST', url, HEADERS, JSON.stringify(body));
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    return { status: r.status, json: parsed };
  }

  signinBtn.onclick = async () => {
    if (polling) return;
    polling = true;
    signinBtn.disabled = true;
    try {
      status('Requesting device code…');
      const dev = await relayJson(API_BASE + '/auth/device', { client_id: CLIENT_ID });
      if (!dev.json || !dev.json.device_code) throw new Error('device code request failed (HTTP ' + dev.status + ')');
      document.getElementById('bf-url').textContent = dev.json.verification_uri || 'bookfusion.com/device';
      document.getElementById('bf-user-code').textContent = dev.json.user_code || '';
      codeBox.style.display = '';
      status('Waiting for you to authorize this device…');

      const intervalMs = Math.max(3, dev.json.interval || 5) * 1000;
      const deadline = Date.now() + Math.max(60, dev.json.expires_in || 900) * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const poll = await relayJson(API_BASE + '/auth/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: dev.json.device_code
        });
        if (poll.json && poll.json.access_token) {
          status('Saving token to the device…');
          await writeToken(poll.json.access_token);
          showSignedIn(true);
          return;
        }
        const code = (poll.json && poll.json.error) || '';
        if (code === 'expired_token' || code === 'access_denied') {
          throw new Error(code === 'access_denied' ? 'authorization was denied' : 'the code expired; try again');
        }
        // authorization_pending / slow_down / transient errors: keep polling
      }
      throw new Error('the code expired; try again');
    } catch (e) {
      codeBox.style.display = 'none';
      status('Error: ' + e.message);
    } finally {
      polling = false;
      signinBtn.disabled = false;
    }
  };

  signoutBtn.onclick = async () => {
    try {
      await writeToken(null);
      showSignedIn(false);
    } catch (e) {
      status('Error: ' + e.message);
    }
  };

  showSignedIn(await hasToken());
});
