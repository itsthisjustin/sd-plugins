# BookFusion

Read your BookFusion library on the reader: sign in once, then browse and
download your books straight to the device.

## Use

1. On the reader, go to **Settings → System → Plugins → BookFusion**.
2. The first time, a sign-in screen shows a link and a short code (with a QR
   code). On your phone or computer, open the link and enter the code to
   authorize the reader. You only do this once.
3. Once signed in, pick a shelf — All Books, Currently Reading, Favorites,
   Plan to Read, or Completed. Move with the side buttons or touch, page
   with the **Previous page** / **Next page** rows in the list, and press
   Confirm to download a book. Back returns to the shelf picker.
4. To find a specific book, tap the search icon in the header (or press the
   Search button on the top row) and type a title or author. Back leaves the
   results and returns to the shelf.
5. Books download to `/BookFusion/` on the SD card and show up alongside your
   other books.

Prefer a browser? You can sign in the same way from the device web page →
**Settings** → the BookFusion card.

## Progress sync

Every downloaded book gets a small metadata file next to it
(`<book>.epub.meta.json`) holding its BookFusion book id. To have your reading
progress reach BookFusion:

1. On the reader, set up **KOReader Sync** with a CrossPoint sync server
   (`https://sync.crosspointreader.com/`) as the server.
2. Enable **Send book metadata** in the KOSync settings.

Progress uploads then carry the BookFusion id, and the sync server forwards
your position to BookFusion. Books fetched before this plugin version have no
metadata file; re-download them (or create the file by hand) to include them.

## Sign out

Tap **Sign out** on the web Settings card, or delete
`/.crosspoint/bookfusion.json` from the SD card.

## Notes

- Requires a BookFusion account.
- Your sign-in is stored on the SD card, so keep the card somewhere safe.
