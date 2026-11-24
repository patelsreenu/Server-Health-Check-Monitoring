'use strict';

/**
 * ticketWatcher.js
 * ────────────────
 * Opens a ServiceNow incident, pre-filled with the AI/forecast analysis, when a
 * server (or a correlated group of servers) stays critical/error for a while.
 *
 * Creating tickets is an outward-facing side effect, so it is OPT-IN:
 *
 *   AI_AUTO_TICKETS=off       (default) do nothing
 *   AI_AUTO_TICKETS=dry-run   build the ticket and store it, but do not send it
 *   AI_AUTO_TICKETS=on        create the ServiceNow incident
 *
 *   AI_TICKET_AFTER_MIN       how long a failure must persist first (10)
 *   AI_TICKET_COOLDOWN_MIN    after recovery, don't re-ticket the same key for (360)
 *   AI_TICKET_MAX_PER_TICK    safety cap per 60 s cycle (5)
 *
 * One ticket per correlated incident, not per server.  Each key has at most one
 * open ticket; it is marked closed locally when the failure clears (the
 * ServiceNow ticket is left for a human to resolve).
 */

const store = require('./historyStore');
const { correlate } = require('./correlation');
const snService = require('./servicenowService');
const ai = require('./aiService');
const { loadServers, loadPos } = require('./excelConfig');

// Automatic incident creation is deliberately DISABLED until a rules layer exists
// (decided with the owner: incidents are raised by a person via the "Raise
// incident" button).  'on' is therefore downgraded to 'dry-run'; the create path
// below is kept for when rules are added.  To enable later, replace this line
// with `const MODE = REQUESTED_MODE;` once rules gate tick().
const REQUESTED_MODE = (process.env.AI_AUTO_TICKETS || 'off').toLowerCase();
const MODE = REQUESTED_MODE === 'dry-run' ? 'dry-run' : 'off';
if (REQUESTED_MODE === 'on') console.warn('[ticketWatcher] AI_AUTO_TICKETS=on ignored — automatic incident creation is disabled; running dry-run only');
const AFTER_MS     = parseInt(process.env.AI_TICKET_AFTER_MIN    || '10',  10) * 60 * 1000;
const COOLDOWN_MS  = parseInt(process.env.AI_TICKET_COOLDOWN_MIN || '360', 10) * 60 * 1000;
const MAX_PER_TICK = parseInt(process.env.AI_TICKET_MAX_PER_TICK || '5',   10);
const TICK_MS      = 60 * 1000;

let _timer = null;
let _warnedUnconfigured = false;

function configById() {
  return new Map([...loadServers(), ...loadPos()].map(s => [s.id, s]));
}

/** Correlated incidents right now (used by the route and by the watcher). */
function currentIncidents() {
  return correlate({ bad: store.currentlyBad(), latest: store.latestStatuses(1), cfg: configById() });
}

// ── Ticket text ────────────────────────────────────────────────────────────────
function forecastLines(f) {
  const out = [];
  for (const d of f?.disks || []) {
    if (d.daysTo95 != null) out.push(`Disk ${d.drive} at ${d.currentPct}%, growing ${d.growthPctPerDay}%/day → 95% in ~${d.daysTo95} days (${d.confidence} confidence)`);
  }
  if (f?.memory?.leakSuspected) out.push(`Memory climbing ${f.memory.growthPctPerDay}%/day since last reboot (${f.memory.currentPct}% now)`);
  for (const a of f?.anomalies || []) if (a.anomalous) out.push(`${a.metric.toUpperCase()} ${a.current}% vs usual ${a.baseline}% for this hour`);
  if (f?.flapping?.flapping) out.push(`${f.flapping.count7d} failures in the last 7 days`);
  return out;
}

function aiLines(result) {
  const a = result?.analysis;
  if (!a) return [];
  const lines = [
    `AI SUMMARY (${result.model}, ${a.confidence} confidence): ${a.summary}`,
    `Likely cause: ${a.likelyCause}`
  ];
  if (a.evidence?.length) lines.push('Evidence:', ...a.evidence.map(e => `  - ${e}`));
  if (a.prediction) lines.push(`If untreated: ${a.prediction}`);
  if (a.recommendedActions?.length) {
    lines.push('Suggested next steps:');
    for (const r of a.recommendedActions) lines.push(`  - [${r.risk} risk] ${r.title}${r.scriptId ? ` (script: ${r.scriptId})` : ''}: ${r.detail || ''}`);
  }
  if (a.escalate) lines.push('** AI recommends escalation **');
  return lines;
}

async function tryAnalyze(serverId) {
  if (!ai.isConfigured() || ai.budgetLeft() < 5) return null;   // keep headroom for humans
  try { return await ai.analyzeWithAI(serverId, { includeLogs: true }); }
  catch (err) { console.error(`[ticketWatcher] AI analysis skipped for ${serverId}: ${err.message}`); return null; }
}

