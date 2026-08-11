# Wallabag

Read your Wallabag saved articles on the reader as EPUB. Works with a
self-hosted Wallabag or the hosted app.wallabag.it.

## Install

Copy this folder to the SD card at `/.crosspoint/plugins/wallabag/`.

## Set up (once, from a browser)

1. In Wallabag, go to **Settings → API clients management** and create a client.
   Note the **Client ID** and **Client secret**.
2. Open the device web page → **Settings** → the Wallabag card.
3. Enter your **Server URL** (`https://app.wallabag.it` or your own server), the
   Client ID and secret, and your Wallabag username and password. Tap **Test**,
   then **Save**.

## Use

1. On the reader, go to **Settings → System → Plugins → Wallabag**.
2. Your unread articles appear. Press Confirm to download one as an EPUB to
   `/Wallabag/` on the SD card.

## Notes

- app.wallabag.it needs a paid plan; self-hosting is free.
- Unread articles are shown by default. To show starred articles instead, open
  `device.json` and change `archive=0` to `starred=1` in `browse.url`.
- Your credentials are stored on the SD card, so keep the card somewhere safe.

## Clear

Tap **Clear** on the web card, or delete `/.crosspoint/wallabag.json`.
