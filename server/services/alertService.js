'use strict';

/**
 * alertService.js
 * ───────────────
 * Emails ALERT_TO when a server breaches:
 *
 *   CPU     > 90 %  warning,  > 95 %  critical   — sustained 45 min
 *   Memory  > 95 %  warning,  > 98 %  critical   — sustained 30 min
 *   Disk    free <= 10 % warning, free <= 5 % critical  (per drive, immediate)
 *
 * It reads the samples the history store already records (about one per minute per
 * server), so it adds no load on the monitored servers.  "Sustained" means every
 * sample in the window breached the threshold, with no monitoring gap > MAX_GAP.
 *
 * One digest email per cycle.  An alert is sent when it first fires, when it
 * escalates warning → critical, and again every ALERT_REMIND_HOURS while it stays
 * active.  A failed send is retried next cycle.  Nothing here touches ServiceNow.
 *
 * Config (.env):
 *   SMTP_HOST            required to send (unset = alerts are evaluated and logged only)
 *   SMTP_PORT            25
 *   SMTP_SECURE          true for implicit TLS (port 465)
 *   SMTP_USER/SMTP_PASS  optional
 *   ALERT_FROM           required, e.g. "Health Monitor <monitor@example.com>"
 *   ALERT_TO             required, comma-separated recipients
 *   ALERT_REMIND_HOURS   12   (0 = never repeat)
 *   ALERT_SEND_RESOLVED  true to also email when an alert clears (default false)
 *   ALERT_DRY_RUN        true to log the email instead of sending it
 */

const nodemailer = require('nodemailer');
const store = require('./historyStore');
const { loadServers, loadPos } = require('./excelConfig');
const exclusions = require('./exclusions');

const RULES = {
  cpu:  { label: 'CPU utilization',  warn: 90, crit: 95, minutes: 45, column: 'cpu' },
  mem:  { label: 'Memory usage',     warn: 95, crit: 98, minutes: 30, column: 'mem_pct' }
};
const DISK = { warnFreePct: 10, critFreePct: 5 };

const TO          = process.env.ALERT_TO   || '';
const FROM        = process.env.ALERT_FROM || 'Health Monitor <health-monitor@localhost>';
const REMIND_MS   = parseFloat(process.env.ALERT_REMIND_HOURS || '12') * 3600 * 1000;
const SEND_RESOLVED = /^(1|true|on|yes)$/i.test(process.env.ALERT_SEND_RESOLVED || '');
const DRY_RUN     = /^(1|true|on|yes)$/i.test(process.env.ALERT_DRY_RUN || '');
const TICK_MS     = 60 * 1000;
const MAX_GAP_MS  = 15 * 60 * 1000;   // a longer hole in the samples breaks a "sustained" run
const LOOKBACK_MS = 3 * 3600 * 1000;   // longer than the longest rule window (45 min) with room for gaps

const SEV = { warning: 1, critical: 2 };

let _db = null;
let _timer = null;
let _transport = null;
let _warnedNoSmtp = false;
let _active = [];   // last evaluation, for the status endpoint

