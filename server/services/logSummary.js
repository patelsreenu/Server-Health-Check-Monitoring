'use strict';

/**
 * logSummary.js
 * ─────────────
 * Turns a page of Windows event-log lines into a short, readable summary so nobody has to scroll
 * through repeats.  Pure function — no I/O, no AI key needed.
 *
 *   1. parse "[Level] [Source] message" lines
 *   2. group repeats (numbers, process ids and GUIDs ignored when comparing)
 *   3. explain well-known events in plain English and say whether they need action
 *   4. lead with a one-line headline
 *
 * Unknown errors are still listed (and marked as needing a look); the optional AI explanation
 * in aiService.explainLogs works on exactly these groups.
 */

const LEVEL_RANK = { critical: 0, error: 1, warning: 2, information: 3 };

// First match wins.  verdict: 'attention' = someone should look, 'info' = good to know, 'noise' = normally ignorable.
const RULES = [
  { re: /vmStatsProvider|vmGuestLib|VMware Guest API/i, title: 'VMware Tools not running', verdict: 'attention',
    meaning: 'The VMware guest tools inside this server are stopped or not responding, so VMware cannot read its statistics or do clean shutdowns and snapshots.',
    action: 'Check the "VMware Tools" service in services.msc and start it; if it keeps failing, reinstall VMware Tools.' },
  { re: /terminated unexpectedly|service .* (crashed|failed to start)/i, title: 'A service crashed or failed to start', verdict: 'attention',
    meaning: 'A Windows service stopped on its own or could not start.',
    action: 'Find which service in the message, check it is running, and look at the lines just before the failure for the cause.' },
  { re: /Kernel-Power|previous system shutdown|unexpected(ly)? (shut ?down|restart|reboot)/i, title: 'Unexpected restart', verdict: 'attention',
    meaning: 'The server shut down or restarted without a clean shutdown (power loss, crash, or a forced reset).',
    action: 'Ask whether the restart was planned; if not, check the host and look for a blue-screen or memory dump.' },
  { re: /\b(ntfs|disk|volmgr|storahci|stornvme|iaStor|partmgr)\b|reset to device|bad block|I\/O error/i, title: 'Disk or storage errors', verdict: 'attention',
    meaning: 'Windows reported problems talking to a disk or volume.',
    action: 'Check the disk and the storage path (datastore / EBS volume) and run a disk check in a maintenance window.' },
  { re: /Resource-Exhaustion|out of (virtual )?memory|low on (virtual )?memory/i, title: 'Server ran out of memory', verdict: 'attention',
    meaning: 'Windows warned that memory was exhausted.',
    action: 'Find the process using the most memory and add memory or fix the leak.' },
  { re: /Schannel|certificate|TLS|SSL/i, title: 'Certificate or encryption (TLS) problem', verdict: 'attention',
    meaning: 'A secure connection failed, often an expired or untrusted certificate or mismatched TLS settings.',
    action: 'Check which certificate or client is named in the message and whether it has expired.' },
  { re: /NETLOGON|trust relationship|secure channel|Kerberos|\bKDC\b|The security database/i, title: 'Domain sign-in problem', verdict: 'attention',
    meaning: 'This server is having trouble authenticating with the domain.',
    action: 'Test the secure channel (Test-ComputerSecureChannel) and check time sync and DNS to the domain controllers.' },
  { re: /MSSQL|SQLSERVERAGENT|SQL Server/i, title: 'SQL Server reported an error', verdict: 'attention',
    meaning: 'SQL Server logged a problem.', action: 'Read the full message in the SQL Server error log; it usually names the database or job.' },
  { re: /Application Error|Application Hang|\.NET Runtime|faulting (application|module)/i, title: 'An application crashed or hung', verdict: 'attention',
    meaning: 'A program stopped responding or crashed.', action: 'Note the program named in the message; check for updates or a recent change.' },
  { re: /DNS-Client.*wpad|\bwpad\b/i, title: 'Proxy auto-discovery ("wpad") lookup failed', verdict: 'noise',
    meaning: 'Windows looked for an automatic web-proxy setting and nothing answered. Normal on servers that use no auto-proxy.',
    action: 'Ignore unless this server is meant to reach the internet through a proxy and web access is failing.' },
  { re: /Service Control Manager.*service process other than the one launched/i, title: 'Service started twice (often the CloudWatch Agent)', verdict: 'info',
    meaning: 'Windows started a service but a different copy connected. Typical when the AWS CloudWatch Agent is also started by hand or by a script.',
    action: 'Low impact. Make sure the agent is not being started two ways.' },
  { re: /DCOM|DistributedCOM/i, title: 'DCOM permission warning', verdict: 'noise',
    meaning: 'A component asked for permissions it was not granted. Very common and usually harmless.', action: 'Ignore unless an application is also failing.' },
  { re: /W32Time|Time-Service|time provider/i, title: 'Time synchronisation issue', verdict: 'info',
    meaning: 'The clock could not sync with its time source; large drift breaks domain sign-in.', action: 'Check the time source (w32tm /query /status).' },
  { re: /WindowsUpdateClient|Windows Update/i, title: 'Windows Update problem', verdict: 'info',
    meaning: 'An update failed to download or install.', action: 'Check the update history and retry in a maintenance window.' },
  { re: /GroupPolicy|Group Policy/i, title: 'Group Policy processing problem', verdict: 'info',
    meaning: 'Group Policy could not be fully applied.', action: 'Run gpresult /r and check DNS and domain connectivity.' }
];

