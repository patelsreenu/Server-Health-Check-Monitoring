'use strict';

/**
 * historyStore.js
 * ───────────────
 * Persists every health snapshot so trends, forecasts and AI analysis have
 * something to work with.  Uses Node's built-in node:sqlite (Node 22.5+), so
 * there is no native dependency to compile.
 *
 * Tables
 *   samples       one row per refresh per server (cpu, mem, worst disk, status…)
 *   disk_samples  one row per drive per refresh (needed for per-drive forecasts)
 *   events        status transitions (healthy→critical, etc.) with timestamps
 *
 * All analysis reads hourly buckets (see hourlySeries) so cost stays flat no
 * matter how often a server is polled.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.HISTORY_DIR || path.resolve(__dirname, '../data');
const DB_PATH  = path.join(DATA_DIR, 'history.db');

const RETENTION_DAYS  = parseInt(process.env.HISTORY_RETENTION_DAYS || '30', 10);
const MIN_INTERVAL_MS = 55 * 1000;            // POS refreshes every 30 s — keep ~1/min
const HOUR_MS         = 3600 * 1000;

const exclusions = require('./exclusions');

let db = null;
let stmts = null;
const _lastWrite  = new Map();   // serverId → ts of last sample written
const _lastStatus = new Map();   // serverId → last known status

function init() {
  if (db) return db;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (err) {
    console.error(`[history] node:sqlite unavailable (${err.message}) — history disabled`);
    return null;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    CREATE TABLE IF NOT EXISTS samples (
      server_id    TEXT    NOT NULL,
      ts           INTEGER NOT NULL,
      status       TEXT,
      cpu          REAL,
      mem_pct      REAL,
      max_disk_pct REAL,
      uptime_days  REAL,
      winrm_up     INTEGER,
      rdp_up       INTEGER,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_samples ON samples (server_id, ts);
    CREATE TABLE IF NOT EXISTS disk_samples (
      server_id TEXT    NOT NULL,
      ts        INTEGER NOT NULL,
      drive     TEXT    NOT NULL,
      used_pct  REAL,
      size_gb   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_disk ON disk_samples (server_id, drive, ts);
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      kind        TEXT    NOT NULL,
      from_status TEXT,
      to_status   TEXT,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events ON events (server_id, ts);
    CREATE TABLE IF NOT EXISTS auto_tickets (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      key       TEXT    NOT NULL,
      opened_ts INTEGER NOT NULL,
      closed_ts INTEGER,
      mode      TEXT    NOT NULL,
      number    TEXT,
      sys_id    TEXT,
      url       TEXT,
      title     TEXT,
      body      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_tickets ON auto_tickets (key, opened_ts);
  `);

  stmts = {
    insSample: db.prepare(`INSERT INTO samples
      (server_id, ts, status, cpu, mem_pct, max_disk_pct, uptime_days, winrm_up, rdp_up, error)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    insDisk:   db.prepare(`INSERT INTO disk_samples (server_id, ts, drive, used_pct, size_gb) VALUES (?,?,?,?,?)`),
    insEvent:  db.prepare(`INSERT INTO events (server_id, ts, kind, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`),
    lastStatus: db.prepare(`SELECT status FROM samples WHERE server_id = ? ORDER BY ts DESC LIMIT 1`),
    hourly: db.prepare(`
      SELECT (ts / ${HOUR_MS}) * ${HOUR_MS} AS ts,
             AVG(cpu) AS cpu, AVG(mem_pct) AS mem, MAX(max_disk_pct) AS disk,
             MAX(uptime_days) AS uptime, COUNT(*) AS n
        FROM samples
       WHERE server_id = ? AND ts >= ? AND status != 'error'
       GROUP BY ts / ${HOUR_MS} ORDER BY ts`),
    hourlyDisk: db.prepare(`
      SELECT drive, (ts / ${HOUR_MS}) * ${HOUR_MS} AS ts,
             MAX(used_pct) AS used_pct, MAX(size_gb) AS size_gb
        FROM disk_samples
       WHERE server_id = ? AND ts >= ?
       GROUP BY drive, ts / ${HOUR_MS} ORDER BY drive, ts`),
    recent:  db.prepare(`SELECT ts, status, cpu, mem_pct, max_disk_pct, error FROM samples WHERE server_id = ? ORDER BY ts DESC LIMIT ?`),
    events:  db.prepare(`SELECT ts, kind, from_status, to_status, detail FROM events WHERE server_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`),
    ids:     db.prepare(`SELECT DISTINCT server_id FROM samples WHERE ts >= ?`),
    maxTs: db.prepare(`SELECT server_id, MAX(ts) AS ts FROM samples GROUP BY server_id`),
    rowAt: db.prepare(`SELECT server_id, status, ts, error, cpu, mem_pct, max_disk_pct FROM samples WHERE server_id = ? AND ts = ? LIMIT 1`),
    latestAll: db.prepare(`
      SELECT s.server_id, s.status, s.ts, s.error, s.cpu, s.mem_pct, s.max_disk_pct FROM samples s
       WHERE s.ts >= ? AND s.ts = (SELECT MAX(ts) FROM samples WHERE server_id = s.server_id)`),
    lastGood: db.prepare(`SELECT ts FROM samples WHERE server_id = ? AND status NOT IN ('critical','error') ORDER BY ts DESC LIMIT 1`),
    lastRead: db.prepare(`SELECT ts FROM samples WHERE server_id = ? AND status != 'error' ORDER BY ts DESC LIMIT 1`),
    topDisk: db.prepare(`SELECT drive, used_pct FROM disk_samples WHERE server_id = ? AND ts >= ? ORDER BY used_pct DESC LIMIT 1`),
    lastEnter: db.prepare(`SELECT ts FROM events WHERE server_id = ? AND kind = 'status_change' AND to_status = ? ORDER BY ts DESC LIMIT 1`),
    firstSample: db.prepare(`SELECT MIN(ts) AS ts FROM samples WHERE server_id = ?`),
    firstAfter: db.prepare(`SELECT MIN(ts) AS ts FROM samples WHERE server_id = ? AND ts > ?`),
    atInsert: db.prepare(`INSERT INTO auto_tickets (key, opened_ts, mode, number, sys_id, url, title, body) VALUES (?,?,?,?,?,?,?,?)`),
    atOpen:   db.prepare(`SELECT * FROM auto_tickets WHERE key = ? AND closed_ts IS NULL ORDER BY opened_ts DESC LIMIT 1`),
    atLast:   db.prepare(`SELECT * FROM auto_tickets WHERE key = ? ORDER BY opened_ts DESC LIMIT 1`),
    atClose:  db.prepare(`UPDATE auto_tickets SET closed_ts = ? WHERE id = ?`),
    atList:   db.prepare(`SELECT * FROM auto_tickets ORDER BY opened_ts DESC LIMIT ?`),
    atOpenAll: db.prepare(`SELECT * FROM auto_tickets WHERE closed_ts IS NULL`),
    prune1:  db.prepare(`DELETE FROM samples      WHERE ts < ?`),
    prune2:  db.prepare(`DELETE FROM disk_samples WHERE ts < ?`),
    prune3:  db.prepare(`DELETE FROM events       WHERE ts < ?`)
  };

  setTimeout(ensureIndexes, 30 * 1000).unref();
  setTimeout(prune, 60 * 1000).unref();   // after startup — a full scan here used to freeze the app for ~30 s
  setInterval(prune, 24 * HOUR_MS).unref();
  console.log(`[history] ${DB_PATH} (retention ${RETENTION_DAYS}d)`);
  return db;
}

/**
 * Covering index for per-server disk time ranges (forecasts, current worst disk).  The older (server, drive, ts)
 * index cannot seek by time, so each lookup read every row for the server.  Built once, shortly after startup,
 * because creating it on millions of rows takes a few seconds.
 */
