'use strict';

/**
 * sortable.js — click-to-sort column headings for simple tables.
 *
 * Add `data-dom-sort` to a <table>.  Clicking a heading sorts that table's rows; clicking it again reverses
 * the order.  Numbers (87.2%, 20 GB/day) sort as numbers, text sorts A→Z, blanks always go last.  A table that
 * the page re-draws keeps its chosen order.  A cell can override what it sorts by with data-sort-value.
 *
 * Tables whose rows are cut to a "show first N" list sort their data in the page code instead (see ai.js), and
 * the subnet server table sorts in subnet.js — neither uses this file.
 */
(() => {
  const prefs = new Map();      // table key → { col, dir }
  let busy = false;

  const keyOf = t => t.dataset.domSort || t.id || (t.closest('[id]')?.id + ':' + [...document.querySelectorAll('table[data-dom-sort]')].indexOf(t));
  const bodyRows = t => [...(t.tBodies[0]?.rows || [])];
  const placeholder = tr => [...tr.cells].some(c => c.colSpan > 1);   // "Loading…" / "No results" rows

  function parse(td) {
    const raw = (td.dataset.sortValue ?? td.textContent).trim();
    if (raw === '' || raw === '—' || raw === '-') return null;
    const m = /^(-?\d+(?:\.\d+)?)/.exec(raw);
    return { raw: raw.toLowerCase(), num: m ? parseFloat(m[1]) : null };
  }

  function sortTable(t, col, dir) {
    const rows = bodyRows(t);
    if (rows.length < 2 || rows.some(placeholder)) return;
    const vals = rows.map(r => parse(r.cells[col] || { textContent: '', dataset: {} }));
    const numeric = vals.every(v => v === null || v.num !== null);
    const sorted = rows.map((r, i) => ({ r, v: vals[i], i })).sort((a, b) => {
      if (!a.v || !b.v) return !a.v && !b.v ? a.i - b.i : !a.v ? 1 : -1;    // blanks last in either direction
      const c = numeric ? a.v.num - b.v.num : a.v.raw.localeCompare(b.v.raw, undefined, { numeric: true });
      return c * dir || a.i - b.i;
    });
    busy = true;
    const body = t.tBodies[0];
    sorted.forEach(x => body.appendChild(x.r));
    mark(t, col, dir);
    observer.takeRecords();
    busy = false;
  }

  function mark(t, col, dir) {
    [...t.tHead.rows[0].cells].forEach((th, i) => {
      th.classList.toggle('sorted-asc', i === col && dir > 0);
      th.classList.toggle('sorted-desc', i === col && dir < 0);
    });
  }

  function prepare(t) {
    if (!t.tHead) return;
    [...t.tHead.rows[0].cells].forEach(th => { if (th.textContent.trim()) { th.classList.add('dom-sortable'); th.title = 'Click to sort'; } });
    const p = prefs.get(keyOf(t));
    if (p) sortTable(t, p.col, p.dir);
  }

  document.addEventListener('click', e => {
    const th = e.target.closest('table[data-dom-sort] th.dom-sortable');
    if (!th) return;
    const t = th.closest('table'), col = th.cellIndex, key = keyOf(t), p = prefs.get(key);
    const dir = p && p.col === col ? -p.dir : 1;
    prefs.set(key, { col, dir });
    sortTable(t, col, dir);
  });

  // Pages redraw their tables by replacing rows (or the whole table): re-apply the chosen order.
  const observer = new MutationObserver(() => {
    if (busy) return;
    document.querySelectorAll('table[data-dom-sort]').forEach(t => {
      const p = prefs.get(keyOf(t));
      if (!t.tHead?.rows[0]?.cells[0]?.classList.contains('dom-sortable')) prepare(t);
      else if (p) sortTable(t, p.col, p.dir);   // idempotent, so running it after an unrelated change is harmless
    });
  });
  const start = () => { document.querySelectorAll('table[data-dom-sort]').forEach(prepare); observer.observe(document.body, { childList: true, subtree: true }); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
