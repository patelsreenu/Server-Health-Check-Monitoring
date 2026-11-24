'use strict';

/**
 * endpointMonitor.js
 * ──────────────────
 * Calls each URL in config/endpoints.json on a schedule and emails ALERT_TO when one
 * stops returning the expected HTTP status (default 200), and again when it recovers.
 *
 *   • Down is declared after `failAfter` consecutive failed checks (default 2) so a single blip
 *     does not page anyone.  A failure is: wrong status, no answer within timeoutSec, connection
 *     refused, DNS or TLS error, or (if expectText is set) the text missing from the page.
 *   • While an endpoint stays down a reminder is sent every ALERT_REMIND_HOURS (default 12).
 *   • Delivery uses the same SMTP settings and dry-run switch as alertService.
 *
 * Checks are plain GET requests made from this server.  Results are kept 30 days in the history
 * database (tables endpoint_state / endpoint_checks).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const store = require('./historyStore');
const alerts = require('./alertService');

const CONFIG_FILE = process.env.ENDPOINTS_FILE || path.join(__dirname, '../config/endpoints.json');
const REMIND_MS   = parseFloat(process.env.ALERT_REMIND_HOURS || '12') * 3600 * 1000;
const SEND_RECOVERY = !/^(0|false|off|no)$/i.test(process.env.ENDPOINT_SEND_RECOVERY || '');
const TICK_MS     = 15 * 1000;
const RETENTION_MS = 30 * 24 * 3600 * 1000;

let _db = null, _timer = null;
const _lastRun = new Map();    // id → ms of last check start
const _running = new Set();
const _live = new Map();       // id → latest check result (for the status endpoint)

function load() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return (cfg.endpoints || []).filter(e => e && e.id && e.url);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[endpoints] cannot read ${CONFIG_FILE}: ${err.message}`);
    return [];
  }
}

function db() {
  if (_db) return _db;
  const raw = store.rawDb();
  if (!raw) return null;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS endpoint_state (
      id TEXT PRIMARY KEY, down INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
      down_since INTEGER, last_sent INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS endpoint_checks (
      id TEXT NOT NULL, ts INTEGER NOT NULL, ok INTEGER NOT NULL, code INTEGER, ms INTEGER, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_endpoint_checks ON endpoint_checks (id, ts);
  `);
  _db = {
    getState: raw.prepare('SELECT * FROM endpoint_state WHERE id = ?'),
    putState: raw.prepare('INSERT OR REPLACE INTO endpoint_state (id, down, fails, down_since, last_sent) VALUES (?,?,?,?,?)'),
    addCheck: raw.prepare('INSERT INTO endpoint_checks (id, ts, ok, code, ms, detail) VALUES (?,?,?,?,?,?)'),
    recent:   raw.prepare('SELECT ts, ok, code, ms, detail FROM endpoint_checks WHERE id = ? ORDER BY ts DESC LIMIT ?'),
    stats24:  raw.prepare('SELECT COUNT(*) n, SUM(ok) good, AVG(CASE WHEN ok = 1 THEN ms END) avg_ms FROM endpoint_checks WHERE id = ? AND ts >= ?'),
    prune:    raw.prepare('DELETE FROM endpoint_checks WHERE ts < ?')
  };
  return _db;
}

// ── One check ─────────────────────────────────────────────────────────────────
const reason = (code, msg) => ({
  ECONNREFUSED: 'Connection refused (nothing listening on that port)',
  ENOTFOUND: 'DNS name not found', EAI_AGAIN: 'DNS lookup failed',
  ECONNRESET: 'Connection reset by the server', EHOSTUNREACH: 'Host unreachable',
  ETIMEDOUT: 'Connection timed out', ECONNABORTED: 'Timed out waiting for a response',
  CERT_HAS_EXPIRED: 'Certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'Untrusted (self-signed) certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Certificate not trusted', ERR_TLS_CERT_ALTNAME_INVALID: 'Certificate name does not match'
}[code] || msg || 'Request failed');

async function runCheck(ep) {
  const expect = [].concat(ep.expectStatus ?? 200).map(Number);
  const timeout = (ep.timeoutSec || 15) * 1000;
  const started = Date.now();
  try {
    const res = await axios.request({
      url: ep.url, method: ep.method || 'GET', timeout, maxRedirects: 0,
      validateStatus: () => true, responseType: 'text', maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'HealthMonitor/2 endpoint-check' },
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: !ep.insecureTls })
    });
    const ms = Date.now() - started;
    const statusText = http.STATUS_CODES[res.status] || '';
    let ok = expect.includes(res.status);
    let detail = `${res.status} - ${statusText}`.trim();
    if (ok && ep.expectText && !String(res.data ?? '').includes(ep.expectText)) {
      ok = false; detail = `${res.status} - ${statusText}, but the expected text was not in the page`;
    } else if (!ok) {
      detail += ` (expected ${expect.join(' or ')})`;
    }
    return { ok, code: res.status, ms, detail };
  } catch (err) {
    return { ok: false, code: null, ms: Date.now() - started, detail: reason(err.code, err.message) + (err.code === 'ECONNABORTED' ? ` (${ep.timeoutSec || 15}s)` : '') };
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`; };

function buildMail(ep, kind, r, extra = {}) {
  const up = kind === 'up';
  const mark = up ? '✅' : '❌';
  const word = up ? 'Up' : 'Down';
  const head = `${ep.url} is [${ep.name || ep.id}] [${mark} ${word}] ${r.detail}`;
  const lines = [head, ''];
  if (!up) {
    lines.push(`Failing since: ${new Date(extra.since).toLocaleString('en-AU')} (${dur(Date.now() - extra.since)})`);
    if (kind === 'reminder') lines.push('This is a reminder — the endpoint is still down.');
  } else {
    lines.push(`It was down for ${dur(extra.downMs)}.`);
  }
  lines.push(`Response time: ${r.ms} ms`, 'Checked from the Health Monitor (GET request).');
  const subject = up ? `[${ep.name || ep.id}] ✅ Up — ${r.detail}` : `[${ep.name || ep.id}] ❌ Down — ${r.detail}`;
  return {
    subject, text: lines.join('\n'),
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;color:#222;font-size:15px"><p style="font-size:16px"><a href="${esc(ep.url)}">${esc(ep.url)}</a> is [${esc(ep.name || ep.id)}] [${mark} ${word}] ${esc(r.detail)}</p>
      <p style="color:#555;font-size:15px">${lines.slice(2).map(esc).join('<br>')}</p></div>`
  };
}

// ── State machine ─────────────────────────────────────────────────────────────
async function step(ep, r, now = Date.now()) {
  const d = db();
  d.addCheck.run(ep.id, now, r.ok ? 1 : 0, r.code, r.ms, r.detail);
  const st = d.getState.get(ep.id) || { id: ep.id, down: 0, fails: 0, down_since: null, last_sent: 0 };
  const failAfter = ep.failAfter || 2;
  let { down, fails, down_since: since, last_sent: lastSent } = st;

  if (r.ok) {
    if (down) {
      const sent = !SEND_RECOVERY || await alerts.sendMail(buildMail(ep, 'up', r, { downMs: now - (since || now) })).catch(err => { console.error(`[endpoints] recovery mail for ${ep.id} failed: ${err.message}`); return false; });
      if (sent) { down = 0; since = null; lastSent = now; }   // otherwise stay "down" so the recovery mail is retried
    }
    if (!down) fails = 0;
  } else {
    if (!fails) since = now;
    fails += 1;
    if (fails >= failAfter) {
      const kind = down ? (REMIND_MS > 0 && now - lastSent >= REMIND_MS ? 'reminder' : null) : 'down';
      if (kind) {
        const sent = await alerts.sendMail(buildMail(ep, kind, r, { since })).catch(err => { console.error(`[endpoints] mail for ${ep.id} failed (will retry): ${err.message}`); return false; });
        if (sent) { down = 1; lastSent = now; }
      }
    }
  }
  d.putState.run(ep.id, down, fails, since, lastSent);
  _live.set(ep.id, { ...r, ts: now, down: !!down, fails, since });
}

/**
 * If this process was frozen (a long synchronous job) the request's timer fires late and the check looks like a
 * timeout.  A result that took far longer than the timeout says nothing about the endpoint, so check again once.
 */
