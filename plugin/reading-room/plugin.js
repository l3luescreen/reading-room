// Reading Room: a personal bookshelf and reading history for CrossPoint.
//
// The reader queues one "reader.session" event per reading session in this
// plugin's outbox (<plugin dir>/events.jsonl). device.json declares a handler
// whose URL is not http(s), so the reader never delivers or clears the queue.
// This page moves the queued sessions into /Reading Room/ on the SD card,
// then removes them from the outbox. Data format: docs/FORMAT.md.
CrossPoint.registerPlugin(async (container, api) => {
  const ROOT = '/Reading Room';
  const SESSIONS_DIR = ROOT + '/sessions';
  const BOOKS_PATH = ROOT + '/books.json';
  const PLUGIN_DIR = (api && typeof api.dir === 'string' && api.dir.startsWith('/'))
    ? api.dir.replace(/\/+$/, '') : '/.crosspoint/plugins/reading-room';
  const OUTBOX_PATH = PLUGIN_DIR + '/events.jsonl';
  const RECENT_PATH = '/.crosspoint/recent.json';
  const OUTBOX_LIMIT = 4096;  // the reader drops the whole outbox past this
  const BOOK_FILE = /\.(epub|txt|md|xtc|xtch)$/i;
  const SKIP_DIRS = new Set(['system volume information', 'xtcache', 'reading room']);
  const FINISHED_BP = 9900;  // 99% or more counts as finished

  // ---------- small helpers ----------
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'class') node.className = v;
        else node[k] = v;
      }
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
  };
  const toB64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  };
  async function readText(path) {
    const r = await fetch('/download?path=' + encodeURIComponent(path), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('read ' + path + ': HTTP ' + r.status);
    return r.text();
  }
  async function listDir(path) {
    try {
      const r = await fetch('/api/files?path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (!r.ok) return [];
      const list = await r.json();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  const writeText = (path, text) => api.writeFile(path, toB64(text));
  const parseLines = (text) => {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* torn or foreign line */ }
    }
    return out;
  };
  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  };
  const monthOf = (unix) => new Date(unix * 1000).toISOString().slice(0, 7);
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  const sessionKey = (s) => s.id || (s.document + '@' + s.start_time);
  const fmtDuration = (sec) => {
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  };
  const fmtDate = (unix) => new Date(unix * 1000).toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
  const fileTitle = (path) => path.split('/').pop().replace(BOOK_FILE, '').replace(/[_]+/g, ' ').trim();

  // One outbox event -> one session record (docs/FORMAT.md), or null.
  function toSession(ev) {
    if (!ev || ev.e !== 'reader.session' || !ev.vars) return null;
    const v = ev.vars;
    const s = {
      id: String(ev.id || ''),
      book: String(v.book || ''),
      document: String(v.document || ''),
      start_time: int(v.start_time),
      end_time: int(v.end_time),
      duration_seconds: int(v.duration_seconds),
      start_progress_bp: int(v.start_progress_bp),
      end_progress_bp: int(v.end_progress_bp),
      source: 'crosspoint.reader.session'
    };
    if (!s.book || !(s.start_time > 1577836800) || !(s.duration_seconds > 0)) return null;
    if (!Number.isFinite(s.end_time)) s.end_time = s.start_time + s.duration_seconds;
    for (const k of ['start_progress_bp', 'end_progress_bp']) {
      if (!Number.isFinite(s[k])) s[k] = 0;
      s[k] = Math.max(0, Math.min(10000, s[k]));
    }
    return s;
  }

  // ---------- step 1: move queued sessions into /Reading Room ----------
  async function collect() {
    const outbox = await readText(OUTBOX_PATH);
    if (!outbox || !outbox.trim()) return { added: 0, outboxBytes: 0 };
    const events = parseLines(outbox).filter((ev) => ev && ev.e === 'reader.session');
    const sessions = events.map(toSession).filter(Boolean);
    // Sessions that can never be stored (no clock, no time read) are dropped too.
    const done = new Set(events.filter((ev) => !toSession(ev)).map((ev) => String(ev.id || '')));
    const byMonth = new Map();
    for (const s of sessions) {
      const m = monthOf(s.start_time);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(s);
    }
    let added = 0;
    for (const [month, list] of byMonth) {
      const path = SESSIONS_DIR + '/' + month + '.jsonl';
      const existing = parseLines(await readText(path));
      const known = new Set(existing.map(sessionKey));
      const fresh = list.filter((s) => !known.has(sessionKey(s)));
      if (fresh.length) {
        const all = existing.concat(fresh).sort((a, b) => a.start_time - b.start_time);
        await writeText(path, all.map((s) => JSON.stringify(s)).join('\n') + '\n');
        added += fresh.length;
      }
      for (const s of list) done.add(s.id);  // stored now, or already stored
    }
    done.delete('');
    // Remove what is safely stored; keep anything else the reader queued.
    const again = await readText(OUTBOX_PATH);
    const keep = String(again || '').split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const ev = JSON.parse(line);
        return !(ev && ev.e === 'reader.session' && done.has(String(ev.id || '')));
      } catch (e) {
        return false;  // a torn line can never be read
      }
    });
    // The reader refuses an empty upload, so an emptied outbox is one newline
    // (the reader skips blank lines).
    const rest = keep.length ? keep.join('\n') + '\n' : '\n';
    if (again !== null && rest.trim() !== again.trim()) await writeText(OUTBOX_PATH, rest);
    return { added, outboxBytes: new TextEncoder().encode(outbox).length };
  }

  // ---------- step 2: load history ----------
  async function loadSessions() {
    const files = (await listDir(SESSIONS_DIR))
      .filter((f) => !f.isDirectory && /^\d{4}-\d{2}\.jsonl$/.test(f.name))
      .map((f) => f.name).sort();
    const seen = new Set();
    const out = [];
    for (const name of files) {
      for (const s of parseLines(await readText(SESSIONS_DIR + '/' + name))) {
        const k = sessionKey(s);
        if (seen.has(k) || !s.book || !(s.duration_seconds > 0)) continue;
        seen.add(k);
        out.push(s);
      }
    }
    return out.sort((a, b) => a.start_time - b.start_time);
  }

  // ---------- step 3: the shelf (books.json) ----------
  async function findBooks(dir, depth, out, budget) {
    if (depth > 4 || budget.dirs-- <= 0) return;
    for (const f of await listDir(dir)) {
      if (!f || !f.name || f.name.startsWith('.')) continue;
      const path = (dir === '/' ? '' : dir) + '/' + f.name;
      if (f.isDirectory) {
        if (!SKIP_DIRS.has(f.name.toLowerCase())) await findBooks(path, depth + 1, out, budget);
      } else if (BOOK_FILE.test(f.name)) {
        out.push(path);
      }
    }
  }
  async function resolveCover(pattern) {
    // The reader stores "<cache>/thumb_[HEIGHT].bmp"; pick the largest one made.
    if (!pattern) return '';
    if (!pattern.includes('[HEIGHT]')) return pattern;
    const dir = pattern.slice(0, pattern.lastIndexOf('/'));
    let best = '';
    let bestH = -1;
    for (const f of await listDir(dir)) {
      const m = /^thumb_(\d+)\.bmp$/i.exec(f.name || '');
      if (m && Number(m[1]) > bestH) {
        bestH = Number(m[1]);
        best = dir + '/' + f.name;
      }
    }
    return best;
  }
  async function updateShelf(sessions) {
    let shelf = { version: 1, books: {} };
    try {
      const saved = JSON.parse((await readText(BOOKS_PATH)) || 'null');
      if (saved && saved.books && typeof saved.books === 'object') shelf = saved;
    } catch (e) { /* start a new shelf */ }
    const before = JSON.stringify(shelf);
    const now = Math.floor(Date.now() / 1000);
    const touch = (path) => {
      if (!shelf.books[path]) shelf.books[path] = { title: fileTitle(path), author: '', added: now };
      return shelf.books[path];
    };

    const onCard = [];
    await findBooks('/', 0, onCard, { dirs: 80 });
    const onCardSet = new Set(onCard);
    for (const path of onCard) touch(path);
    for (const s of sessions) touch(s.book);

    try {
      const recent = JSON.parse((await readText(RECENT_PATH)) || 'null');
      for (const b of (recent && Array.isArray(recent.books)) ? recent.books : []) {
        if (!b || !b.path) continue;
        const book = touch(b.path);
        if (b.title) book.title = String(b.title);
        if (b.author) book.author = String(b.author);
        if (b.coverBmpPath && !book.cover) {
          const cover = await resolveCover(String(b.coverBmpPath));
          if (cover) book.cover = cover;
        }
      }
    } catch (e) { /* titles stay as file names */ }

    if (JSON.stringify(shelf) !== before) {
      await writeText(BOOKS_PATH, JSON.stringify(shelf, null, 1) + '\n');
    }
    return { shelf, onCardSet };
  }

  // ---------- moved books ----------
  // A book moved or renamed on the card keeps its history. The stored files
  // are not changed; old paths are linked to the current one for display:
  // first by file name (a book moved into another folder), then by the
  // document hash the reader sends with each session (a renamed book, once
  // it has been read at its new path).
  function linkMovedBooks(sessions, shelf, onCardSet) {
    const alias = new Map();
    const resolve = (p) => {
      let cur = p;
      for (let i = 0; i < 8 && alias.has(cur); i++) cur = alias.get(cur);
      return cur;
    };
    const nameOf = (p) => p.split('/').pop().toLowerCase();
    const onCardByName = new Map();
    for (const p of onCardSet) {
      const n = nameOf(p);
      onCardByName.set(n, onCardByName.has(n) ? null : p);  // null: name not unique
    }
    const known = new Set(Object.keys(shelf.books).concat(sessions.map((x) => x.book)));
    for (const p of known) {
      if (onCardSet.has(p)) continue;
      const target = onCardByName.get(nameOf(p));
      if (target) alias.set(p, target);
    }
    const latestByDoc = new Map();
    for (const x of sessions) {
      if (!/^[0-9a-f]{32}$/.test(x.document || '')) continue;
      const path = resolve(x.book);
      const cur = latestByDoc.get(x.document);
      const better = !cur || (onCardSet.has(path) && !onCardSet.has(cur.path)) ||
        (onCardSet.has(path) === onCardSet.has(cur.path) && x.start_time >= cur.time);
      if (better) latestByDoc.set(x.document, { path, time: x.start_time });
    }
    for (const x of sessions) {
      const target = latestByDoc.get(x.document);
      const path = resolve(x.book);
      if (target && target.path !== path) alias.set(path, target.path);
    }
    const out = new Map();
    for (const p of known) {
      const r = resolve(p);
      if (r !== p) out.set(p, r);
    }
    return out;
  }

  // ---------- statistics ----------
  function summarize(sessions, shelf, onCardSet) {
    const alias = linkMovedBooks(sessions, shelf, onCardSet);
    const canonical = (p) => alias.get(p) || p;
    const perBook = new Map();
    const perDay = new Map();
    for (const s of sessions) {
      const key = canonical(s.book);
      const b = perBook.get(key) || { seconds: 0, sessions: 0, last: 0, first: Infinity, bp: 0, finishedAt: 0 };
      b.seconds += s.duration_seconds;
      b.sessions += 1;
      b.first = Math.min(b.first, s.start_time);
      if (s.start_time >= b.last) {
        b.last = s.start_time;
        b.bp = s.end_progress_bp;
      }
      if (s.end_progress_bp >= FINISHED_BP && !b.finishedAt) b.finishedAt = s.end_time;
      perBook.set(key, b);
      const day = dayKey(new Date(s.start_time * 1000));
      perDay.set(day, (perDay.get(day) || 0) + s.duration_seconds);
    }
    // Streak: consecutive days with reading, ending today or yesterday.
    let streak = 0;
    const d = new Date();
    if (!perDay.has(dayKey(d))) d.setDate(d.getDate() - 1);
    while (perDay.has(dayKey(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    const year = new Date().getFullYear();
    const thisYear = sessions.filter((s) => new Date(s.start_time * 1000).getFullYear() === year);
    const finishedThisYear = [...perBook.values()]
      .filter((b) => b.finishedAt && new Date(b.finishedAt * 1000).getFullYear() === year).length;
    // Old paths fold into the current entry; a real title beats a file name.
    const merged = new Map();
    for (const [path, meta] of Object.entries(shelf.books)) {
      const key = canonical(path);
      const into = merged.get(key) || {};
      const better = (k) => meta[k] && (!into[k] || (k === 'title' && into[k] === fileTitle(key) && path !== key));
      for (const k of ['title', 'author']) if (better(k)) into[k] = meta[k];
      if (path === key && meta.cover) into.cover = meta.cover;
      if (meta.added && (!into.added || meta.added < into.added)) into.added = meta.added;
      merged.set(key, into);
    }
    for (const key of perBook.keys()) if (!merged.has(key)) merged.set(key, { title: fileTitle(key), author: '' });
    const books = [...merged].map(([path, meta]) => Object.assign(
      { path, onCard: onCardSet.has(path), title: fileTitle(path), author: '' }, meta,
      { stats: perBook.get(path) || null, formerPaths: [...alias].filter(([, to]) => to === path).map(([from]) => from) }));
    return {
      books, perDay, streak, canonical,
      totalSeconds: sessions.reduce((a, s) => a + s.duration_seconds, 0),
      yearSeconds: thisYear.reduce((a, s) => a + s.duration_seconds, 0),
      finishedThisYear,
      readCount: perBook.size
    };
  }

  // ---------- rendering ----------
  const css = el('style', { textContent: [
    '.rr-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0}',
    '.rr-tile{border:1px solid #ddd;border-radius:8px;padding:10px}',
    '.rr-tile b{display:block;font-size:1.3em}',
    '.rr-chart{display:flex;align-items:flex-end;gap:2px;height:80px;margin:6px 0 2px}',
    '.rr-bar{flex:1;background:#4a7a5f;min-height:1px;border-radius:2px 2px 0 0}',
    '.rr-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:10px}',
    '.rr-book{border:1px solid #ddd;border-radius:8px;padding:8px;cursor:pointer;background:#fff}',
    '.rr-book img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:4px;background:#eee}',
    '.rr-cover{width:100%;aspect-ratio:2/3;border-radius:4px;background:#e8e4da;display:flex;align-items:center;' +
      'justify-content:center;text-align:center;padding:6px;box-sizing:border-box;font-size:.9em;color:#555}',
    '.rr-title{font-weight:600;margin-top:6px;overflow-wrap:anywhere}',
    '.rr-meta{font-size:.85em;color:#666}',
    '.rr-prog{height:4px;background:#eee;border-radius:2px;margin:4px 0}',
    '.rr-prog>div{height:100%;background:#4a7a5f;border-radius:2px}',
    '.rr-warn{color:#a15c00}',
    '.rr-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}',
    '.rr-table{width:100%;border-collapse:collapse;font-size:.9em}',
    '.rr-table td,.rr-table th{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}'
  ].join('') });

  const statusLine = el('p', { class: 'rr-meta', textContent: 'Collecting new reading sessions…' });
  const body = el('div');
  container.replaceChildren(css, el('h2', { textContent: 'Reading Room' }), statusLine, body);

  let collected;
  try {
    collected = await collect();
  } catch (e) {
    collected = { error: String((e && e.message) || e) };
  }
  let sessions = [];
  let shelfInfo = { shelf: { books: {} }, onCardSet: new Set() };
  try {
    sessions = await loadSessions();
    shelfInfo = await updateShelf(sessions);
  } catch (e) {
    collected.error = collected.error || String((e && e.message) || e);
  }
  const data = summarize(sessions, shelfInfo.shelf, shelfInfo.onCardSet);

  if (collected.error) {
    statusLine.className = 'rr-warn';
    statusLine.textContent = 'Could not update the history: ' + collected.error;
  } else {
    const queued = collected.outboxBytes || 0;
    statusLine.textContent = (collected.added
      ? 'Saved ' + collected.added + ' new reading session' + (collected.added === 1 ? '' : 's') + '.'
      : 'No new reading sessions.') + ' History is kept in "/Reading Room" on the SD card.';
    if (queued > OUTBOX_LIMIT * 0.75) {
      statusLine.className = 'rr-warn';
      statusLine.textContent += ' The reader\'s waiting list was almost full (it holds about 14 sessions);' +
        ' open this page more often, or sessions can be lost.';
    }
  }

  const tile = (label, value) => el('div', { class: 'rr-tile' }, el('b', { textContent: value }), label);
  const tiles = el('div', { class: 'rr-tiles' },
    tile('read in total', fmtDuration(data.totalSeconds)),
    tile('read this year', fmtDuration(data.yearSeconds)),
    tile('finished this year', String(data.finishedThisYear)),
    tile('day streak', String(data.streak)),
    tile('books read', String(data.readCount)));

  // Last 30 days.
  const days = [];
  const day = new Date();
  day.setDate(day.getDate() - 29);
  for (let i = 0; i < 30; i++) {
    days.push({ key: dayKey(day), label: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
    day.setDate(day.getDate() + 1);
  }
  const maxDay = Math.max(60, ...days.map((x) => data.perDay.get(x.key) || 0));
  const chart = el('div', { class: 'rr-chart' }, ...days.map((x) => {
    const sec = data.perDay.get(x.key) || 0;
    return el('div', { class: 'rr-bar', title: x.label + ': ' + fmtDuration(sec),
      style: { height: (sec ? Math.max(3, Math.round((sec / maxDay) * 100)) : 0) + '%' } });
  }));

  // Shelf.
  const sortSel = el('select', {},
    el('option', { value: 'recent', textContent: 'Recently read' }),
    el('option', { value: 'time', textContent: 'Most time' }),
    el('option', { value: 'title', textContent: 'Title' }));
  const filterSel = el('select', {},
    el('option', { value: 'all', textContent: 'All books' }),
    el('option', { value: 'reading', textContent: 'Reading' }),
    el('option', { value: 'finished', textContent: 'Finished' }),
    el('option', { value: 'unread', textContent: 'Not started' }));
  const shelfEl = el('div', { class: 'rr-shelf' });
  const detail = el('div');

  const stateOf = (b) => !b.stats ? 'unread' : (b.stats.finishedAt ? 'finished' : 'reading');
  function bookCard(b) {
    const cover = b.cover
      ? el('img', { src: '/download?path=' + encodeURIComponent(b.cover), alt: '', loading: 'lazy' })
      : el('div', { class: 'rr-cover', textContent: b.title });
    if (b.cover) cover.onerror = () => cover.replaceWith(el('div', { class: 'rr-cover', textContent: b.title }));
    const pct = b.stats ? Math.floor(b.stats.bp / 100) : 0;
    const lines = [];
    if (b.author) lines.push(b.author);
    if (b.stats) {
      lines.push((b.stats.finishedAt ? 'Finished' : pct + '%') + ' · ' + fmtDuration(b.stats.seconds));
      lines.push('Last read ' + fmtDate(b.stats.last));
    } else {
      lines.push('Not started');
    }
    if (!b.onCard) lines.push('Not on the card');
    const card = el('div', { class: 'rr-book' }, cover,
      el('div', { class: 'rr-title', textContent: b.title }),
      b.stats ? el('div', { class: 'rr-prog' }, el('div', { style: { width: pct + '%' } })) : null,
      ...lines.map((t) => el('div', { class: 'rr-meta', textContent: t })));
    card.onclick = () => showBook(b);
    return card;
  }
  function renderShelf() {
    const f = filterSel.value;
    const list = data.books.filter((b) => f === 'all' || stateOf(b) === f);
    const by = sortSel.value;
    list.sort((a, b) => {
      if (by === 'time') return ((b.stats && b.stats.seconds) || 0) - ((a.stats && a.stats.seconds) || 0);
      if (by === 'recent') {
        const d = ((b.stats && b.stats.last) || 0) - ((a.stats && a.stats.last) || 0);
        if (d) return d;
      }
      return a.title.localeCompare(b.title);
    });
    shelfEl.replaceChildren(...list.map(bookCard));
    if (!list.length) shelfEl.append(el('p', { class: 'rr-meta', textContent: 'No books here yet.' }));
  }
  function showBook(b) {
    const rows = sessions.filter((s) => data.canonical(s.book) === b.path).reverse();
    detail.replaceChildren(
      el('h3', { textContent: b.title }),
      el('p', { class: 'rr-meta', textContent: b.path }),
      b.formerPaths.length
        ? el('p', { class: 'rr-meta', textContent: 'Earlier at: ' + b.formerPaths.join(', ') }) : null,
      rows.length
        ? el('table', { class: 'rr-table' },
          el('tr', {}, ...['Date', 'Time read', 'Progress'].map((t) => el('th', { textContent: t }))),
          ...rows.map((s) => el('tr', {},
            el('td', { textContent: new Date(s.start_time * 1000).toLocaleString() }),
            el('td', { textContent: fmtDuration(s.duration_seconds) }),
            el('td', { textContent: Math.floor(s.start_progress_bp / 100) + '% → ' +
              Math.floor(s.end_progress_bp / 100) + '%' }))))
        : el('p', { class: 'rr-meta', textContent: 'No reading sessions recorded for this book yet.' }));
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  sortSel.onchange = renderShelf;
  filterSel.onchange = renderShelf;

  const download = (name, text, type) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const csvCell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const exportBtn = el('button', { type: 'button', textContent: 'Download sessions (CSV)' });
  exportBtn.onclick = () => {
    const titles = new Map(data.books.map((b) => [b.path, b]));
    const header = ['start', 'end', 'minutes', 'title', 'author', 'book', 'from_percent', 'to_percent'];
    const lines = sessions.map((s) => {
      const b = titles.get(data.canonical(s.book)) || {};
      return [new Date(s.start_time * 1000).toISOString(), new Date(s.end_time * 1000).toISOString(),
        (s.duration_seconds / 60).toFixed(1), b.title || '', b.author || '', s.book,
        (s.start_progress_bp / 100).toFixed(1), (s.end_progress_bp / 100).toFixed(1)].map(csvCell).join(',');
    });
    download('reading-sessions.csv', '﻿' + [header.join(',')].concat(lines).join('\r\n') + '\r\n',
      'text/csv;charset=utf-8');
  };

  body.replaceChildren(
    tiles,
    el('h3', { textContent: 'Last 30 days' }), chart,
    el('div', { class: 'rr-meta', textContent: days[0].label + ' – today' }),
    el('h3', { textContent: 'Bookshelf' }),
    el('div', { class: 'rr-tools' }, filterSel, sortSel, exportBtn),
    shelfEl, detail);
  renderShelf();
});
