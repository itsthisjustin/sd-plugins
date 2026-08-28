# Dictionaries

Install offline dictionaries for the reader's built-in dictionary lookup —
long-press a word while reading to see its definition. These are
**monolingual** dictionaries: they explain a word in its own language (English
words defined in English, Spanish in Spanish, …), which is what you want for
looking up words in a book rather than translating.

Around 20 languages are available, built from each language's own
[Wiktionary](https://www.wiktionary.org) edition, plus the classic
[Webster's 1913](https://www.websters1913.com/) for English. Only the files
the reader actually needs are downloaded — no archives to unpack.

## Install the plugin

Install **Dictionaries** from the Plugin Store (web UI → Settings → Plugin
Store), or copy this folder to `/.crosspoint/plugins/dictionaries/` on the SD
card.

## Download dictionaries

**On the reader:** Settings → System → Plugins → Dictionaries. Pick a
language and it downloads straight into `/dictionaries/<name>/` (the folder
is created if missing).

**From the web UI:** open Settings → Dictionaries, filter the list, and press
Install. The device downloads the files directly to the SD card — they never
pass through your browser.

## Choose the active dictionary

- **On the reader:** Settings → Dictionary lists every installed dictionary —
  this works immediately, no restart needed.
- **From the web UI:** pick one under "Active dictionary" and press *Set
  active*. This writes `dictionaryName` into `/.crosspoint/settings.json`, so
  it takes effect after the reader restarts — and changing any setting on the
  device before restarting may write the old value back. When in doubt, use
  the on-device picker.

## How it works

The reader loads StarDict dictionaries as loose files
(`.ifo` + uncompressed `.idx` + `.dict.dz`) from `/dictionaries/<name>/`. No
ready-made monolingual StarDict files exist for most languages, so a scheduled
workflow in this repo
([`dictionaries-mirror.yml`](../.github/workflows/dictionaries-mirror.yml))
generates them from [kaikki.org](https://kaikki.org)'s machine-readable
Wiktionary extracts — matched to the reader's dictionary engine (index sort
order, dictzip chunking, headword/definition size limits). Inflected forms
("cats", "ran") resolve straight to the lemma's full definition instead of a
bare "plural of cat" stub — the stub would otherwise shadow the reader's own
stemming fallback. The files are hosted as
assets on the rolling
[`dictionaries` release](https://github.com/itsthisjustin/sd-plugins/releases/tag/dictionaries).
The browse catalog under [`catalog/`](catalog/) is regenerated in the same
run.

Wiktionary content is dual-licensed CC BY-SA and GFDL; Webster's 1913 is
public domain.
