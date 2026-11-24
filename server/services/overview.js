'use strict';

/**
 * overview.js
 * ───────────
 * The numbers behind the fleet page's summary: how many servers are in each state, which ones
 * failed recently, which have been down for a while, and which the monitor has never been able
 * to read at all (grouped by the likely reason, taken from the error text).  Read-only; derived
 * from the history store.
 */

const store = require('./historyStore');
const { loadServers, loadPos } = require('./excelConfig');
const exclusions = require('./exclusions');
const { hostOf, fqdnOf, osOf } = require('./hostName');

const DAY = 24 * 3600 * 1000;

// Best-guess cause from the error text the probe returned.  Order matters: first match wins.
const CAUSES = [
  { id: 'credentials', re: /authentication methods failed|access is denied|logon failure|unauthori[sz]ed|permission denied/i,
    label: 'Login rejected', fix: 'The monitor\'s service account is refused on these servers. Check the account, its password and its admin rights.' },
  { id: 'powershell-old', re: /ConvertTo-Json.*not recognized|is not recognized as the name of a cmdlet/i,
    label: 'PowerShell too old on the server', fix: 'These servers lack a PowerShell command the health check needs (likely PowerShell 2.0). Upgrade Windows Management Framework or add a fallback script.' },
  { id: 'winrm', re: /Connecting to remote server .* failed|WinRM|WSMan|cannot connect to the destination/i,
    label: 'Remote management (WinRM) unreachable', fix: 'WinRM is not answering from this monitor. Check the WinRM listener, firewall rule for 5985/5986 and the server being on.' },
  { id: 'network', re: /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timed? ?out|unreachable/i,
    label: 'Network timeout or refused', fix: 'The server did not answer. Check it is powered on, the DNS name resolves and no firewall blocks the monitor.' },
  { id: 'command', re: /Command failed/i,
    label: 'Health command failed to run', fix: 'The health script started but failed on the server. Run it by hand on one of them to see the full error.' }
];

function classify(error) {
  const text = String(error || '');
  return CAUSES.find(c => c.re.test(text)) || { id: 'other', label: 'Unknown reason', fix: 'No useful error text was recorded. Open one of these servers to see its details.' };
}

/**
 * Plain-English "what is wrong" for a failing server.  Limits are the ones the dashboard itself uses
 * (CPU > 90 %, memory > 95 %, disk >= 95 % → critical).  A server can be critical because of a stopped
 * critical service, which the history does not record, so that case says so instead of guessing.
 */
function whatIsWrong(b) {
  if (b.status === 'healthy') return { kind: 'ok', text: '' };
  if (b.status === 'warning') {
    const parts = [];
    if (b.cpu > 85)   parts.push(`CPU at ${b.cpu}% (warning above 85%)`);
    if (b.mem > 90)   parts.push(`Memory at ${b.mem}% (warning above 90%)`);
    if (b.disk >= 90) parts.push(`Disk ${b.diskDrive ? b.diskDrive + ' ' : ''}${b.disk}% full (warning at 90%)`);
    return { kind: 'limit', text: parts.length ? parts.join(' · ') : 'Marked warning — a reading was high on recent checks, or a monitored service needs a look.' };
  }
  if (b.status === 'critical') {
    const parts = [];
    if (b.cpu > 90)   parts.push(`CPU at ${b.cpu}% (critical above 90%)`);
    if (b.mem > 95)   parts.push(`Memory at ${b.mem}% (critical above 95%)`);
    if (b.disk >= 95) parts.push(`Disk ${b.diskDrive || ''} ${b.diskDrive ? '' : 'at '}${b.disk}% full (critical at 95%)`.replace(/\s+/g, ' '));
    return { kind: 'limit', text: parts.length ? parts.join(' · ') : 'Marked critical — most likely a monitored service is stopped. Open the server to see which.' };
  }
  const c = classify(b.error);
  const text = c.id === 'command'
    ? 'The health check could not run on this server (usually a brief PowerShell or remote-management timeout).'
    : c.id === 'other' ? 'The health check failed with no detail recorded.' : `${c.label}.`;
  return { kind: 'check', text };
}