async function checkWithStallGuard(ep) {
  const r = await runCheck(ep);
  if (!r.ok && r.ms > ((ep.timeoutSec || 15) + 5) * 1000) return runCheck(ep);
  return r;
}

async function tick() {
  if (!db()) return;
  const now = Date.now();
  for (const ep of load()) {
    if (_running.has(ep.id) || now - (_lastRun.get(ep.id) || 0) < (ep.intervalSec || 60) * 1000) continue;
    _running.add(ep.id); _lastRun.set(ep.id, now);
    checkWithStallGuard(ep).then(r => step(ep, r)).catch(err => console.error(`[endpoints] ${ep.id}: ${err.message}`)).finally(() => _running.delete(ep.id));
  }
}

function start() {
  if (_timer) return;
  const eps = load();
  if (!store.init() || !eps.length) { if (!eps.length) console.log('[endpoints] none configured'); return; }
  console.log(`[endpoints] monitoring ${eps.length} endpoint(s): ${eps.map(e => e.name || e.id).join(', ')}`);
  _timer = setInterval(() => tick().catch(err => console.error(`[endpoints] ${err.message}`)), TICK_MS);
  _timer.unref();
  tick().catch(() => {});
  setInterval(() => { try { db()?.prune.run(Date.now() - RETENTION_MS); } catch { /* ignore */ } }, 6 * 3600 * 1000).unref();
}

function status() {
  const d = db();
  return load().map(ep => {
    const live = _live.get(ep.id);
    const st = d?.getState.get(ep.id);
    const s24 = d?.stats24.get(ep.id, Date.now() - 24 * 3600 * 1000);
    const last = live || (() => { const r = d?.recent.get(ep.id, 1)[0]; return r ? { ok: !!r.ok, code: r.code, ms: r.ms, detail: r.detail, ts: r.ts } : null; })();
    return {
      id: ep.id, name: ep.name || ep.id, url: ep.url,
      state: !last ? 'pending' : last.ok ? 'up' : (st?.down || (st?.fails || 0) >= (ep.failAfter || 2)) ? 'down' : 'failing',
      code: last?.code ?? null, detail: last?.detail ?? null, ms: last?.ms ?? null,
      lastChecked: last?.ts ? new Date(last.ts).toISOString() : null,
      downSince: st?.down_since ? new Date(st.down_since).toISOString() : null,
      uptime24h: s24?.n ? Math.round((s24.good / s24.n) * 1000) / 10 : null,
      avgMs24h: s24?.avg_ms != null ? Math.round(s24.avg_ms) : null
    };
  });
}

module.exports = { start, tick, step, runCheck, status, buildMail };
