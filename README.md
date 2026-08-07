# CrossPoint SD-card plugins

Browser-side plugins the CrossPoint web UI loads from the SD card. Each is just
JS + a manifest — **no firmware changes to add one.** The device discovers them,
serves them, injects them into a page, and backs them with generic device
capabilities (an outbound HTTP(S) relay, crypto primitives, SD read/write, and
URL-to-SD download).

A plugin can extend either the **File Manager** or the **Settings** page — its
`manifest.json` `mount` decides which. That makes them useful for things like
tidying a library (sort books into folders by author), batch-optimizing or
renaming files, or opening protected content from an online provider.

## Install

Copy a plugin folder to the SD card under any of these roots:

```
/.crosspoint/plugins/<name>/     or   /plugins/<name>/   or   /.plugins/<name>/
    manifest.json     (optional)
    plugin.js         (optional)
    device.json       (optional)
    ...any other assets
```

All three roots are scanned; `/plugins/` and `/.plugins/` at the card root are
just easier to reach when copying from a computer. If the same plugin name
exists in more than one root, the earlier one in the list above wins.

Reconnect to the device web UI; the plugin's card appears on its page. A
`device.json` also appears on the reader under Settings → System → Plugins.

## Layout of this folder

- `hello/` — minimal example; proves the loader end to end (no network).
- `organize-by-author/` — a File Manager plugin: reads each EPUB in the current
  folder and files it into a per-author subfolder. Uses only the same-origin
  File Manager endpoints and the JSZip the page already loads — a good template
  for "operate on the files I'm looking at" plugins. EPUB 2 and EPUB 3 creator
  sort names are supported; reading progress, cache data, and visible
  `.epub.rights` sidecars move with their book.
- `bookfusion/` — a Settings plugin + `device.json` pair: sign in to
  BookFusion from the web page or on the reader itself (device-code flow with
  QR), then browse and download your library on-device under Settings >
  System > Plugins. Writes per-book sidecars for a future progress-sync stage.
- `webdav/` — a Settings plugin + `device.json` pair: enter a WebDAV server
  URL and credentials in the web page (stored in `/.crosspoint/webdav.json`),
  then browse folders and download books on the reader itself under Settings >
  System > Plugins. Works with Nextcloud, ownCloud, Seafile, Koofr, and any
  standard WebDAV share.
- `protected-content/` — a File Manager plugin that connects the reader to a
  protected-content provider, using the device relay + crypto. It detects an
  existing `/.crosspoint/content.key`, restores its fulfillment session, and lists
  `.acsm` files uploaded into the folder currently being viewed. Full flow:
  activate the device
  (identity → bootstrap → sign-in → activate, writing `/.crosspoint/content.key`),
  then fulfills a selected `.acsm` uploaded through the File Manager — the
  device downloads the book to the SD-card root, writes a `<book>.epub.rights`
  sidecar the reader decrypts on-device, and deletes the `.acsm` after the
  complete operation succeeds. The request-signing canonicalization follows the
  reference implementation.

### Protected Content example limitations

- Credentials created by an older plugin version are detected, but need one
  reactivation to add the persisted fulfillment session. The reader ignores
  those additional forward-compatible fields.
- The final EPUB download URL must return the file directly. The device streams
  that response to SD and does not currently follow a redirect from `/api/fetch`.
- The smoke suite exercises the complete protocol shape with mocked services;
  a real account and authorization file are still needed for a live service test.

## Development

The examples have a dependency-free Node smoke suite:

```sh
npm test
```

It exercises plugin registration, author metadata parsing, protected-book
sidecar moves, account activation, fulfillment, unique download names, the
one-time credential write, and rights writes with mocked device APIs.

## Security model

Plugins are JavaScript loaded into the File Manager or Settings page, not an
isolated iframe. They can call the same-origin web API and any generic device
capabilities exposed by the host. Install only plugins whose source you trust,
because network relay and download requests are unrestricted. Never put secrets
in a plugin folder.

## Contract

**manifest.json** (optional):
```json
{
  "title": "Sort EPUBs by author",   // card heading; defaults to the folder name
  "mount": "files"                   // "files" (File Manager) or "settings"
}
```

**plugin.js** registers a render function; the host calls it with a container and an api:
```js
CrossPoint.registerPlugin((container, api) => {
  container.innerHTML = '<h2>My plugin</h2>...';
  // api.name                              -> this plugin's name
  // api.relay(method, url, headers, body) -> { status, body, headers }
  //     device makes the HTTP(S) call (browsers can't, due to CORS);
  //     request headers are an object; response headers are an ordered list of
  //     [name, value] pairs with duplicates preserved (including every
  //     Set-Cookie).
  // api.cookiesFrom(resp, existing?)      -> a "k=v; k2=v2" Cookie string,
  //     built from a relay response's Set-Cookie headers (carry a session
  //     across requests). Generic: it just reads the standard header.
  // api.crypto(op, fields)                -> wolfSSL primitive (base64 I/O)
  // api.writeFile(path, dataB64)          -> write a small file to SD
  // api.fetchToSd(url, dest, headers)     -> device downloads a URL to SD
  // api.pluginFile(file)                  -> URL to another file in this plugin folder
  // api.registerAction(name, fn)          -> expose an action external systems can
  //     trigger through the device job queue (POST /api/plugin-jobs). fn(args)
  //     runs in this page whenever it is open (including /plugins-run); return a
  //     small result object, or throw to fail the job.
});
```

A File Manager plugin can also just call the same-origin endpoints the page
already uses (`/api/files`, `/mkdir`, `/move`, `/download`) — see
`organize-by-author/` — so many plugins need nothing from the device api at all.

## Firmware endpoints (generic, scheme-neutral)

| Endpoint | Purpose |
|---|---|
| `GET /api/plugins` | list discovered plugins (name/title/mount) |
| `GET /plugin?name=&file=` | serve a file from a plugin folder |
| `POST /api/relay` | device performs an outbound HTTP(S) call for a plugin (any method, incl. PROPFIND) |
| `POST /api/crypto` | generic crypto primitive — hash, random, AES, RSA, PKCS#12 (base64 I/O) |
| `POST /api/fetch` | device downloads a URL straight to SD |
| `POST /api/plugin-fs` | plugin writes a small file to SD |
| `POST /api/plugin-jobs` (+ `/claim`, `/complete`, `/status`) | job queue: external systems trigger registered plugin actions |
| `GET /plugins-run` | headless page that executes queued jobs while open |

## On-device screens (`device.json`)

A plugin can also ship a `device.json` describing an on-device catalog screen
(sign in via OAuth device-code, browse an authenticated JSON API, download to
SD, write per-book sidecars) that appears under **Settings > System >
Plugins** on the reader itself, no phone needed once set up. The manifest is
pure data; the firmware interprets it with one generic activity. Schema
reference: `docs/sd-plugins.md` in the crosspoint-reader repository. See
`bookfusion/` for a complete example that ships both `plugin.js` (browser
sign-in) and `device.json` (on-device sign-in + library browsing).