function countStatuses(latest) {
  const counts = { monitored: latest.length, healthy: 0, warning: 0, critical: 0, unreachable: 0 };
  for (const r of latest) {
    if (r.status === 'error') counts.unreachable++;
    else if (counts[r.status] !== undefined) counts[r.status]++;
  }
  return counts;
}

function build(now = Date.now()) {
  const cfg = new Map([...loadServers(), ...loadPos()].map(s => [s.id, s]));
  const latest = store.latestStatuses(1);
  const bad = store.currentlyBad();
  const nameOf = id => cfg.get(id)?.name || id;
  const card = b => {
    const s = cfg.get(b.serverId) || {};
    const w = whatIsWrong(b);
    return { serverId: b.serverId, name: nameOf(b.serverId), host: hostOf(s), fqdn: fqdnOf(s), os: osOf(s), provider: s.provider || null, group: s.group || null,
             status: b.status, since: new Date(b.since).toISOString(),
             lastHealthy: b.lastGood ? new Date(b.lastGood).toISOString() : null,
             kind: w.kind, problem: w.text, error: b.error.slice(0, 160) };
  };

  const counts = countStatuses(latest);

  const recent = [], longDown = [], neverRead = [];
  for (const b of bad) {
    if (b.neverRead) { neverRead.push(b); continue; }
    if (b.neverHealthy) continue;   // critical on every reading, no healthy baseline: counted in "critical", not a new failure
    (now - b.since <= DAY ? recent : longDown).push(b);
  }
  recent.sort((a, b) => b.since - a.since);
  longDown.sort((a, b) => a.since - b.since);

  const groups = new Map();
  for (const b of neverRead) {
    const c = classify(b.error);
    if (!groups.has(c.id)) groups.set(c.id, { cause: c.label, fix: c.fix, servers: [] });
    groups.get(c.id).servers.push(card(b));
  }

  return {
    generatedAt: new Date(now).toISOString(),
    counts,
    excluded: exclusions.list().map(e => ({ serverId: e.id, name: nameOf(e.id), reason: e.reason })),
    recentFailures: recent.map(card),
    downOverADay: longDown.map(card),
    neverReachable: {
      total: neverRead.length,
      groups: [...groups.values()].sort((a, b) => b.servers.length - a.servers.length)
    }
  };
}

const CATEGORY = { healthy: s => s === 'healthy', warning: s => s === 'warning', critical: s => s === 'critical', unreachable: s => s === 'error', monitored: () => true };

/**
 * Every server in one dashboard category (the tiles at the top of the fleet page), with its latest
 * readings and, where something is wrong, why and for how long.
 */
function listServers(category = 'monitored', now = Date.now()) {
  const match = CATEGORY[category];
  if (!match) throw new Error(`Unknown category "${category}"`);
  const cfg = new Map([...loadServers(), ...loadPos()].map(s => [s.id, s]));
  const bad = new Map(store.currentlyBad().map(b => [b.serverId, b]));
  const rows = [];
  const latest = store.latestStatuses(1);
  for (const r of latest) {
    if (!match(r.status)) continue;
    const s = cfg.get(r.server_id) || {};
    const b = bad.get(r.server_id);
    const w = whatIsWrong({ status: r.status, cpu: r.cpu, mem: r.mem_pct, disk: r.max_disk_pct, diskDrive: null, error: r.error || '' });
    const since = store.statusSince(r.server_id, r.status);
    rows.push({
      serverId: r.server_id, name: s.name || r.server_id, host: hostOf(s), fqdn: fqdnOf(s), os: osOf(s), provider: s.provider || null, group: s.group || null,
      status: r.status, problem: w.text,
      cpu: r.cpu, mem: r.mem_pct, disk: r.max_disk_pct,
      since: since ? new Date(since).toISOString() : null,
      lastChecked: new Date(r.ts).toISOString(),
      neverRead: b ? b.neverRead : false,
      lastHealthy: b?.lastGood ? new Date(b.lastGood).toISOString() : null
    });
  }
  const order = { critical: 0, error: 1, warning: 2, healthy: 3 };
  rows.sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || x.name.localeCompare(y.name));
  // counts come from the same rows as the list, so the dashboard tiles can be updated to match it exactly
  return { category, generatedAt: new Date(now).toISOString(), total: rows.length, counts: countStatuses(latest), servers: rows };
}

module.exports = { build, classify, listServers };
