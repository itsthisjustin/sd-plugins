# Plugin Store

Browse and install CrossPoint plugins from a hosted catalog — no need to pull
the SD card or copy files by hand.

## Use from a browser

1. Open the device web page → **Settings** → the Plugin Store card.
2. Under **Stores**, add one or more **catalog URLs** (a GitHub raw link, your
   own host, anywhere), tap **Add store**, then **Save & refresh**. You can add
   several stores; each lists its plugins under its own heading.
3. Each plugin shows its title, author, and description with **Install** /
   **Reinstall** / **Remove**. Install writes the plugin to the SD card.
4. Reconnect or reopen Settings and the new plugin is ready. If it has an
   on-device screen, it also appears under **Settings → System → Plugins**.

## Use on the reader

The store also runs on the device itself: **Settings → System → Plugins →
Plugin Store → Run Plugin**. Browse the catalog and press Confirm to install a
plugin straight to the SD card. (On the reader it installs from the catalog
built into the plugin; add and manage multiple stores from the browser.)

## Publish your own plugins

Host your plugin's files anywhere (a Git repo's raw URLs work fine) and add an
entry for it to a catalog JSON file. Anyone can host a catalog and share its
URL; users add it as another store — no firmware change needed. See
[`../CATALOG.md`](../CATALOG.md) for the catalog format.
