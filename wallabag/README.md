# Wallabag

Read your Wallabag "read it later" articles on the reader. Wallabag exports each
saved article as an EPUB natively, so this works entirely on-device with no
conversion — sign in once from the web page, then browse and download articles
from Settings → System → Plugins → Wallabag. Works with a **self-hosted**
Wallabag or the hosted **app.wallabag.it**; only the server URL differs.

Ships both plugin surfaces:

- **`plugin.js`** — a Settings web-page card to enter the server URL, API client
  ID/secret, and your login, with a Test button. Saves them to
  `/.crosspoint/wallabag.json`.
- **`device.json`** — the on-device experience: lists unread articles and
  downloads a selected one as EPUB to `/Wallabag/`.

## Install

```
/.crosspoint/plugins/wallabag/     (or /plugins/wallabag/, /.plugins/wallabag/)
    manifest.json
    device.json
    plugin.js
```

## Setup

1. In Wallabag, go to **Settings → API clients management** and create a client.
   Note the **Client ID** and **Client secret**.
2. Open the device web UI → Settings → the Wallabag card.
3. Enter the **Server URL** (`https://app.wallabag.it` or your own server), the
   client ID/secret, and your Wallabag username and password.
4. Test, then Save.
5. On the reader: Settings → System → Plugins → Wallabag.

## How it works

- This uses the firmware's generic on-device engine — there is no
  Wallabag-specific firmware code, only this `device.json`.
- Auth is a **password grant** (`auth.type: "password"`): the device silently
  POSTs your stored credentials to `/oauth/v2/token`, reads the `access_token`,
  and browses/downloads with `Authorization: Bearer`. The token is short-lived;
  the engine mints a fresh one automatically each session and after any 401.
- Browsing calls `/api/entries.json?archive=0` (unread) paged 8 at a time.
- Downloading calls `/api/entries/{id}/export.epub`, streamed straight to SD.
- Credentials are stored in plain text on the SD card — treat the card
  accordingly (this matches the general plugin security model).

## Notes

- Requires a Wallabag account; app.wallabag.it needs a paid plan, self-hosting
  is free.
- Shows unread articles by default. Edit `device.json`'s `browse.url` to change
  the filter (e.g. `starred=1`).

## Clear

Use the Clear button on the web card, or delete `/.crosspoint/wallabag.json`.
