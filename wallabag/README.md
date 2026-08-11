# Wallabag

Read your Wallabag saved articles on the reader as EPUB. Works with a
self-hosted Wallabag or the hosted app.wallabag.it.

## Set up (once, from a browser)

1. In Wallabag, go to **Settings → API clients management** and create a client.
   Note the **Client ID** and **Client secret**.
2. Open the device web page → **Settings** → the Wallabag card.
3. Enter your **Server URL** (`https://app.wallabag.it` or your own server), the
   Client ID and secret, and your Wallabag username and password. Tap **Test**,
   then **Save**.

## Use

1. On the reader, go to **Settings → System → Plugins → Wallabag**.
2. Pick a view — Unread, Starred, Archived, or All. Page with the
   **Previous page** / **Next page** rows in the list, and press Confirm to
   download an article as an EPUB to `/Wallabag/` on the SD card. Back
   returns to the view picker.

## Notes

- app.wallabag.it needs a paid plan; self-hosting is free.
- Your credentials are stored on the SD card, so keep the card somewhere safe.

## Clear

Tap **Clear** on the web card, or delete `/.crosspoint/wallabag.json`.
