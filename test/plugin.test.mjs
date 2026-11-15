// Runs plugin/reading-room/plugin.js in jsdom against a fake SD card and a
// fake reader web server that follow CrossPoint 2.0's behavior.
//   npm install && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PLUGIN_JS = readFileSync(new URL('../plugin/reading-room/plugin.js', import.meta.url), 'utf8');
const DIR = '/.crosspoint/plugins/reading-room';
const OUTBOX = DIR + '/events.jsonl';

// Same line shape and drop rule as pluginevents::emit() in CrossPoint 2.0.
let seq = 0;
function emit(sd, vars, ts = 1794700000) {
  const line = JSON.stringify({ e: 'reader.session', id: 'a1b2c3d4-' + (++seq), ts, vars }) + '\n';
  let cur = sd.get(OUTBOX) || '';
  if (Buffer.byteLength(cur) > 4096) cur = '';
  sd.set(OUTBOX, cur + line);
  return line;
}
const session = (book, start, seconds, from, to) => ({
  book, document: '0123456789abcdef0123456789abcdef', start_time: String(start),
  end_time: String(start + seconds), duration_seconds: String(seconds),
  start_progress_bp: String(from), end_progress_bp: String(to), progress_scale: '10000'
});

function fakeDevice(sd) {
  return async (url) => {
    const u = new URL(url, 'http://reader.local');
    const path = u.searchParams.get('path');
    const resp = (status, text) => ({ ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) });
    if (u.pathname === '/download') return sd.has(path) ? resp(200, sd.get(path)) : resp(404, '');
    if (u.pathname === '/api/files') {
      const prefix = path === '/' ? '/' : path + '/';
      const seen = new Map();
      for (const key of sd.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).split('/');
        if (rest[0].startsWith('.') && path === '/') continue;  // showHiddenFiles off
        seen.set(rest[0], rest.length > 1);
      }
      return resp(200, JSON.stringify([...seen].map(([name, dir]) => ({ name, isDirectory: dir, size: 1 }))));
    }
    return resp(404, '');
  };
}

async function runPlugin(sd) {
  const dom = new JSDOM('<div id="c"></div>', { runScripts: 'outside-only', url: 'http://reader.local/plugins' });
  const w = dom.window;
  w.fetch = fakeDevice(sd);
  w.TextEncoder = TextEncoder;
  let fn;
  w.CrossPoint = { registerPlugin: (f) => { fn = f; } };
  w.eval(PLUGIN_JS);
  const writes = [];
  const api = {
    name: 'reading-room', dir: DIR,
    writeFile: async (path, b64) => {
      writes.push(path);
      sd.set(path, Buffer.from(b64, 'base64').toString('utf8'));
      return { ok: true };
    }
  };
  const c = w.document.getElementById('c');
  await fn(c, api);
  return { text: c.textContent.replace(/\s+/g, ' '), writes, w, c };
}

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

function card() {
  const sd = new Map();
  sd.set('/Books/Dune.epub', 'x');
  sd.set('/Books/Sci-fi/Foundation.epub', 'x');
  sd.set('/Books/notes.txt', 'x');
  sd.set('/sleep.bmp', 'x');
  sd.set('/.crosspoint/epub_42/thumb_150.bmp', 'bmp');
  sd.set('/.crosspoint/epub_42/thumb_400.bmp', 'bmp');
  sd.set('/.crosspoint/recent.json', JSON.stringify({ books: [
    { path: '/Books/Dune.epub', title: 'Dune', author: 'Frank Herbert',
      coverBmpPath: '/.crosspoint/epub_42/thumb_[HEIGHT].bmp' }] }));
  return sd;
}

test('one outbox line stays well under the 4KB outbox (about 14 sessions fit)', () => {
  const sd = new Map();
  const line = emit(sd, session('/Books/Apocalypse Bringer Mynoghra Volume 1.epub', now, 1800, 1200, 2400));
  const bytes = Buffer.byteLength(line);
  assert.ok(bytes > 250 && bytes < 330, 'line is ' + bytes + ' bytes');
});

