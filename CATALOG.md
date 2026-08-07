# Plugin store catalog spec

A **catalog** is a single JSON document that lists installable plugins. The
Plugin Store plugin fetches one or more catalog URLs, shows their plugins, and
installs a chosen plugin by writing its files to
`/.crosspoint/plugins/<name>/` on the SD card.

Anyone can host a catalog — a static file on any HTTP(S) host works, and a
Git repository's raw file URLs are the easiest option. Users add your catalog
URL as a "store" in the Plugin Store; multiple catalogs coexist.

## Document shape

```jsonc
{
  "name": "My Plugin Store",     // optional; shown as the store heading
  "plugins": [ /* PluginEntry, ... */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | Display name for the store. Falls back to the URL host. |
| `plugins` | array | yes | Zero or more plugin entries. |

## PluginEntry

```jsonc
{
  "name": "wallabag",                 // install folder name (see rules)
  "title": "Wallabag",                // display title
  "description": "One line summary.", // shown in the list
  "author": "you",                    // optional, shown as "by you"
  "version": "1.0.0",                 // optional, informational
  "base": "https://.../wallabag/",    // base URL the files live under
  "files": ["manifest.json", "device.json", "plugin.js", "README.md"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The SD folder it installs to: `/.crosspoint/plugins/<name>/`. Use lowercase letters, digits, and `-`. No `/`, `\`, `..`, or spaces. |
| `title` | string | no | Defaults to `name`. |
| `description` | string | no | One line; shown in the store list and (once installed) on-device. |
| `author` | string | no | Attribution. |
| `version` | string | no | Informational only; the store does not compare versions (Install always overwrites). |
| `base` | string | yes | Absolute `http(s)://` URL. A trailing slash is optional (added if missing). Each file is fetched from `base + file`. |
| `files` | string[] | yes | Files to download, relative to `base`. Paths may include subfolders (`assets/icon.bin`); each is written under the install folder at the same relative path. |

### File rules

- List every file the plugin needs. At minimum a runnable plugin has either a
  `plugin.js` (browser) or a `device.json` (on-device); include `manifest.json`
  for a title/description/mount and `README.md` for on-device instructions.
- Files are fetched and written one at a time (they are small text). Keep
  individual files well under a few hundred KB.
- The device fetches each file itself (via its outbound relay), so the host
  does **not** need CORS headers. HTTPS is fetched without certificate
  verification (same as every other device network call), so serve catalogs
  and files only from hosts you trust.

## Complete sample

```json
{
  "name": "CrossPoint Plugins",
  "plugins": [
    {
      "name": "wallabag",
      "title": "Wallabag",
      "description": "Read your Wallabag saved articles on the device as EPUB.",
      "author": "CrossPoint",
      "version": "1.0.0",
      "base": "https://raw.githubusercontent.com/crosspoint-reader/sd-plugins/main/wallabag/",
      "files": ["manifest.json", "device.json", "plugin.js", "README.md"]
    },
    {
      "name": "webdav",
      "title": "WebDAV",
      "description": "Browse and download books from a WebDAV server.",
      "author": "CrossPoint",
      "base": "https://raw.githubusercontent.com/crosspoint-reader/sd-plugins/main/webdav/",
      "files": ["manifest.json", "device.json", "plugin.js", "README.md"]
    }
  ]
}
```

## Hosting from a Git repo

If your plugins live in a repo like this one, point `base` at the raw file
host. For GitHub that is
`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<plugin>/`, and the
catalog itself is the raw URL of your `catalog.json`. Publishing a new plugin
is a commit: add its folder and add an entry to `catalog.json`. No firmware
change is ever required.
