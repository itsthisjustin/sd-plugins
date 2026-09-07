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

## Activation troubleshooting

### “The previous activation has no saved reply”

This means setup saved an attempt before sending it, but did not save a
successful activation response. A connection failure, an unreadable response,
or a failed SD write can leave this state. It does **not** establish whether
the service accepted the request or counted an activation slot.

Plugin **1.0.4** adds recovery for this state, including attempts saved by
1.0.3. Install the updated plugin and refresh the File Manager page. No
firmware update is needed if activation already worked with 1.0.3.

1. Reconnect the reader using **File Transfer → Join Network**, with internet
   access, then open **File Manager → Protected Content**.
2. The card shows **Retry activation**, the pending account, and the last error
   if one was saved. Older attempts may have no original error available.
3. If you have a complete credential backup from a successful activation,
   restore `/.crosspoint/content.key` and refresh to reuse it without another
   activation request.
4. Otherwise, choose **Retry activation** for the displayed account. Read the
   confirmation: the service may count another slot if the first request
   succeeded. **Cancel** keeps setup paused and sends nothing. Confirming sends
   one activation request using the saved identity and signing credentials;
   you do not need to re-enter the password.
5. If the retry succeeds, setup saves the credential and shows **Connected**.
   If it fails, the error remains visible and the plugin does not retry
   automatically. Another attempt requires another confirmation.

Do not delete `content.key` or `content-activation.json` to clear this message.
They preserve the existing identity and any recoverable activation. The MAC
address alone cannot reconstruct the saved random keys or a missing activation
ID, and using the same identity does not guarantee that the service will reuse
a slot. The plugin also does not replay activation POSTs on redirects.

### “Save activation” or an SD write error

If setup received the activation ID but could not finish saving, keep the page
open and choose **Save activation**. This only retries the SD writes; it does
not activate again. A successfully saved checkpoint can also recover this
state after a page reload. Check the card's free space and write access if
saving continues to fail.

### Account rejection or activation limit

A service rejection is shown as its error code. Correct a sign-in error before
retrying. For an exhausted activation limit (such as
`E_ACT_TOO_MANY_ACTIVATIONS`), contact the account provider to resolve the limit;
repeated attempts and reinstalling the plugin cannot recover consumed slots.

When reporting a failure, copy the **Last error** text, plugin and firmware
versions, and whether the reader was in Join Network mode. Do not post either
account file: both contain private credentials. The plugin help link opens
this troubleshooting guide.
