// Minimal browser-side plugin — proves the SD-card plugin loader end to end.
// Copy this folder to /.crosspoint/plugins/hello/ on the SD card; the settings
// page discovers it via /api/plugins, serves it via /plugin, and runs it here.
CrossPoint.registerPlugin((container, api) => {
  container.innerHTML =
    '<h2>Hello from the SD card 👋</h2>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0;">' +
    'This card is rendered by <code>plugin.js</code> loaded from ' +
    '<code>/.crosspoint/plugins/hello/</code>. The device discovered it, served ' +
    'it, and the settings page ran it — no firmware changes needed to add a plugin.</p>';
});