async function buildServerTicket(bad, cfg) {
  const s = cfg.get(bad.serverId) || { id: bad.serverId, name: bad.serverId };
  const minutes = Math.round((Date.now() - bad.since) / 60000);
  const result = await tryAnalyze(bad.serverId);
  const forecast = result?.forecast || ai.analyzeServer(bad.serverId);
  const body = [
    `${s.name || s.id} has been ${bad.status.toUpperCase()} for ${minutes} minutes (since ${new Date(bad.since).toISOString()}).`,
    '',
    ...aiLines(result),
    result ? '' : 'AI analysis not available — statistical findings only.',
    ...(forecastLines(forecast).length ? ['Trend findings:', ...forecastLines(forecast).map(l => `  - ${l}`)] : []),
    '',
    'Auto-created by Health Monitor AI. This is a draft analysis — verify before acting.'
  ].join('\n');
  return {
    key: `server:${bad.serverId}`,
    title: `[Auto] ${s.name || s.id} ${bad.status} for ${minutes}m`,
    body,
    serverName: s.name || s.id, provider: s.provider, group: s.group,
    urgency: bad.status === 'critical' ? 2 : 3, impact: 3,
    covers: [bad.serverId]
  };
}

async function buildIncidentTicket(inc) {
  const lead = inc.servers[0];
  const result = await tryAnalyze(lead.id);
  const minutes = Math.round((Date.now() - inc.since) / 60000);
  const body = [
    `${inc.servers.length} of ${inc.total} ${inc.provider} ${inc.group} servers (${inc.share}%) began failing within ${inc.spanMinutes} minutes of each other, ${minutes} minutes ago.`,
    '',
    `Best guess (rule of thumb, not confirmed): ${inc.hint}`,
    '',
    'Affected servers:',
    ...inc.servers.map(m => `  - ${m.name} [${m.status}] since ${new Date(m.since).toISOString()}`),
    '',
    ...(result ? [`Analysis of first-affected server (${lead.name}):`, ...aiLines(result), ''] : []),
    'Auto-created by Health Monitor AI. This is a draft analysis — verify before acting.'
  ].join('\n');
  return {
    key: inc.key,
    title: `[Auto] ${inc.servers.length} servers failing in ${inc.provider} ${inc.group}`,
    body,
    serverName: `${inc.servers.length} servers (${inc.group})`, provider: inc.provider, group: inc.group,
    urgency: inc.severity === 'major' ? 1 : 2, impact: inc.severity === 'major' ? 1 : 2,
    covers: inc.servers.map(m => m.id)
  };
}

// ── Main cycle ─────────────────────────────────────────────────────────────────
async function tick() {
  if (MODE === 'off') return;   // never act unless explicitly in dry-run (or, later, rules-enabled 'on')
  const cfg  = configById();
  const bad  = store.currentlyBad();
  const incidents = correlate({ bad, latest: store.latestStatuses(1), cfg });
  const now  = Date.now();

  // 1. Close local records whose failure has cleared.
  const activeKeys = new Set([
    ...bad.map(b => `server:${b.serverId}`),
    ...incidents.map(i => i.key)
  ]);
  for (const t of store.openAutoTickets()) {
    if (t.mode !== 'manual' && !activeKeys.has(t.key)) store.closeAutoTicket(t.id);
  }

  // 2. Work out what needs a ticket.
  const covered = new Set();
  const wanted = [];
  for (const inc of incidents) {
    if (now - inc.since < AFTER_MS) { inc.servers.forEach(m => covered.add(m.id)); continue; }  // wait, but don't ticket members individually
    inc.servers.forEach(m => covered.add(m.id));
    wanted.push({ kind: 'incident', inc });
  }
  for (const b of bad) {
    if (covered.has(b.serverId) || now - b.since < AFTER_MS) continue;
    wanted.push({ kind: 'server', bad: b });
  }

  let created = 0;
  for (const w of wanted) {
    if (created >= MAX_PER_TICK) break;
    const key = w.kind === 'incident' ? w.inc.key : `server:${w.bad.serverId}`;
    if (store.openAutoTicket(key)) continue;
    const last = store.lastAutoTicket(key);
    if (last && last.closed_ts && now - last.closed_ts < COOLDOWN_MS) continue;

    const t = w.kind === 'incident' ? await buildIncidentTicket(w.inc) : await buildServerTicket(w.bad, cfg);

    if (MODE !== 'on') {   // dry-run: record only.  Anything but 'on' must never reach ServiceNow.
      store.saveAutoTicket({ key, mode: 'dry-run', title: t.title, body: t.body });
      console.log(`[ticketWatcher] DRY-RUN would create: ${t.title}`);
      created++;
      continue;
    }
    try {
      const ticket = await snService.createTicket({
        ticketType: 'incident',
        shortDescription: t.title,
        description: t.body,
        serverName: t.serverName,
        hyperscaler: t.provider,
        subnet: t.group,
        actionType: 'auto-detected',
        urgency: t.urgency,
        impact: t.impact
      });
      if (!ticket) {
        if (!_warnedUnconfigured) { console.warn('[ticketWatcher] ServiceNow not configured — no tickets created'); _warnedUnconfigured = true; }
        return;
      }
      store.saveAutoTicket({ key, mode: 'on', number: ticket.number, sysId: ticket.sysId, url: ticket.url, title: t.title, body: t.body });
      console.log(`[ticketWatcher] created ${ticket.number}: ${t.title}`);
      created++;
    } catch (err) {
      console.error(`[ticketWatcher] ticket for ${key} failed: ${err.message}`);   // retried next cycle
    }
  }
}

function start() {
  if (!['dry-run', 'on'].includes(MODE)) return;
  if (_timer) return;
  store.init();
  console.log(`[ticketWatcher] mode=${MODE}, after ${AFTER_MS / 60000} min`);
  let running = false;
  _timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (err) { console.error(`[ticketWatcher] ${err.message}`); }
    finally { running = false; }
  }, TICK_MS);
  _timer.unref();
}

module.exports = { start, tick, currentIncidents, forecastLines, aiLines, mode: MODE };
