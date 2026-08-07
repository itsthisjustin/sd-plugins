# Plugin Store

A plugin that installs other plugins. It reads a hosted catalog and writes a
chosen plugin's files into `/.crosspoint/plugins/<name>/` on the SD card — so
you can add plugins without pulling the card or copying files by hand.

Runs in the web Settings page (it needs a browser to loop over each file). A
future on-device version is possible: the catalog is a plain JSON list the
on-device engine can already browse, and "install" is just create-a-folder +
download-each-small-file (no zip needed).

## Install

```
/.crosspoint/plugins/plugin-store/
    manifest.json
    plugin.js
```

Open the device web UI → **Settings** page → the Plugin Store card.

## Use

1. Under **Stores**, add one or more **catalog URLs** — GitHub raw links, your
   own host, anywhere. Multiple stores are supported: each is fetched and its
   plugins are listed under its own heading, so one Plugin Store aggregates
   several independent catalogs. The list is saved to
   `/.crosspoint/plugin-store.json`.
2. Add a URL in the field and press **Add store**; **Save & refresh** persists
   the list and reloads. A broken store URL is reported but doesn't stop the
   others.
3. Each plugin shows title, author, and description with **Install** /
   **Reinstall** / **Remove**.
4. Install writes the plugin's files to the SD card; reconnect or reopen
   Settings and the new plugin appears (and on-device under Settings → System →
   Plugins if it ships a `device.json`).

## Catalog format

Full spec: [`../CATALOG.md`](../CATALOG.md). In brief:


A JSON document with an optional `name` (shown as the store heading) and a
`plugins` array. Each entry lists a base URL and the files to fetch:

```json
{
  "name": "My Plugin Store",
  "plugins": [
    {
      "name": "wallabag",
      "title": "Wallabag",
      "description": "Read your saved articles as EPUB.",
      "author": "you",
      "base": "https://raw.githubusercontent.com/OWNER/REPO/main/wallabag/",
      "files": ["manifest.json", "device.json", "plugin.js", "README.md"]
    }
  ]
}
```

Publishing a plugin = adding an entry to a catalog and hosting its files
(a Git repo's raw URLs work fine). Anyone can host their own catalog and share
its URL; users add it as another store. No firmware change, ever.

## How it works

Uses only existing device capabilities: `api.relay` to fetch the catalog
(the device makes the request, so no CORS), `/mkdir` to create the folder,
`api.fetchToSd` to stream each plugin file straight to SD, and `/delete` to
remove. Files install one at a time (the button shows `2/4` progress).
`fetchToSd` has no size cap, so large `plugin.js` files install fine — unlike
the relay, which is capped at 32 KB.