test('collects sessions, files them by month, and empties the outbox', async () => {
  const sd = card();
  emit(sd, session('/Books/Dune.epub', now - 2 * DAY, 1200, 0, 1500));
  emit(sd, session('/Books/Dune.epub', now - DAY, 1800, 1500, 9950));
  emit(sd, session('/Books/Sci-fi/Foundation.epub', now, 600, 0, 800));
  emit(sd, session('/Books/Dune.epub', 0, 0, 0, 0));  // no clock: cannot be stored
  const { text, writes, c } = await runPlugin(sd);

  assert.equal(sd.get(OUTBOX), '', 'outbox emptied');
  const tiles = Object.fromEntries([...c.querySelectorAll('.rr-tile')].map((t) =>
    [t.lastChild.textContent, t.querySelector('b').textContent]));
  assert.equal(tiles['day streak'], '3');
  assert.equal(tiles['books read'], '2');
  assert.equal(tiles['read in total'], '1 h 00 min');
  const months = [...sd.keys()].filter((k) => k.startsWith('/Reading Room/sessions/'));
  assert.ok(months.length >= 1);
  const stored = months.flatMap((k) => sd.get(k).trim().split('\n').map((l) => JSON.parse(l)));
  assert.equal(stored.length, 3);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['book', 'document', 'duration_seconds', 'end_progress_bp',
    'end_time', 'id', 'source', 'start_progress_bp', 'start_time'].sort());
  assert.equal(typeof stored[0].start_time, 'number');
  assert.ok(writes.includes('/Reading Room/books.json'));
  assert.match(text, /Saved 3 new reading sessions/);
  assert.match(text, /Dune/);
  assert.match(text, /Frank Herbert/);
  assert.match(text, /Finished/);  // 99.5% counts as finished
  assert.match(text, /Not started/);  // notes.txt
});

test('a second visit adds nothing and keeps the history', async () => {
  const sd = card();
  emit(sd, session('/Books/Dune.epub', now - DAY, 1200, 0, 1500));
  await runPlugin(sd);
  const before = sd.get('/Reading Room/sessions/' + new Date((now - DAY) * 1000).toISOString().slice(0, 7) + '.jsonl');
  // The same event replayed (a crash before the outbox rewrite) must not double count.
  emit(sd, session('/Books/Dune.epub', now - DAY, 1200, 0, 1500));
  seq--;  // replay the same id
  sd.set(OUTBOX, sd.get(OUTBOX).replace(/a1b2c3d4-\d+/, 'a1b2c3d4-' + seq));
  const { text } = await runPlugin(sd);
  const after = sd.get('/Reading Room/sessions/' + new Date((now - DAY) * 1000).toISOString().slice(0, 7) + '.jsonl');
  assert.equal(after, before);
  assert.match(text, /No new reading sessions/);
});

test('keeps events it did not store, and warns when the outbox was nearly full', async () => {
  const sd = card();
  for (let i = 0; i < 12; i++) emit(sd, session('/Books/Dune.epub', now - (12 - i) * 3600, 300, i * 100, i * 100 + 90));
  sd.set(OUTBOX, sd.get(OUTBOX) + '{"e":"reader.exit","id":"zz-1","ts":1,"vars":{"book":"/x"}}\n');
  const { text } = await runPlugin(sd);
  assert.equal(sd.get(OUTBOX), '{"e":"reader.exit","id":"zz-1","ts":1,"vars":{"book":"/x"}}\n');
  assert.match(text, /almost full/);
});

test('uses the largest cover thumbnail and the recent-books title', async () => {
  const sd = card();
  emit(sd, session('/Books/Dune.epub', now, 600, 0, 100));
  const { c } = await runPlugin(sd);
  const img = c.querySelector('img');
  assert.ok(img, 'cover shown');
  assert.equal(new URL(img.src).searchParams.get('path'), '/.crosspoint/epub_42/thumb_400.bmp');
  const shelf = JSON.parse(sd.get('/Reading Room/books.json'));
  assert.equal(shelf.books['/Books/Dune.epub'].author, 'Frank Herbert');
  assert.equal(shelf.books['/Books/Sci-fi/Foundation.epub'].title, 'Foundation');
});

test('an empty card still renders', async () => {
  const { text } = await runPlugin(new Map());
  assert.match(text, /No new reading sessions/);
  assert.match(text, /No books here yet/);
});
