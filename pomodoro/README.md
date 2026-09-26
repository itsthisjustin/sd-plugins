# Pomodoro Timer

Simple Pomodoro focus timer for CrossPoint, built as an SD-card plugin.

## Features

- Work / short break / long break cycles (defaults: 25 / 5 / 15 minutes)
- Configurable durations and number of sessions before a long break
- Session counter
- Start / Pause / Reset controls
- Settings persist across app restarts (via plugin storage, falls back to `localStorage`)

## Install

1. Copy this `pomodoro/` folder onto the SD card at `/.crosspoint/plugins/pomodoro/`.
2. On the device or in the CrossPoint web UI, go to **Settings → System → Plugins**.
3. The plugin should appear as **Pomodoro Timer** — open it to use the timer.

## Files

- `manifest.json` — plugin metadata (title, mount point, description, author, version).
- `plugin.js` — browser-side plugin code, registered via `CrossPoint.registerPlugin`.
- `README.md` — this file.

## Notes

This plugin mounts on the **settings** surface (`"mount": "settings"` in `manifest.json`),
matching the pattern used by `hello`, `bookfusion`, `wallabag`, `webdav`, and `dictionaries`
in this repo. It only uses the generic `container`/`api` contract from the plugin loader,
so it should run without any additional device capabilities.