function ensureIndexes() {
  if (!db) return;
  try {
    const t = Date.now();
    const had = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_disk_cover'").get();
    db.exec('CREATE INDEX IF NOT EXISTS idx_disk_cover ON disk_samples (server_id, ts, drive, used_pct, size_gb)');
    if (!had) console.log(`[history] built idx_disk_cover in ${Date.now() - t} ms`);
  } catch (err) { console.error(`[history] index build failed: ${err.message}`); }
}

/**
 * Delete rows older than `cutoff`.  Rows are inserted in time order, so rowid rises with ts: a binary
 * search on rowid finds the boundary in ~25 lookups instead of scanning millions of rows for `ts < ?`.
 */
function pruneTable(table, cutoff) {
  const bounds = db.prepare(`SELECT MIN(rowid) lo, MAX(rowid) hi FROM ${table}`).get();
  if (bounds.lo == null) return;
  const tsAt = db.prepare(`SELECT ts FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`);
  let lo = bounds.lo, hi = bounds.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = tsAt.get(mid);
    if (!row || row.ts >= cutoff) hi = mid; else lo = mid + 1;
  }
  db.prepare(`DELETE FROM ${table} WHERE rowid < ? AND ts < ?`).run(lo, cutoff);
}

function prune() {
  if (!db) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * HOUR_MS;
  try { pruneTable('samples', cutoff); pruneTable('disk_samples', cutoff); stmts.prune3.run(cutoff); }
  catch (err) { console.error(`[history] prune failed: ${err.message}`); }
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

/**
 * Record one health snapshot.  Never throws — history must not break monitoring.
 * @param {object} server  config entry (needs .id)
 * @param {object} health  result of service.getServerHealth
 * @param {object} probe   result of probeServer
 */
function record(server, health, probe) {
  try {
    if (!init() || !server?.id || !health) return;
    const now = Date.now();
    if (now - (_lastWrite.get(server.id) || 0) < MIN_INTERVAL_MS) return;
    _lastWrite.set(server.id, now);

    const status = health.status || 'error';
    // Previous status: in-memory, or the last row on disk after a restart.
    let prev = _lastStatus.get(server.id);
    if (prev === undefined) prev = stmts.lastStatus.get(server.id)?.status ?? null;
    const m      = health.metrics || {};
    const disks  = Array.isArray(health.disks) ? health.disks : [];
    const maxDisk = disks.length ? Math.max(...disks.map(d => num(d.usedPct) ?? 0)) : num(m.maxDiskPct);

    stmts.insSample.run(
      server.id, now, status,
      num(m.cpu), num(m.memUsedPct), maxDisk, num(health.uptimeDays),
      probe?.winrm === 'up' ? 1 : 0, probe?.rdp === 'up' ? 1 : 0,
      health.error ? String(health.error).slice(0, 300) : null
    );
    for (const d of disks) {
      if (d.drive && num(d.usedPct) != null) stmts.insDisk.run(server.id, now, d.drive, d.usedPct, num(d.sizeGB));
    }

    if (prev !== null && prev !== status) {
      stmts.insEvent.run(server.id, now, 'status_change', prev, status, health.error ? String(health.error).slice(0, 300) : null);
    }
    _lastStatus.set(server.id, status);
  } catch (err) {
    console.error(`[history] record failed for ${server?.id}: ${err.message}`);
  }
}

// ── Queries ────────────────────────────────────────────────────────────────────
function hourlySeries(serverId, days = 14) {
  if (!init()) return [];
  return stmts.hourly.all(serverId, Date.now() - days * 24 * HOUR_MS);
}

function hourlyDiskSeries(serverId, days = 14) {
  if (!init()) return {};
  const rows = stmts.hourlyDisk.all(serverId, Date.now() - days * 24 * HOUR_MS);
  const byDrive = {};
  for (const r of rows) (byDrive[r.drive] ||= []).push(r);
  return byDrive;
}

function recentSamples(serverId, limit = 10) {
  return init() ? stmts.recent.all(serverId, limit) : [];
}

function events(serverId, days = 7, limit = 50) {
  return init() ? stmts.events.all(serverId, Date.now() - days * 24 * HOUR_MS, limit) : [];
}

function knownServerIds(days = 2) {
  return init() ? stmts.ids.all(Date.now() - days * 24 * HOUR_MS).map(r => r.server_id).filter(id => !exclusions.isExcluded(id)) : [];
}

/** Latest status per server that reported within `days`. */
function latestStatuses(days = 1) {
  if (!init()) return [];
  // Newest row per server via the (server_id, ts) index.  The single-statement form
  // (ts = (SELECT MAX(ts) ...)) read the whole table and took over a second at this size.
  const cutoff = Date.now() - days * 24 * HOUR_MS;
  const out = [];
  for (const m of stmts.maxTs.all()) {
    if (m.ts < cutoff || exclusions.isExcluded(m.server_id)) continue;
    const row = stmts.rowAt.get(m.server_id, m.ts);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Servers whose latest status is critical/error, with when that run of bad samples began.
 *   neverHealthy  no healthy/warning sample on record — it has been bad since monitoring began,
 *                 so `since` is just the first sample, not a real failure time
 *   neverRead     every sample was an 'error' — the monitor has never been able to read it
 */
let _badCache = { at: 0, rows: [] };
function currentlyBad() {
  if (!init()) return [];
  if (Date.now() - _badCache.at < 30 * 1000) return _badCache.rows;
  const rows = computeCurrentlyBad();
  _badCache = { at: Date.now(), rows };
  return rows;
}

function computeCurrentlyBad() {
  return latestStatuses(1)
    .filter(r => r.status === 'critical' || r.status === 'error')
    .map(r => {
      const good = stmts.lastGood.get(r.server_id)?.ts || 0;
      const since = good
        ? (stmts.firstAfter.get(r.server_id, good)?.ts || r.ts)
        : (stmts.firstSample.get(r.server_id)?.ts || r.ts);
      const top = r.max_disk_pct >= 85 ? stmts.topDisk.get(r.server_id, r.ts - 2 * 60 * 1000) : null;
      return {
        serverId: r.server_id, status: r.status, since, error: r.error || '',
        lastGood: good || null, neverHealthy: !good,
        neverRead: !stmts.lastRead.get(r.server_id)?.ts,
        cpu: r.cpu, mem: r.mem_pct, disk: r.max_disk_pct, diskDrive: top?.drive || null
      };
    });
}

// ── Auto-ticket log (dedupe + audit trail for ServiceNow enrichment) ───────────
function openAutoTicket(key)  { return init() ? stmts.atOpen.get(key) || null : null; }
function lastAutoTicket(key)  { return init() ? stmts.atLast.get(key) || null : null; }
function openAutoTickets()    { return init() ? stmts.atOpenAll.all() : []; }
function listAutoTickets(limit = 50) { return init() ? stmts.atList.all(limit) : []; }
function closeAutoTicket(id)  { if (init()) stmts.atClose.run(Date.now(), id); }
function saveAutoTicket({ key, mode, number = null, sysId = null, url = null, title, body }) {
  if (init()) stmts.atInsert.run(key, Date.now(), mode, number, sysId, url, title, body);
}

/**
 * When the server entered its current status: the latest status_change event into it (small, indexed table),
 * or the first sample on record if it has never changed.
 */
function statusSince(serverId, status) {
  if (!init()) return null;
  return stmts.lastEnter.get(serverId, status)?.ts || stmts.firstSample.get(serverId)?.ts || null;
}

/** The open database handle, for services that keep their own small tables alongside the history. */
function rawDb() { return init() ? db : null; }

module.exports = { statusSince, rawDb, latestStatuses, currentlyBad, openAutoTicket, lastAutoTicket, openAutoTickets, listAutoTickets, closeAutoTicket, saveAutoTicket, init, record, hourlySeries, hourlyDiskSeries, recentSamples, events, knownServerIds, HOUR_MS };