const LINE = /^\[(?<level>[^\]]+)\]\s+\[(?<source>[^\]]*)\]\s*(?<msg>.*)$/s;

function parse(entry) {
  const text = String(entry.message ?? '');
  const m = LINE.exec(text);
  const level = (m?.groups.level || 'Information').toLowerCase();
  return {
    ts: entry.timestamp ? Date.parse(entry.timestamp) : NaN,
    level: LEVEL_RANK[level] !== undefined ? level : 'information',
    source: m?.groups.source || '',
    msg: (m?.groups.msg ?? text).trim()
  };
}

const normalise = s => s
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
  .replace(/\b0x[0-9a-f]+\b/gi, '#').replace(/\b\d+(?:\.\d+)*\b/g, '#')
  .replace(/\s+/g, ' ').trim().slice(0, 150);

function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days`;
}

/**
 * @param {{timestamp?:string, message:string}[]} lines  newest-first, as getLogs returns them
 */
function summarize(lines, { maxGroups = 8 } = {}) {
  const entries = (lines || []).map(parse);
  if (!entries.length) return { total: 0, headline: 'No error or warning events were found in this window.', needsAttention: false, groups: [], counts: { critical: 0, error: 0, warning: 0 } };

  const groups = new Map();
  for (const e of entries) {
    // Events matching the same known issue are one finding even if their wording differs slightly.
    const rule = RULES.find(r => r.re.test(`${e.source} ${e.msg}`));
    const key = rule ? `rule:${rule.title}` : `${e.source}|${normalise(e.msg)}`;
    let g = groups.get(key);
    if (!g) { g = { rule, source: e.source, level: e.level, count: 0, first: e.ts, last: e.ts, sample: e.msg.slice(0, 240) }; groups.set(key, g); }
    g.count++;
    if (LEVEL_RANK[e.level] < LEVEL_RANK[g.level]) g.level = e.level;
    if (e.ts < g.first) g.first = e.ts;
    if (e.ts > g.last) g.last = e.ts;
  }

  const out = [...groups.values()].map(g => {
    const rule = g.rule;
    const bad = g.level === 'critical' || g.level === 'error';
    return {
      title: rule?.title || (g.source ? `${g.source}: ${g.sample.slice(0, 70)}${g.sample.length > 70 ? '…' : ''}` : g.sample.slice(0, 80)),
      known: !!rule,
      verdict: rule ? rule.verdict : (bad ? 'attention' : 'info'),
      level: g.level, source: g.source, count: g.count,
      first: Number.isFinite(g.first) ? new Date(g.first).toISOString() : null,
      last: Number.isFinite(g.last) ? new Date(g.last).toISOString() : null,
      meaning: rule?.meaning || (bad ? 'Not a recognised event. Read the sample message; repeated errors from the same source usually point to one underlying fault.' : 'Not a recognised event; a warning with no known impact.'),
      action: rule?.action || (bad ? 'Search the message text, and check what changed on the server around the first occurrence.' : null),
      sample: g.sample
    };
  });

  const ORDER = { attention: 0, info: 1, noise: 2 };
  out.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.count - a.count);

  const counts = { critical: 0, error: 0, warning: 0 };
  for (const e of entries) if (counts[e.level] !== undefined) counts[e.level]++;
  const times = entries.map(e => e.ts).filter(Number.isFinite);
  const span = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const attention = out.filter(g => g.verdict === 'attention');

  const parts = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.error) parts.push(`${counts.error} error${counts.error > 1 ? 's' : ''}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning > 1 ? 's' : ''}`);
  const headline = `${entries.length} events${span ? ` over ${dur(span)}` : ''} — ${parts.join(', ') || 'no errors or warnings'}, in ${out.length} distinct kind${out.length > 1 ? 's' : ''}. ` +
    (attention.length
      ? `Needs a look: ${attention.slice(0, 3).map(g => `${g.title} (×${g.count})`).join('; ')}.`
      : 'Nothing here normally needs action.');

  return {
    total: entries.length, counts, headline, needsAttention: attention.length > 0,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null,
    to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    distinct: out.length, groups: out.slice(0, maxGroups), hiddenGroups: Math.max(0, out.length - maxGroups)
  };
}

module.exports = { summarize, parse, normalise };
