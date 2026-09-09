# Month Wallpaper

Puts a **month calendar on the reader's sleep screen**. The plugin browses the
months offered by a hosted rendering server and downloads the one you pick to
`/sleep/calendar.bmp`.

You do **not** need to run anything — the plugin points at a hosted instance at
`https://crosspoint-calendar.marczyk.ovh`. To run your own, change the `url` in
`device.json` to your server.

```
reader  ──GET /catalog──▶  server   (list of months + BMP URLs)
reader  ──GET the BMP──▶   server   (1-bit BMP, rendered on demand)
        └▶ /sleep/calendar.bmp
```

## Install

Install *Month Wallpaper* from the Plugin Store, or copy the `month-wallpaper/`
folder to `/.crosspoint/plugins/month-wallpaper/` on the SD card.

Then create `/.crosspoint/month-wallpaper.json` on the card to describe your
screen and preferences:

```json
{
  "width": 480,
  "height": 800,
  "country": "US",
  "week_start": "monday",
  "show_adjacent": true
}
```

| Key | Meaning |
|---|---|
| `width`, `height` | Your screen resolution in pixels. |
| `country` | ISO 3166 alpha-2 code (`US`, `DE`, `PL`, …), or `none`. Sets the public holidays **and** the month/weekday name language (its main language). |
| `week_start` | `monday` or `sunday`. |
| `show_adjacent` | `true` to fill leading/trailing cells with the greyed dates of the neighbouring months. |

All keys are optional — anything you leave out uses the server's default
(480×800, English, no holidays, Monday, adjacent days on).

## Use

On the reader: **Settings → System → Plugins → Month Wallpaper**. It lists the
months the server offers, the current month first, then a year ahead. Pick one
and it downloads to `/sleep/calendar.bmp`.

Re-run it at the start of each month. Reusing the fixed filename means each
download overwrites the previous month's image.

### Showing the calendar on every lock

The reader picks a sleep image at random from `/sleep`. For the calendar to
show **every** time the screen locks, `calendar.bmp` must be the only file in
`/sleep` — move or delete any other images there.
