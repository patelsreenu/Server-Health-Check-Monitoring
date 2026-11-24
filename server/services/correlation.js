'use strict';

/**
 * correlation.js
 * ──────────────
 * Collapses many simultaneous server failures into one incident, so an
 * operator sees "6 of 14 Prod VMC servers failed within 4 minutes" rather than
 * six unrelated alerts.  Pure function — no I/O.
 *
 * Grouping uses the same rule as the fleet UI: the Excel `group` if set,
 * otherwise the hostname-prefix environment group.
 */

const { getEnvGroup } = require('./subnetGrouping');
const { hostOf, fqdnOf, osOf } = require('./hostName');

const MIN = 60 * 1000;

function groupOf(server) {
  if (server.group) return server.group;
  const host = (server.host || server.id || '').split('.')[0].toUpperCase();
  return getEnvGroup(host).group;
}

/**
 * @param {object} p
 * @param {{serverId:string,status:string,since:number}[]} p.bad     currently failing servers
 * @param {{server_id:string,status:string}[]}              p.latest  latest status of every monitored server
 * @param {Map<string,object>}                               p.cfg     serverId → config entry
 * @param {number} [p.windowMin=10]   failures must start within this span
 * @param {number} [p.minServers=3]
 * @param {number} [p.minShare=0.25]  and be at least this share of the group
 */
function correlate({ bad, latest, cfg, windowMin = 10, minServers = 3, minShare = 0.25, recentHours = 24, now = Date.now() }) {
  // Only genuine, recent transitions count.  A server that has never been healthy (or has been
  // down for days) did not "fail together" with anything — its start time is just when monitoring began.
  bad = bad.filter(b => !b.neverHealthy && now - b.since <= recentHours * 60 * MIN);

  const totals = new Map();
  for (const r of latest) {
    const s = cfg.get(r.server_id);
    if (!s) continue;
    const key = `${s.provider || '?'}|${groupOf(s)}`;
    totals.set(key, (totals.get(key) || 0) + 1);
  }

  const byGroup = new Map();
  for (const b of bad) {
    const s = cfg.get(b.serverId);
    if (!s) continue;
    const key = `${s.provider || '?'}|${groupOf(s)}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push({ id: b.serverId, name: s.name || b.serverId, host: hostOf(s), fqdn: fqdnOf(s), os: osOf(s), status: b.status, since: b.since });
  }

  const incidents = [];
  for (const [key, list] of byGroup) {
    list.sort((a, b) => a.since - b.since);
    // Largest set of servers whose failure start times fit inside the window.
    let best = [];
    for (let i = 0; i < list.length; i++) {
      const members = list.filter(x => x.since >= list[i].since && x.since - list[i].since <= windowMin * MIN);
      if (members.length > best.length) best = members;
    }
    const total = totals.get(key) || list.length;
    if (best.length < minServers || best.length / total < minShare) continue;

    const [provider, group] = key.split('|');
    const errors = best.filter(m => m.status === 'error').length;
    const connectivity = errors / best.length >= 0.6;
    incidents.push({
      id: `${key}|${best[0].since}`,
      key: `incident:${key}`,
      provider, group,
      startedAt: new Date(best[0].since).toISOString(),
      since: best[0].since,
      spanMinutes: Math.round((best[best.length - 1].since - best[0].since) / MIN * 10) / 10,
      servers: best,
      total,
      share: Math.round(best.length / total * 100),
      severity: best.length / total >= 0.5 ? 'major' : 'minor',
      likelyScope: connectivity ? 'connectivity' : 'resource',
      // A rule of thumb, not a diagnosis — labelled "best guess" in the UI and ticket text.
      hint: connectivity
        ? 'Most servers stopped answering health checks together — suspect shared network, hypervisor/host, firewall or authentication rather than the individual servers.'
        : 'Servers are reachable but breaching thresholds together — suspect a shared workload, batch job, backup or patch window.'
    });
  }
  return incidents.sort((a, b) => b.servers.length - a.servers.length);
}

module.exports = { correlate, groupOf };
