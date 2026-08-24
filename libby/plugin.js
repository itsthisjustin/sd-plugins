// Libby (OverDrive) integration for CrossPoint.
//
// This plugin owns everything Libby-specific: linking the account, listing
// loans, fetching a loan's fulfillment token (.acsm) on demand, and returning.
// It deliberately does NOT contain the Adobe DRM crypto. When a book needs
// fulfilling, this plugin writes the .acsm to SD and hands it to the generic
// `protected-content` plugin (which does the ADEPT activation / fulfillment /
// decryption) by enqueueing a job. That keeps the crypto in one place and this
// plugin a thin Libby API layer.
//
// Linking runs here in the browser (not on the device): Libby's setup-code
// clone flow needs a per-chip Accept-Language header and a missing_chip retry
// that the device's declarative manifest engine cannot express. Once linked,
// the authenticated identity is saved to SD and the device browses loans and
// fetches .acsm files itself (device.json), since /chip/sync needs only the
// bearer token.
//
// Transport: all Libby calls go through api.relay (the device proxies them, so
// there is no CORS problem and no per-page token leakage). Note relay caps a
// response at 32KB; a very large loans list could be truncated.

CrossPoint.registerPlugin(async (container, api) => {
  const SENTRY = 'https://sentry.libbyapp.com';
  const CLIENT = 'd:22.1.0';  // the `c` query on /chip, mirroring the Libby web app
  const ADOBE_EPUB_FORMAT = 'ebook-epub-adobe';
  const IDENTITY_FILE = '/.crosspoint/libby.json';
  // Where the device stages a batch of loans it wants fulfilled (written by the
  // on-device flow; drained by the fulfill-loans action).
  const PENDING_FILE = '/.crosspoint/libby-pending.json';
  // Maps a sent loan id -> the .epub path on the card, so a renewal can refresh
  // that book's rights sidecar in place instead of re-downloading it.
  const BOOKS_FILE = '/.crosspoint/libby-books.json';

  const te = new TextEncoder();
  const b64 = (str) => {
    const bytes = te.encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  // --- Libby transport -------------------------------------------------------

  // Libby's Sentry API requires an Accept-Language header derived from the chip:
  // keep only a-z, reverse, take characters 5-6. POST /chip/clone is rejected
  // with missing_chip when it is absent. The pre-mint (identity-less) call uses
  // a fixed seed, matching the web app.
  function acceptLanguage(identity) {
    const seed = identity && identity.length ? identity : 'cudlkahllcnsjxhbmddl';
    let letters = '';
    for (const ch of seed) if (ch >= 'a' && ch <= 'z') letters += ch;
    return letters.split('').reverse().join('').slice(4, 6);
  }

  // The v= query on a chip refresh is the first segment of the chip UUID, read
  // from the JWT payload (chip.id).
  function shortChipId(identity) {
    const seg = identity.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(seg)).chip.id.split('-')[0];
  }

  async function sentry(method, path, bearer, jsonBody) {
    const headers = {
      'Accept': 'application/json',
      'Referer': 'https://libbyapp.com/',
      'Origin': 'https://libbyapp.com',
      'Accept-Language': acceptLanguage(bearer),
    };
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
    let body = '';
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }
    const r = await api.relay(method, SENTRY + path, headers, body);
    if (r.error) throw new Error('relay: ' + r.error);
    let parsed = null;
    try { parsed = r.body ? JSON.parse(r.body) : null; } catch (e) { /* non-JSON */ }
    return { status: r.status, body: parsed, raw: r.body };
  }

  // --- account state ---------------------------------------------------------

  let identity = null;  // the authenticated Libby chip (a JWT)

  async function loadIdentity() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(IDENTITY_FILE));
      if (!r.ok) return null;
      const doc = JSON.parse(await r.text());
      return (doc && typeof doc.identity === 'string') ? doc.identity : null;
    } catch (e) { return null; }
  }

  async function saveIdentity(id) {
    identity = id;
    await api.writeFile(IDENTITY_FILE, b64(JSON.stringify({ identity: id })));
  }

  // The loan endpoints (fulfill, renew, return) can answer a valid identity with
  // 403 missing_chip; re-registering the chip and retrying clears it. Persists
  // the refreshed identity so later calls reuse it.
  async function refreshChip() {
    const r = await sentry('POST', '/chip?c=' + CLIENT + '&s=0&v=' + shortChipId(identity), identity);
    if (r.status !== 200 || !r.body || !r.body.identity) return false;
    await saveIdentity(r.body.identity);
    return true;
  }

  // --- linking (setup-code clone flow) --------------------------------------
  // 1) mint an anonymous chip, 2) request an 8-digit setup code, 3) poll until
  // the user enters it in Libby (Copy To Another Device), 4) clone the blessed
  // account onto our chip and save the authenticated identity.

  async function mintChip() {
    const r = await sentry('POST', '/chip?c=' + CLIENT + '&s=0', null);
    if (r.status !== 200 || !r.body || !r.body.identity) {
      throw new Error('could not mint a Libby chip (HTTP ' + r.status + ')');
    }
    return r.body.identity;
  }

  async function requestCode(chip) {
    const r = await sentry('GET', '/chip/clone/code?code=&role=pointer', chip);
    if (r.status !== 200 || !r.body || !r.body.code) {
      throw new Error('could not get a setup code (HTTP ' + r.status + ')');
    }
    return r.body.code;  // 8-digit string, valid ~60s
  }

  async function pollBlessing(chip, code) {
    const r = await sentry('GET', '/chip/clone/code?code=' + encodeURIComponent(code) + '&role=pointer', chip);
    if (r.status !== 200 || !r.body) return null;
    return (r.body.result === 'fulfilled' && r.body.blessing) ? r.body.blessing : null;
  }

  // Trade the polled blessing for an authenticated identity. The first clone
  // always returns missing_chip; re-registering the chip (v=<short id>) and
  // retrying with the refreshed token yields result:"cloned". A final refresh
  // returns the authenticated identity that /chip/sync accepts.
  async function completeClone(chip, blessing) {
    const sid = shortChipId(chip);
    let token = chip;
    let r = await sentry('POST', '/chip/clone', token, { blessing });
    if (r.status === 403 && r.body && r.body.result === 'missing_chip') {
      const refreshed = await sentry('POST', '/chip?c=' + CLIENT + '&s=0&v=' + sid, token);
      if (refreshed.status !== 200 || !refreshed.body || !refreshed.body.identity) {
        throw new Error('chip refresh failed (HTTP ' + refreshed.status + ')');
      }
      token = refreshed.body.identity;
      r = await sentry('POST', '/chip/clone', token, { blessing });
    }
    if (r.status !== 200 || !r.body || r.body.result !== 'cloned') {
      throw new Error('Libby clone failed (HTTP ' + r.status + ')');
    }
    const final = await sentry('POST', '/chip?c=' + CLIENT + '&s=0&v=' + sid, token);
    if (final.status !== 200 || !final.body || !final.body.identity) {
      throw new Error('post-clone chip refresh failed (HTTP ' + final.status + ')');
    }
    return final.body.identity;  // authenticated identity
  }

  // Runs the full link flow, driving the UI callback with the code to show.
  async function link(onCode) {
    const chip = await mintChip();
    const code = await requestCode(chip);
    onCode(code);
    // Codes expire in ~60s; poll until the user enters it in Libby.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const blessing = await pollBlessing(chip, code);
      if (blessing) {
        await saveIdentity(await completeClone(chip, blessing));
        return true;
      }
    }
    throw new Error('setup code expired before it was entered');
  }

  // --- loans -----------------------------------------------------------------

  async function getLoans() {
    if (!identity) throw new Error('not linked to Libby');
    const r = await sentry('GET', '/chip/sync', identity);
    if (r.status !== 200 || !r.body) throw new Error('Libby sync failed (HTTP ' + r.status + ')');
    return Array.isArray(r.body.loans) ? r.body.loans : [];
  }

  function pickAdobeEpubFormat(loan) {
    const formats = (loan.formats || []).map((f) => String(f.id || ''));
    if (formats.indexOf(ADOBE_EPUB_FORMAT) !== -1) return ADOBE_EPUB_FORMAT;
    const adobe = formats.find((id) => id.indexOf('epub') !== -1 && id.indexOf('adobe') !== -1);
    if (adobe) return adobe;
    throw new Error('no Adobe EPUB format for "' + (loan.title || loan.id) + '"');
  }

  // Ask Libby to fulfill a loan; returns the .acsm text. This is the on-demand
  // fulfillment token generation — the user never handles a file.
  async function fetchAcsm(loan) {
    const format = pickAdobeEpubFormat(loan);
    const path = '/card/' + loan.cardId + '/loan/' + loan.id + '/fulfill/' + format;
    let r = await sentry('GET', path, identity);
    if (r.status === 403 && r.body && r.body.result === 'missing_chip' && await refreshChip()) {
      r = await sentry('GET', path, identity);
    }
    if (r.status !== 200 || !r.body || !r.body.fulfill || !r.body.fulfill.href) {
      throw new Error('Libby fulfillment failed (HTTP ' + r.status +
        (r.body && r.body.result ? ' ' + r.body.result : '') + ')');
    }
    // The href points at the actual .acsm; fetch it through the relay too.
    const acsm = await api.relay('GET', r.body.fulfill.href, { 'Accept': '*/*' }, '');
    if (acsm.error || acsm.status !== 200 || !acsm.body) throw new Error('could not download the fulfillment token');
    return acsm.body;
  }

  // Renew (extend) a loan on Libby. PUT extends the same loan resource that POST
  // borrows; Libby only allows it inside the renewal window and when no one is
  // waiting, so a refused renewal surfaces as a non-2xx.
  async function renewLoan(loan) {
    const path = '/card/' + loan.cardId + '/loan/' + loan.id;
    let r = await sentry('PUT', path, identity, {});
    if (r.status === 403 && r.body && r.body.result === 'missing_chip' && await refreshChip()) {
      r = await sentry('PUT', path, identity, {});
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error('Libby renew failed (HTTP ' + r.status +
        (r.body && r.body.result ? ' ' + r.body.result : '') + ')');
    }
    return true;
  }

  async function returnLoan(loan) {
    const path = '/card/' + loan.cardId + '/loan/' + loan.id;
    let r = await sentry('DELETE', path, identity);
    if (r.status === 403 && r.body && r.body.result === 'missing_chip' && await refreshChip()) {
      r = await sentry('DELETE', path, identity);
    }
    if (r.status < 200 || r.status >= 300) throw new Error('Libby return failed (HTTP ' + r.status + ')');
    return true;
  }

  // Fulfill one loan end to end: fetch the .acsm, stage it on SD, and hand it to
  // the generic protected-content plugin to do the Adobe crypto + download.
  async function fulfillLoan(loan, destDir) {
    const acsm = await fetchAcsm(loan);
    const dir = destDir || '/Libby';
    // A visible name (no leading dot): /download refuses hidden files, and
    // protected-content reads the .acsm back before deleting it post-fulfill.
    const acsmPath = dir.replace(/\/+$/, '') + '/libby-' + loan.id + '.acsm';
    await api.writeFile(acsmPath, b64(acsm));
    // Reuse protected-content's fulfillment (Adobe crypto) via the job queue.
    const res = await (await fetch('/api/plugin-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: 'protected-content', action: 'fulfill', args: { path: acsmPath } }),
    })).json();
    return res.id;  // caller polls /api/plugin-jobs/status?id=
  }

  // --- sent-book map (for in-place renewal) ---------------------------------

  async function loadBookMap() {
    try {
      const r = await fetch('/download?path=' + encodeURIComponent(BOOKS_FILE));
      if (!r.ok) return {};
      const doc = JSON.parse(await r.text());
      return (doc && typeof doc === 'object') ? doc : {};
    } catch (e) { return {}; }
  }

  async function recordBook(loanId, dest) {
    if (!dest) return;
    const map = await loadBookMap();
    map[String(loanId)] = dest;
    await api.writeFile(BOOKS_FILE, b64(JSON.stringify(map)));
  }

  // Renew a loan and refresh only its rights: extend on Libby, fetch a fresh
  // .acsm carrying the new period, then hand protected-content the book already
  // on the card so it rewrites the .rights sidecar without re-downloading.
  async function renewToDevice(loan) {
    await renewLoan(loan);
    const bookPath = (await loadBookMap())[String(loan.id)];
    if (!bookPath) {
      throw new Error('renewed on Libby, but this book was not sent from here — use Send to device to refresh its rights');
    }
    const acsm = await fetchAcsm(loan);
    const acsmPath = '/Libby/libby-' + loan.id + '.acsm';
    await api.writeFile(acsmPath, b64(acsm));
    const res = await (await fetch('/api/plugin-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: 'protected-content', action: 'renew', args: { book: bookPath, acsm: acsmPath } }),
    })).json();
    return res.id;
  }

  // --- headless actions (job queue) -----------------------------------------
  // The on-device flow writes PENDING_FILE and brings up the web server; this
  // action drains it. Enqueue from the device with:
  //   POST /api/plugin-jobs {plugin:"libby", action:"fulfill-loans"}
  if (api.registerAction) {
    api.registerAction('fulfill-loans', async () => {
      identity = await loadIdentity();
      if (!identity) throw new Error('not linked to Libby');
      let pending = [];
      try {
        const r = await fetch('/download?path=' + encodeURIComponent(PENDING_FILE));
        if (r.ok) pending = JSON.parse(await r.text());
      } catch (e) { /* nothing staged */ }
      if (!Array.isArray(pending) || pending.length === 0) return { fulfilled: 0 };
      const loans = await getLoans();
      const byId = {};
      for (const l of loans) byId[String(l.id)] = l;
      let n = 0;
      for (const entry of pending) {
        const loan = byId[String(entry.id)];
        if (loan) { await fulfillLoan(loan, entry.dest_dir); n++; }
      }
      // Clear the staged batch once queued.
      await deleteFile(PENDING_FILE);
      return { fulfilled: n };
    });

    api.registerAction('return-loan', async (args) => {
      identity = await loadIdentity();
      if (!identity) throw new Error('not linked to Libby');
      const loans = await getLoans();
      const loan = loans.find((l) => String(l.id) === String(args && args.id));
      if (!loan) throw new Error('loan not found: ' + (args && args.id));
      await returnLoan(loan);
      return { returned: loan.id };
    });
  }

  async function deleteFile(path) {
    try {
      await fetch('/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'path=' + encodeURIComponent(path),
      });
    } catch (e) { /* best effort */ }
  }

  // --- web UI ----------------------------------------------------------------
  // Linking happens here (the device cannot run the clone flow). Once linked,
  // the device browses and downloads loans itself; this page also lists them.

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  container.innerHTML =
    '<h2>Libby</h2>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;">' +
    'Link your Libby account, then send a loan to the device as an EPUB right from ' +
    'here — the Adobe fulfillment runs in this page. Once linked, the device can ' +
    'also browse your loans on its own; it stores only the account token.</p>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;' +
    'padding:8px 10px;border:1px solid var(--border-color,#ddd);border-radius:4px;">' +
    '<strong>Requires the Protected Content plugin</strong> for the Adobe ' +
    'fulfillment step. Install and activate it once so the device holds its ' +
    'credential.</p>' +
    '<div id="libby-account-state" style="margin-bottom:12px;color:var(--label-color);font-size:0.9em;">' +
    'Checking the SD card for a linked account…</div>' +
    '<div style="text-align:center;">' +
    '<button type="button" class="btn-small btn-add" id="libby-link">Link Libby account</button></div>' +
    '<div id="libby-code" style="margin-top:12px;text-align:center;font-size:1.6em;' +
    'letter-spacing:0.18em;font-weight:600;color:var(--accent-color);"></div>' +
    '<div id="libby-status" style="margin-top:12px;color:var(--label-color);font-size:0.9em;white-space:pre-line;"></div>' +
    '<hr style="margin:16px 0;border:none;border-top:1px solid var(--border-color,#ddd)">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">' +
    '<label class="setting-name" style="margin:0;">Your loans</label>' +
    '<a href="#" id="libby-refresh" style="display:none;color:var(--accent-color);font-size:0.85em;">Refresh</a></div>' +
    '<div id="libby-loans" style="color:var(--label-color);font-size:0.9em;">Not linked yet.</div>';

  const accountState = document.getElementById('libby-account-state');
  const codeEl = document.getElementById('libby-code');
  const statusEl = document.getElementById('libby-status');
  const loansEl = document.getElementById('libby-loans');
  const linkBtn = document.getElementById('libby-link');
  const refreshLink = document.getElementById('libby-refresh');
  function setStatus(t) { statusEl.textContent = t || ''; }
  function setCode(t) { codeEl.textContent = t || ''; }

  refreshLink.onclick = (e) => { e.preventDefault(); if (identity) showLoans(); };

  function renderLoans(loans) {
    loansEl.innerHTML = '';
    if (!loans.length) { loansEl.textContent = 'No current loans.'; return; }
    for (const loan of loans) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;' +
        'border-bottom:1px solid var(--border-color,#eee);';
      const meta = document.createElement('div');
      meta.style.cssText = 'flex:1;min-width:0;';
      meta.innerHTML =
        '<div style="font-weight:600;">' + escapeHtml(loan.title || loan.id) + '</div>' +
        '<div style="font-size:0.85em;">' + escapeHtml(loan.firstCreatorName || '') + '</div>';
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex:none;';
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'btn-small btn-add';
      sendBtn.textContent = 'Send to device';
      const renewBtn = document.createElement('button');
      renewBtn.type = 'button';
      renewBtn.className = 'btn-small';
      renewBtn.textContent = 'Renew';
      sendBtn.onclick = () => downloadLoan(loan, sendBtn);
      renewBtn.onclick = () => renewOne(loan, renewBtn);
      actions.appendChild(sendBtn);
      actions.appendChild(renewBtn);
      row.appendChild(meta);
      row.appendChild(actions);
      loansEl.appendChild(row);
    }
  }

  // Poll a queued protected-content job to completion. Its poller (running on
  // this same File Manager page) claims and executes it; the slot may be
  // recycled shortly after finishing, so a post-active "unknown" counts as done.
  async function waitForJob(id) {
    let seenActive = false;
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      let s;
      try { s = await (await fetch('/api/plugin-jobs/status?id=' + encodeURIComponent(id))).json(); }
      catch (e) { continue; }
      if (s.state === 'pending' || s.state === 'running') { seenActive = true; continue; }
      if (s.state === 'done') return s.result || {};
      if (s.state === 'error') throw new Error((s.result && s.result.error) || 'fulfillment failed');
      if (s.state === 'unknown') {
        if (seenActive) return {};
        if (i > 3) throw new Error('fulfillment did not run — is the Protected Content plugin installed and activated?');
      }
    }
    throw new Error('timed out waiting for fulfillment');
  }

  // Fetch the loan's .acsm and hand it to protected-content, which does the
  // Adobe fulfillment and lands the decrypted EPUB on the card. This is the full
  // path the device can't do alone — the browser runs the crypto.
  async function downloadLoan(loan, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    setStatus('Fetching “' + (loan.title || loan.id) + '” from Libby…');
    try {
      const jobId = await fulfillLoan(loan);
      const result = await waitForJob(jobId);
      await recordBook(loan.id, result.dest);
      btn.textContent = 'Sent';
      setStatus('Sent “' + (result.title || loan.title || loan.id) + '” to the device' +
        (result.dest ? ' (' + result.dest + ')' : '') + '.');
    } catch (e) {
      btn.textContent = original;
      btn.disabled = false;
      setStatus('Could not send “' + (loan.title || loan.id) + '”: ' + e.message);
    }
  }

  // Extend the loan on Libby and refresh the book's rights sidecar in place.
  async function renewOne(loan, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Renewing…';
    setStatus('Renewing “' + (loan.title || loan.id) + '” on Libby…');
    try {
      const jobId = await renewToDevice(loan);
      const result = await waitForJob(jobId);
      btn.textContent = 'Renewed';
      setStatus('Renewed “' + (result.title || loan.title || loan.id) +
        '” and refreshed its rights on the device.');
    } catch (e) {
      btn.textContent = original;
      btn.disabled = false;
      setStatus('Could not renew “' + (loan.title || loan.id) + '”: ' + e.message);
    }
  }

  async function showLoans() {
    refreshLink.style.display = '';
    loansEl.textContent = 'Loading loans…';
    try {
      const loans = await getLoans();
      accountState.textContent = 'Linked — ' + loans.length + ' loan' + (loans.length === 1 ? '' : 's') + '.';
      renderLoans(loans);
    } catch (e) {
      loansEl.textContent = 'Could not load loans: ' + e.message;
    }
  }

  linkBtn.onclick = async () => {
    linkBtn.disabled = true;
    setStatus('Requesting a setup code…');
    setCode('');
    try {
      await link((code) => {
        setCode(code);
        setStatus('In the Libby app, open Copy To Another Device → Enter Setup Code, ' +
          'then type the code above. It expires in about a minute.');
      });
      setCode('');
      setStatus('Linked.');
      linkBtn.textContent = 'Re-link account';
      await showLoans();
    } catch (e) {
      setCode('');
      setStatus('Link failed: ' + e.message);
    } finally {
      linkBtn.disabled = false;
    }
  };

  identity = await loadIdentity();
  if (identity) {
    accountState.textContent = 'Linked — a Libby account token is stored on this SD card.';
    linkBtn.textContent = 'Re-link account';
    await showLoans();
  } else {
    accountState.textContent = 'No Libby account linked on this SD card yet.';
    loansEl.textContent = 'Not linked yet.';
  }
});