// ── Persistence (own tables in the history database) ──────────────────────────
function state() {
  if (_db) return _db;
  const db = store.rawDb();
  if (!db) return null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_state (
      key        TEXT PRIMARY KEY,
      level      TEXT NOT NULL,
      first_ts   INTEGER NOT NULL,
      last_sent  INTEGER NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE alert_state ADD COLUMN detail TEXT'); } catch { /* column already there */ }
  _db = {
    get:  db.prepare('SELECT * FROM alert_state WHERE key = ?'),
    all:  db.prepare('SELECT * FROM alert_state'),
    put:  db.prepare('INSERT OR REPLACE INTO alert_state (key, level, first_ts, last_sent, detail) VALUES (?,?,?,?,?)'),
    del:  db.prepare('DELETE FROM alert_state WHERE key = ?'),
    samples: db.prepare('SELECT ts, cpu, mem_pct FROM samples WHERE server_id = ? AND ts >= ? ORDER BY ts DESC'),
    ids:  db.prepare('SELECT DISTINCT server_id FROM samples WHERE ts >= ?'),
    disks: db.prepare(`
      SELECT d.drive, d.used_pct, d.size_gb FROM disk_samples d
      JOIN (SELECT drive, MAX(ts) AS ts FROM disk_samples WHERE server_id = ? AND ts >= ? GROUP BY drive) m
        ON m.drive = d.drive AND m.ts = d.ts
      WHERE d.server_id = ?`)
  };
  return _db;
}

// ── Evaluation ────────────────────────────────────────────────────────────────
/**
 * Length of the unbroken run of samples above `threshold`, ending at the newest sample.
 * `rows` are newest-first.  Null readings (failed probes) are skipped; a gap longer than
 * MAX_GAP_MS ends the run.  Returns { since, minutes, latest } or null if the newest
 * reading is not above the threshold.
 */
function runAbove(rows, column, threshold) {
  const vals = rows.filter(r => typeof r[column] === 'number');
  if (!vals.length || !(vals[0][column] > threshold)) return null;
  let since = vals[0].ts;
  for (let i = 1; i < vals.length; i++) {
    if (!(vals[i][column] > threshold)) break;
    if (vals[i - 1].ts - vals[i].ts > MAX_GAP_MS) break;
    since = vals[i].ts;
  }
  return { since, minutes: (vals[0].ts - since) / 60000, latest: vals[0][column] };
}

function evaluateServer(serverId, now) {
  const db = state();
  const out = [];
  const rows = db.samples.all(serverId, now - LOOKBACK_MS);   // newest first; runs stop at the first non-breach

  for (const [metric, r] of Object.entries(RULES)) {
    const crit = runAbove(rows, r.column, r.crit);
    const warn = runAbove(rows, r.column, r.warn);
    let level = null, run = null;
    if (crit && crit.minutes >= r.minutes) { level = 'critical'; run = crit; }
    else if (warn && warn.minutes >= r.minutes) { level = 'warning'; run = warn; }
    if (level) {
      out.push({
        key: `${serverId}|${metric}`, serverId, metric, level,
        title: `${r.label} ${level === 'critical' ? 'above ' + r.crit : 'above ' + r.warn}%`,
        detail: `${r.label} is ${run.latest}% and has stayed above ${level === 'critical' ? r.crit : r.warn}% for ${Math.round(run.minutes)} minutes (rule: > ${level === 'critical' ? r.crit : r.warn}% for ${r.minutes}+ min).`,
        since: run.since
      });
    }
  }

  for (const d of db.disks.all(serverId, now - 2 * 3600 * 1000, serverId)) {
    if (typeof d.used_pct !== 'number') continue;
    const free = Math.round((100 - d.used_pct) * 10) / 10;
    const level = free <= DISK.critFreePct ? 'critical' : free <= DISK.warnFreePct ? 'warning' : null;
    if (!level) continue;
    const freeGb = d.size_gb ? ` (${(d.size_gb * free / 100).toFixed(1)} GB of ${d.size_gb} GB)` : '';
    out.push({
      key: `${serverId}|disk|${d.drive}`, serverId, metric: 'disk', level,
      title: `Disk ${d.drive} free space ${level === 'critical' ? '≤ 5' : '≤ 10'}%`,
      detail: `Drive ${d.drive} has ${free}% free${freeGb} (rule: ${level === 'critical' ? '≤ 5' : '≤ 10'}% free).`,
      since: now
    });
  }
  return out;
}

function evaluateAll(now = Date.now()) {
  const db = state();
  if (!db) return [];
  const all = [];
  for (const { server_id } of db.ids.all(now - 30 * 60 * 1000)) {   // only servers still reporting
    if (exclusions.isExcluded(server_id)) continue;
    try { all.push(...evaluateServer(server_id, now)); }
    catch (err) { console.error(`[alerts] evaluate ${server_id}: ${err.message}`); }
  }
  return all;
}

// ── Email ─────────────────────────────────────────────────────────────────────
function smtpConfigured() { return !!process.env.SMTP_HOST && !!TO; }

function transport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '25', 10),
    secure: /^(1|true|on|yes)$/i.test(process.env.SMTP_SECURE || ''),
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  });
  return _transport;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const { describeServer } = require('./hostName');

