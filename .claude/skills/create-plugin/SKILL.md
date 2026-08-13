---
name: create-plugin
description: Create a new CrossPoint SD-card plugin in this repo — browser plugin.js, on-device device.json, store catalog entry, tests, and README. Use when the user wants to build, scaffold, or extend a plugin for the CrossPoint reader.
---

# Create a CrossPoint plugin

A plugin is a folder of static files the reader serves from the SD card — no
firmware changes, no build step. Two surfaces, use either or both:

- **`plugin.js`** — runs in the browser on the device's web UI (File Manager
  or Settings page, chosen by `manifest.json` `mount`). Full DOM + a device
  API for HTTP relay, downloads to SD, file writes, and crypto.
- **`device.json`** — a declarative manifest the firmware interprets to give
  the plugin an on-device screen (Settings > System > Plugins): browse a
  JSON/XML catalog, search it (server-side, via the on-device keyboard),
  authenticate, download files. No code runs on the device.

Read [reference.md](reference.md) before writing either — it documents the
exact device API signatures, the full device.json schema, and the firmware's
hard limits (relay response cap, manifest size cap, no redirect-follow on
/api/fetch, etc.). Getting these wrong fails silently on the device.

## Steps

1. **Scaffold** `<name>/` at the repo root (lowercase, digits, `-` only):
   - `manifest.json` — required:
     ```json
     {
       "title": "Display Name",
       "mount": "settings",
       "description": "One line.",
       "author": "Diirge",
       "version": "1.0.0"
     }
     ```
     `mount` is `"settings"` or `"files"`. Files-mount plugins render on the
     File Manager page and may use its same-origin endpoints and the JSZip it
     already loads; settings-mount plugins render on the Settings page.
   - `plugin.js` — must call `CrossPoint.registerPlugin(async (container, api) => { ... })`.
     Render into `container` with innerHTML + `document.getElementById`;
     plain ES6, no imports, no frameworks.
   - `device.json` — only if the plugin needs an on-device screen.
   - `README.md` — user-facing: what it does, how to install, how to use.
     Keep it about using the plugin, not implementation.

2. **Study a neighbor first.** Match existing idioms rather than inventing:
   - `hello/` — minimal render.
   - `plugin-store/` — config file read/write, relay, fetchToSd, install/remove
     UI, the UTF-8-safe `b64()` helper.
   - `dictionaries/` — redirect resolution via relay HEAD, settings.json
     read-modify-write, generated catalog + paged device.json browse.
   - `bookfusion/` — OAuth device-code flow in both plugin.js and device.json,
     plus on-device search (`browse.search`).
   - `wallabag/`, `webdav/` — config-driven device.json (password grant, XML browse).
   - `protected-content/` — crypto API, XML relay flows.

3. **Register it** in `catalog.json` (this makes it installable from the
   Plugin Store): add a `plugins[]` entry with `name`, `title`, `description`,
   `author`, `version`, `base` (`https://raw.githubusercontent.com/itsthisjustin/sd-plugins/main/<name>/`),
   and `files` (every file the plugin ships). Keep the array alphabetical.

4. **Test.** Add the plugin to the manifest-contract list in
   `test/plugins.test.mjs`, and add a behavior test if plugin.js has logic
   worth pinning (stub `fetch`/`api`, drive the fixed-id elements — see the
   `dictionaries` test). The fake document asserts on unexpected
   `getElementById` calls, so list every id the code path touches. Run
   `npm test`.

5. **Document** the plugin with one bullet in the repo README's
   "Layout of this folder" list.

## Conventions

- Config/state files go in `/.crosspoint/<name>.json`; read them with
  `fetch('/download?path=...')`, write with `api.writeFile(path, b64)`.
  Never store secrets in the plugin folder itself.
- Downloads go through `api.fetchToSd` (device pulls straight to SD) — never
  pull file bytes through the browser page.
- Keep on-device catalog titles ASCII: the e-ink UI font has no guaranteed
  coverage for arrows or other symbols.
- Escape all remote strings with an `escapeHtml` helper before innerHTML.
- If the plugin needs generated/hosted data (a catalog, a mirror), add a
  script under `scripts/` and a workflow under `.github/workflows/` that
  publishes to a rolling GitHub release — see `dictionaries-mirror.yml`.
