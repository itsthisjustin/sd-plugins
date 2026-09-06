# Protected Content

Open protected e-books you're authorized to read. Connect your content account
once, then fetch a book from its authorization file and read it on the device.
The book stays protected on the card and is unlocked only while you read it.

This plugin has no screen on the reader itself — everything below happens from
the device web page in a browser. Fetched books open like any other book.

## Before you start

You'll need a content account. If you don't have one, you can sign up at
[DTS ByteBooks](https://dtsbytebooks.com/register).

Everything here happens from the device web page, and it needs internet access:
start **File Transfer** in **Join Network** mode (not Hotspot) so the reader is
online.

## Connect your account (once)

1. Open the device web page → **File Manager** → the **Protected Content** card.
2. Enter your account **email** and **password** and tap **Activate device**.
   This links the reader to your account and saves a credential to the SD card.
   You only do this once.

## Fetch a book (On CrossPoint)

1. In the **File Manager**, upload your book's authorization file (the `.acsm`
   you received when you bought or borrowed the book) into a folder on the SD
   card.
2. Back on the Protected Content card, choose the uploaded file and tap **Fetch
   selected book**.
3. The book downloads next to the `.acsm` and is ready to open from the reader.

## Fetch a book (Via CommonStacks)

1. Download CommonStacks from commonstacks.com 
2. Browse Libby and find a book you want to Borrow. Borrow and click Read With...
3. Join Network on CrossPoint and then go to your downloads tab on CommonStacks and right click and Send To CrossPoint

## Notes

- This only opens content you're authorized to access with your own account.
- The downloaded book stays protected on the SD card; it's unlocked in memory
  only while you're reading it on this device.
- Borrowed books stop opening once the loan period ends.
- Your account credential is stored on the SD card, so keep the card somewhere
  safe.


### Activation identity and recovery

New activations require firmware exposing `hardwareMac` in `/api/status`. The
plugin derives the device serial from that factory MAC. The random salt and
keys are saved on SD; existing credentials keep their original identity.
Reopening the page or selecting the same account reuses its saved activation.

`/.crosspoint/content-activation.json` checkpoints setup before the activation
request. If saving `content.key` fails after a successful activation, use
**Save activation** to retry the SD write without registering again. Keep the
page open if the checkpoint write also failed. A saved checkpoint can recover
the activation after a page reload. Back up both files together; they contain
private account credentials.

If an activation request has no saved reply, the plugin stops rather than
submitting it again. It also does not replay activation POSTs on redirects.
Contact the provider to resolve that attempt before retrying; deleting the
checkpoint or creating another identity could consume another slot. This
change does not recover slots already consumed on the provider's server.
