# Libby (for CrossPoint)

Link your Libby (OverDrive) account, view your library loans, and send them to
the device as EPUBs. Renewing and returning are Libby operations too. This is a
web-only plugin: run it from `crosspoint.local` in a browser.

## Requires the Protected Content plugin

**This plugin does not decrypt books on its own.** It handles everything
Libby-specific (linking, listing loans, fetching each loan's fulfillment token,
returning, renewing), but the actual Adobe DRM fulfillment and decryption is
done by the generic **`protected-content`** plugin. When Libby fulfills a loan,
this plugin stages the fulfillment token and hands it to `protected-content`
through the job queue.

So you must have **both** installed:

- `libby` (this plugin) — the Libby API layer and the web loans screen.
- `protected-content` — the Adobe fulfillment/decryption engine.

Install `protected-content` first (or alongside), and activate it once so the
device holds its access credential.

## How it works

- **Linking** happens in the browser (run this plugin from `crosspoint.local`).
  It uses Libby's official device "clone code" flow: click **Link Libby
  account**, the plugin shows an eight-digit setup code, and you enter it in the
  Libby app under **Copy To Another Device → Enter Setup Code**. The
  authenticated identity is saved to the device (`/.crosspoint/libby.json`). No
  username or password. Linking runs in the browser because the clone handshake
  needs a per-chip header and a retry step the device's manifest engine can't
  express.
- **Viewing loans** — the web page lists your live loans after linking (title,
  author), read straight from Libby's API with the saved identity.
- **Sending** is on demand. Each loan has a **Send to device** button that asks
  Libby to fulfill the loan and hands it to `protected-content`, which lands the
  decrypted EPUB plus its license sidecar in `/Libby` on the card.
- **Renewing** extends the loan on Libby (`PUT` the loan), then fetches a fresh
  `.acsm` and has `protected-content` rewrite only the book's `.rights` sidecar —
  the encrypted EPUB is reused, not re-downloaded. Renew works for books that were
  sent from this page (it remembers where each one landed); Libby only allows a
  renewal inside its window and when no one is waiting for the title.

Everything runs from the browser page — linking, viewing loans, and the Adobe
fulfillment all need the connected web plugin.

## Ebooks only

This plugin targets Adobe-DRM EPUB loans. Audiobooks, magazines, and comics are
out of scope.

## Status

The linking flow, loan listing, and the Adobe EPUB format id (`ebook-epub-adobe`)
have been verified against a live Libby account. The Adobe fulfillment/decryption
path runs through `protected-content` and follows its status.
