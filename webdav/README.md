# WebDAV

Browse and download books from a WebDAV server right on the reader. Works with
Nextcloud, ownCloud, Seafile, Koofr, and any standard WebDAV share. (Koofr can
bridge Google Drive, Dropbox, and OneDrive to WebDAV, so those work too.)

## Install

Copy this folder to the SD card at `/.crosspoint/plugins/webdav/`.

## Set up (once, from a browser)

1. Open the device web page → **Settings** → the WebDAV card.
2. Enter the **Server URL** for the folder you want to browse, ending in a
   slash. For example:
   - `https://dav.koofr.net/dav/Koofr/Books/`
   - `https://cloud.example.com/remote.php/dav/files/USER/Books/`
3. Enter your username and password. For Nextcloud/ownCloud, use an **app
   password**, not your login password. Tap **Test**, then **Save**.

## Use

1. On the reader, go to **Settings → System → Plugins → WebDAV**.
2. Browse your folders: Confirm opens a folder, Back goes up a level.
3. Press Confirm on a book to download it to `/WebDAV/` on the SD card.

## Notes

- Download and browse only — no uploading or syncing back to the server.
- Very large folders may not list fully (a few hundred entries at most). Split
  big libraries into subfolders on the server.
- Your credentials are stored on the SD card, so keep the card somewhere safe.

## Clear

Tap **Clear** on the web card, or delete `/.crosspoint/webdav.json`.