function buildEmail(items, resolved, names, info = () => ({})) {
  const crit = items.filter(i => i.level === 'critical');
  const warn = items.filter(i => i.level === 'warning');
  const parts = [];
  if (crit.length) parts.push(`${crit.length} CRITICAL`);
  if (warn.length) parts.push(`${warn.length} WARNING`);
  if (!parts.length) parts.push(`${resolved.length} resolved`);
  const label = i => { const h = info(i.serverId).host; return h && h.toLowerCase() !== String(names(i.serverId)).toLowerCase() ? `${names(i.serverId)} (${h})` : names(i.serverId); };
  const subject = `[Health Monitor] ${parts.join(', ')} — ${[...items, ...resolved].slice(0, 3).map(label).join(', ')}${items.length + resolved.length > 3 ? ' …' : ''}`;

  const hostLine = i => { const d = info(i.serverId); return d.host ? `Host: ${d.host}  (${d.connect}${d.place ? ' · ' + d.place : ''})` : null; };
  const line = i => [
    `${i.level.toUpperCase().padEnd(8)} ${names(i.serverId)}`,
    hostLine(i) && `         ${hostLine(i)}`,
    `         ${i.detail}${i.reminder ? ' (still active)' : ''}${i.escalated ? ' (escalated from warning)' : ''}`
  ].filter(Boolean).join('\n');
  const resolvedLine = i => [
    `RESOLVED ${names(i.serverId)}`,
    hostLine(i) && `         ${hostLine(i)}`,
    `         ${i.detail || i.title || 'No longer over its limit.'}`,
    i.was && `         Earlier: ${i.was}`
  ].filter(Boolean).join('\n');
  const text = [
    `Health Monitor alerts — ${new Date().toISOString()}`,
    '',
    ...(crit.length ? ['CRITICAL', ...crit.map(line), ''] : []),
    ...(warn.length ? ['WARNING', ...warn.map(line), ''] : []),
    ...(resolved.length ? ['RESOLVED', ...resolved.map(resolvedLine), ''] : []),
    'Rules: CPU >90% warning / >95% critical for 45 min; Memory >95% / >98% for 30 min; Disk free <=10% warning / <=5% critical.',
    'This is an automatic message from the Health Monitor.'
  ].join('\n');

  const rows = list => list.map(i => { const d = info(i.serverId); return `<tr>
      <td style="padding:8px 14px 8px 0;border-bottom:1px solid #eee;vertical-align:top"><b>${esc(names(i.serverId))}</b>${d.place ? `<div style="color:#777;font-size:13px">${esc(d.place)}</div>` : ''}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #eee;vertical-align:top;font-family:Consolas,monospace;font-size:15px">${d.host ? esc(d.host) + `<div style="color:#777;font-family:Segoe UI,Arial,sans-serif;font-size:13px">connect via ${esc(d.connect)}</div>` : '<span style="color:#999">—</span>'}</td>
      <td style="padding:8px 0 8px 14px;border-bottom:1px solid #eee;vertical-align:top">${esc(i.detail)}${i.escalated ? ' <i>(escalated from warning)</i>' : ''}${i.reminder ? ' <i>(still active)</i>' : ''}</td></tr>`; }).join('');
  const block = (title, colour, list) => list.length ? `
    <h3 style="margin:18px 0 6px;font-size:17px;color:${colour}">${title} (${list.length})</h3>
    <table style="border-collapse:collapse;font-size:15px"><tr style="text-align:left;color:#777;font-size:13px"><th style="padding:4px 14px 4px 0">Server</th><th style="padding:4px 14px">Host name</th><th style="padding:4px 0 4px 14px">What is wrong</th></tr>${rows(list)}</table>` : '';
  // Resolved items use the same three columns as the alerts: which server, how to reach it, what changed.
  const resolvedRows = resolved.map(i => { const d = info(i.serverId); return `<tr>
      <td style="padding:8px 14px 8px 0;border-bottom:1px solid #eee;vertical-align:top"><b>${esc(names(i.serverId))}</b>${d.place ? `<div style="color:#777;font-size:13px">${esc(d.place)}</div>` : ''}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #eee;vertical-align:top;font-family:Consolas,monospace;font-size:15px">${d.host ? esc(d.host) + `<div style="color:#777;font-family:Segoe UI,Arial,sans-serif;font-size:13px">connect via ${esc(d.connect)}</div>` : '<span style="color:#999">—</span>'}</td>
      <td style="padding:8px 0 8px 14px;border-bottom:1px solid #eee;vertical-align:top">${i.unknown ? '<b style="color:#b54708">Not confirmed. </b>' : ''}${esc(i.detail || i.title || 'No longer over its limit.')}${i.was ? `<div style="color:#777;font-size:13px;margin-top:3px">Earlier: ${esc(i.was)}</div>` : ''}</td></tr>`; }).join('');
  const resolvedBlock = resolved.length ? `
    <h3 style="margin:18px 0 6px;font-size:17px;color:#067647">Resolved (${resolved.length})</h3>
    <table style="border-collapse:collapse;font-size:15px"><tr style="text-align:left;color:#777;font-size:13px"><th style="padding:4px 14px 4px 0">Server</th><th style="padding:4px 14px">Host name</th><th style="padding:4px 0 4px 14px">What changed</th></tr>${resolvedRows}</table>` : '';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#222;font-size:15px">
    <h2 style="margin:0 0 8px;font-size:22px">Health Monitor alerts</h2>
    ${block('Critical', '#b42318', crit)}${block('Warning', '#b54708', warn)}
    ${resolvedBlock}
    <p style="color:#777;font-size:13px;margin-top:22px">Rules: CPU &gt;90% warning / &gt;95% critical for 45 min · Memory &gt;95% / &gt;98% for 30 min · Disk free ≤10% warning / ≤5% critical.<br>Automatic message from the Health Monitor.</p></div>`;
  return { subject, text, html };
}

async function sendDigest(items, resolved, names, info) {
  return sendMail(buildEmail(items, resolved, names, info));
}

/** Send one alert email to ALERT_TO.  Returns true when sent (or logged in dry-run), false when SMTP is not configured. */
async function sendMail(mail) {
  if (DRY_RUN) { console.log(`[alerts] DRY-RUN email to ${TO}: ${mail.subject}\n${mail.text}`); return true; }
  if (!smtpConfigured()) {
    if (!_warnedNoSmtp) { console.warn('[alerts] SMTP_HOST is not set — alerts are being evaluated but no email can be sent'); _warnedNoSmtp = true; }
    return false;
  }
  await transport().sendMail({ from: FROM, to: TO, subject: mail.subject, text: mail.text, html: mail.html });
  console.log(`[alerts] emailed ${TO}: ${mail.subject}`);
  return true;
}

// ── Cycle ─────────────────────────────────────────────────────────────────────
/**
 * Plain-English description of an alert that has cleared: what it was, what the reading is now, and how
 * long it lasted.  If the server has stopped reporting, say so instead of claiming it recovered.
 */
function describeResolved(r, now) {
  const [serverId, metric, drive] = r.key.split('|');
  const lasted = fmtAge(now - r.first_ts);
  const base = { serverId, level: r.level, was: r.detail || null, lasted, title: [metric, drive].filter(Boolean).join(' ') };
  const db = state();
  const gone = { ...base, unknown: true, detail: 'The server has stopped sending readings, so this alert was closed without confirming it recovered. Please check the server.' };
  try {
    if (metric === 'cpu' || metric === 'mem') {
      const rule = RULES[metric];
      const row = db.samples.all(serverId, now - 30 * 60 * 1000).find(x => typeof x[rule.column] === 'number');
      if (!row) return gone;
      return { ...base, detail: `${rule.label} is back to normal at ${row[rule.column]}% (below the ${rule.warn}% warning limit). It had been above the ${r.level === 'critical' ? rule.crit : rule.warn}% limit for about ${lasted}.` };
    }
    if (metric === 'disk') {
      const d = db.disks.all(serverId, now - 2 * 3600 * 1000, serverId).find(x => x.drive === drive);
      if (!d || typeof d.used_pct !== 'number') return gone;
      const free = Math.round((100 - d.used_pct) * 10) / 10;
      const gb = d.size_gb ? ` (${(d.size_gb * free / 100).toFixed(1)} GB of ${d.size_gb} GB)` : '';
      return { ...base, detail: `Drive ${drive} now has ${free}% free${gb}, above the ${DISK.warnFreePct}% warning limit. It had been ${r.level === 'critical' ? 'below ' + DISK.critFreePct : 'at or below ' + DISK.warnFreePct}% free for about ${lasted}.` };
    }
  } catch (err) { console.error(`[alerts] resolved detail for ${r.key}: ${err.message}`); }
  return { ...base, detail: 'No longer over its limit.' };
}

async function tick() {
  const db = state();
  if (!db) return;
  const now = Date.now();
  const cfg = new Map([...loadServers(), ...loadPos()].map(s => [s.id, s]));
  const names = id => cfg.get(id)?.name || id;
  const info = id => describeServer(cfg.get(id));

  const active = evaluateAll(now);
  _active = active;
  const activeKeys = new Set(active.map(a => a.key));
  const known = new Map(db.all.all().map(r => [r.key, r]));

  const toSend = [];
  for (const a of active) {
    const prev = known.get(a.key);
    if (!prev) toSend.push(a);
    else if (SEV[a.level] > SEV[prev.level]) toSend.push({ ...a, escalated: true });
    else if (REMIND_MS > 0 && now - prev.last_sent >= REMIND_MS) toSend.push({ ...a, reminder: true });
  }
  const cleared = [...known.values()].filter(r => !activeKeys.has(r.key));
  const resolved = SEND_RESOLVED ? cleared.map(r => describeResolved(r, now)) : [];

  if (toSend.length || resolved.length) {
    let ok = false;
    try { ok = await sendDigest(toSend, resolved, names, info); }
    catch (err) { console.error(`[alerts] send failed (will retry next cycle): ${err.message}`); }
    if (!ok) { return; }   // keep state unchanged so the same alerts are retried
    for (const a of toSend) db.put.run(a.key, a.level, known.get(a.key)?.first_ts || a.since, now, a.detail);
  }
  // Keep state for downgrades without a mail (critical → warning): record the lower level silently.
  for (const a of active) {
    const prev = known.get(a.key);
    if (prev && SEV[a.level] < SEV[prev.level]) db.put.run(a.key, a.level, prev.first_ts, prev.last_sent, a.detail);
  }
  for (const r of cleared) db.del.run(r.key);
}

function start() {
  if (_timer) return;
  if (!store.init()) return;
  console.log(`[alerts] enabled → ${TO} (${DRY_RUN ? 'dry-run' : smtpConfigured() ? `SMTP ${process.env.SMTP_HOST}` : 'SMTP not configured — evaluate only'})`);
  let running = false;
  _timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (err) { console.error(`[alerts] ${err.message}`); }
    finally { running = false; }
  }, TICK_MS);
  _timer.unref();
}

function status() {
  return {
    recipient: TO, from: FROM,
    smtpConfigured: smtpConfigured(), dryRun: DRY_RUN, remindHours: REMIND_MS / 3600000, sendResolved: SEND_RESOLVED,
    rules: { cpu: RULES.cpu, memory: RULES.mem, disk: DISK },
    active: _active
  };
}

async function sendTest() {
  const mail = { subject: '[Health Monitor] Test alert — please ignore', text: 'This is a test message from the Health Monitor alert service.' };
  if (!smtpConfigured()) throw new Error('SMTP_HOST and ALERT_TO must both be set');
  await transport().sendMail({ from: FROM, to: TO, ...mail });
}

module.exports = { start, tick, status, evaluateAll, runAbove, buildEmail, sendTest, sendMail, describeServer };
