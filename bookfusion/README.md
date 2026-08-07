# BookFusion

Connects CrossPoint to a BookFusion library. Ships both plugin surfaces:

- **`device.json`** — the on-device experience: Settings → System → Plugins →
  BookFusion on the reader. First use shows a sign-in screen (verification URL,
  user code, and QR — authorize from any phone or computer); after that it
  lists your library eight books per page and downloads straight to
  `/BookFusion/` on the SD card. Everything it does is declared as data and
  interpreted by the firmware's generic catalog activity — no BookFusion code
  runs on the device.
- **`plugin.js`** — the same sign-in from the web Settings page, for people who
  prefer doing it from a browser. Either path writes the same token file
  (`/.crosspoint/bookfusion.json`), so sign in once from wherever is handy.

## Install

Copy this folder to the SD card:

```
/.crosspoint/plugins/bookfusion/
    manifest.json
    device.json
    plugin.js
```

## How it works

- Auth is the OAuth 2.0 device-code flow against the BookFusion API (the same
  `koreader` client id the official KOReader plugin uses).
- Browsing calls `POST /api/user/books/search` with `per_page` set to one more
  than the display page, so the extra row signals whether another page exists
  (keeps each response ~20KB, inside the reader's heap budget).
- Downloading asks `POST /api/user/books/{id}/download` for a pre-signed URL,
  then streams the file to SD.
- After each download a sidecar `/.crosspoint/bookfusion_<md5-of-path>.json`
  with the BookFusion `book_id` is written — the same scheme the KOReader
  plugin uses — so a future reading-progress sync stage can match files to
  library entries.
- The token is stored in plain JSON (`{"token": "..."}`). Anyone with the SD
  card can read it; treat the card accordingly (this matches the general
  plugin security model — see the repository README).

## Sign out

Use the Sign out button on the web Settings card, or delete
`/.crosspoint/bookfusion.json` from the SD card.
