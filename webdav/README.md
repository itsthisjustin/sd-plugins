# WebDAV

Browse and download books from a WebDAV server on the reader itself — the
device-as-client many people asked for (discussion #2097). Works with
Nextcloud, ownCloud, Seafile, Koofr, and any standard WebDAV share. Koofr in
particular bridges Google Drive / Dropbox / OneDrive to WebDAV, so this covers
those too.

Ships both plugin surfaces:

- **`plugin.js`** — a Settings web-page card to enter the server URL, username,
  and password, with a Test button. Saves them to `/.crosspoint/webdav.json`.
- **`device.json`** — the on-device experience: Settings → System → Plugins →
  WebDAV. Browse folders (Confirm opens a folder, Back goes up) and download a
  book straight to `/WebDAV/` on the SD card. No computer needed after setup.

## Install

```
/.crosspoint/plugins/webdav/     (or /plugins/webdav/, /.plugins/webdav/)
    manifest.json
    device.json
    plugin.js
```

## Setup

1. Open the device web UI → Settings → the WebDAV card.
2. Enter the **Server URL** pointing at the folder to browse, ending in a slash
   (e.g. `https://dav.koofr.net/dav/Koofr/Books/` or
   `https://cloud.example.com/remote.php/dav/files/USER/Books/`).
3. Enter your username and password (for Nextcloud/ownCloud use an app
   password, not your login password).
4. Test, then Save.
5. On the reader: Settings → System → Plugins → WebDAV.

## How it works

- `device.json` uses the firmware's generic `xml` browse format: it issues
  the `PROPFIND` (Depth 1) declared in the manifest and maps the multistatus
  elements (`response`/`href`/`displayname`/`collection`) to list entries via
  field selectors. The firmware has no WebDAV-specific code — this plugin is
  pure configuration, and the same engine drives any XML list (OPDS, Atom, ...).
- Auth is HTTP Basic. `webdav.json` stores `url`, `user`, `pass`, and `auth`
  (base64 `user:pass`): the on-device browse sends `Authorization: Basic
  {cfg.auth}`, and the file download uses `{cfg.user}`/`{cfg.pass}`.
- Credentials are stored in plain text on the SD card — treat the card
  accordingly (this matches the general plugin security model).

## Limits

- One folder's listing must fit in ~48KB of device RAM (a few hundred entries);
  the engine also caps at 200 entries per folder. Split large libraries into
  subfolders on the server.
- No upload or two-way sync — this is download/browse only.

## Clear

Use the Clear button on the web card, or delete `/.crosspoint/webdav.json`.
