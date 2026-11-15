# Reading Room data format (version 1)

Everything lives in one folder on the SD card, `/Reading Room/`. It is plain
text, so any tool (a script, a spreadsheet, a future dashboard) can read it.

```
/Reading Room/
  books.json             the shelf: every book seen on the card or in the history
  sessions/
    2026-11.jsonl        reading sessions that started in that month (UTC)
    2026-12.jsonl
```

## Sessions: `sessions/YYYY-MM.jsonl`

One JSON object per line, sorted by `start_time`. One line is one reading
session: from opening a book (or waking the reader) until leaving the book or
going to sleep.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique id from the reader. Used to skip duplicates. |
| `book` | string | Path of the book on the SD card, e.g. `/Books/Dune.epub`. |
| `document` | string | KOReader partial-MD5 of the file (32 hex characters). Stays the same if the file is renamed. |
| `start_time` | integer | Unix time (seconds, UTC) when reading started. |
| `end_time` | integer | `start_time + duration_seconds`. Idle time is removed, so this is not the wall-clock end. |
| `duration_seconds` | integer | Active reading time. Pages shown less than 2 seconds, going back, and idle gaps do not count. |
| `start_progress_bp` | integer | Position in the book at the start, 0–10000 (10000 = 100%). |
| `end_progress_bp` | integer | Position at the end, 0–10000. |
| `source` | string | Where the line came from. `crosspoint.reader.session` for the CrossPoint `reader.session` event. |

The month in the file name comes from `start_time` in UTC. Readers of the
data should not rely on that: load all files and use `start_time`.

Two lines with the same `id` describe the same session; keep one. Lines
written by other sources may have no `id`; then `document` + `start_time` is
the key.

Example:

```json
{"id":"3fa9c21b-7","book":"/Books/Dune.epub","document":"0123456789abcdef0123456789abcdef","start_time":1794700000,"end_time":1794701800,"duration_seconds":1800,"start_progress_bp":1500,"end_progress_bp":2650,"source":"crosspoint.reader.session"}
```

## The shelf: `books.json`

```json
{
 "version": 1,
 "books": {
  "/Books/Dune.epub": {
   "title": "Dune",
   "author": "Frank Herbert",
   "added": 1794700000,
   "cover": "/.crosspoint/epub_42/thumb_400.bmp"
  }
 }
}
```

| Field | Meaning |
|---|---|
| key | Book path on the SD card. |
| `title` | From the reader's recent-books list when known, otherwise the file name. |
| `author` | From the reader's recent-books list, or empty. |
| `added` | Unix time when Reading Room first saw the book. |
| `cover` | Optional. A cover thumbnail the reader made. It is in the reader's cache, so it can disappear when the cache is cleared. |

You can edit `title` and `author` by hand; Reading Room only replaces them
when the reader reports a title for that book.

Books stay on the shelf after the file is removed from the card, so the
history keeps its titles.

## Compatibility rules

- New fields may be added. Tools must ignore fields they do not know.
- A change that breaks old readers gets a new `version` in `books.json` and a
  note here.
