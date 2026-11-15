# Reading Room

A personal bookshelf and reading history for CrossPoint e-readers
(Xteink X4 and other FreeInk devices).

Everything stays on your SD card: no account, no internet, no server.

- **Bookshelf:** every book on the card, with cover, author, progress and time read.
- **Reading history:** each reading session (when, how long, from where to where in the book).
- **Statistics:** total time, time this year, books finished this year, day streak, the last 30 days.
- **Your data, plain text:** `/Reading Room/` on the SD card ([format](docs/FORMAT.md)), plus a CSV export.

## Requirements

- CrossPoint 2.0 or later, with **Settings → Connectivity → Plugins** enabled.
  No custom firmware is needed.
- The reader's clock must be set. Any Wi-Fi connection sets it.

## Install

**With Plugin Hub:** on the reader's web page open **Plugins**, add this custom
catalog, then install **Reading Room**:

    https://raw.githubusercontent.com/l3luescreen/codex/plugins/catalog.json

**By hand:** copy the folder `plugin/reading-room/` to the SD card as
`/plugins/reading-room/` (or `/.crosspoint/plugins/reading-room/`).

Then **restart the reader once**, so it starts recording.

## Use

1. Read as usual.
2. Now and then (at least every ~14 reading sessions, for example once a
   week), open the reader's web page (File Transfer) and go to **Plugins**.
   Reading Room saves the new sessions and shows your shelf.

## How it works

CrossPoint 2.0 sends plugins a `reader.session` event each time a reading
session ends (leaving the book or going to sleep). It queues events in the
plugin's outbox, `<plugin folder>/events.jsonl`, and normally delivers them to
a web server.

Reading Room declares a handler whose address is not `http(s)://`, so the
reader can never deliver it and keeps the events queued, with no network use.
When you open the Plugins page, `plugin.js` copies the queued sessions into
`/Reading Room/sessions/` and removes them from the outbox.

Limits that come from the firmware:

- The outbox holds 4 KB, about 14 sessions. When it is full, the reader
  empties it and the waiting sessions are lost. The page warns when the
  outbox was nearly full.
- A session needs at least 10 seconds of reading and a set clock.
- This relies on CrossPoint keeping undeliverable events. If a future
  CrossPoint version changes that, the outbox would be cleared instead and
  no sessions would be saved. Check the page after updating the firmware.

## Repository layout

```
plugin/reading-room/   the CrossPoint plugin (what goes on the SD card)
docs/FORMAT.md         the data format in /Reading Room/
test/                  tests: a fake reader and SD card in jsdom
```

Run the tests with `npm install && npm test` (Node 20 or later).

## Plans

- A dashboard outside the reader that reads the same `/Reading Room/` folder.
- Optional firmware patch (in the `codex` fork) that writes sessions straight
  to `/Reading Room/`, with no outbox limit.
