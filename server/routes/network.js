'use strict';

/**
 * network.js
 * ──────────
 * Read-only views of two separate tools, shown inside the Health Monitor behind its own sign-in:
 *
 *   /api/v2/network/*   the NetOps NOC platform (network devices, sites, interfaces, alerts)
 *   /api/v2/firewall/*  the PAN-OS firewall portal (firewall health, HA state, recent traffic)
 *
 * Both tools keep running on their own and keep doing their own polling and alerting; this module
 * only reads from them.  Only GET calls are made, and fields the browser does not need are dropped
 * (in particular NetOps returns SNMP community strings and passwords, which are never passed on).
 *
 * Config (.env):
 *   NETOPS_URL           e.g. https://netops.corp.example.com:3007 (unset = Network tab hidden)
 *   PANOS_PORTAL_URL     e.g. https://fw-portal.corp.example.com:3000 (unset = Firewall tab hidden)
 *   NETWORK_INSECURE_TLS accept self-signed certificates from those tools (default: only for localhost)
 */

const express = require('express');
const axios   = require('axios');
const https   = require('https');

const NETOPS_URL = (process.env.NETOPS_URL || '').replace(/\/+$/, '');
const PANOS_URL  = (process.env.PANOS_PORTAL_URL || '').replace(/\/+$/, '');

function agentFor(base) {
  let local = false;
  try { local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(base).hostname); } catch {}
  const insecure = process.env.NETWORK_INSECURE_TLS != null
    ? /^(1|true|yes|on)$/i.test(process.env.NETWORK_INSECURE_TLS)
    : local;
  return new https.Agent({ rejectUnauthorized: !insecure, keepAlive: true });
}
const netopsAgent = agentFor(NETOPS_URL);
const panosAgent  = agentFor(PANOS_URL);

// Small cache so many people on the page do not multiply the load on the other tools.
const cache = new Map();
async function cachedGet(base, agent, path, params, ttlMs) {
  const key = base + path + JSON.stringify(params || {});
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const res = await axios.get(base + path, { params, httpsAgent: agent, timeout: 20000 });
  cache.set(key, { at: Date.now(), data: res.data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return res.data;
}
const netops = (path, params, ttl = 20000) => cachedGet(NETOPS_URL, netopsAgent, path, params, ttl);
const panos  = (path, params, ttl = 30000) => cachedGet(PANOS_URL,  panosAgent,  path, params, ttl);

function sendError(res, tool, err) {
  const msg = err.response
    ? `${tool} answered HTTP ${err.response.status}`
    : (err.code === 'ECONNREFUSED' ? `${tool} is not running (connection refused)` : `${tool} unreachable: ${err.message}`);
  res.status(502).json({ error: msg });
}

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

// Only the fields the dashboard shows. Never the snmp_* credentials.
const DEVICE_FIELDS = ['id', 'hostname', 'ip_address', 'device_type', 'vendor', 'site', 'status', 'uptime_pct',
  'cpu_pct', 'mem_pct', 'temp_c', 'last_seen', 'last_error', 'metric_source', 'tags'];
const pick = (o, fields) => Object.fromEntries(fields.filter(f => o && o[f] !== undefined).map(f => [f, o[f]]));

// ── Network (NetOps) ──────────────────────────────────────────────────────────
const network = express.Router();

// Which of the two tabs are configured, so the page can hide the others.
network.get('/enabled', (req, res) => res.json({ network: !!NETOPS_URL, firewall: !!PANOS_URL }));

network.use((req, res, next) => {
  if (!NETOPS_URL) return res.status(404).json({ error: 'Network view is turned off (NETOPS_URL is empty)' });
  next();
});

network.get('/summary', async (req, res) => {
  try {
    const [stats, sites, devices] = await Promise.all([netops('/api/stats'), netops('/api/sites'), netops('/api/devices')]);
    const byType = {};
    for (const d of devices) {
      const t = d.device_type || 'Other';
      const b = byType[t] || (byType[t] = { type: t, total: 0, up: 0, down: 0, warn: 0 });
      b.total++;
      if (d.status === 'up') b.up++; else if (d.status === 'down') b.down++; else if (d.status === 'warn') b.warn++;
    }
    const sitesDown = sites.filter(s => s.down > 0)
      .sort((a, b) => b.down - a.down || a.site.localeCompare(b.site))
      .map(s => ({ site: s.site, total: s.total, up: s.up, down: s.down, warn: s.warn, alerts: s.alerts }));
    res.json({ source: 'NetOps', stats, types: Object.values(byType).sort((a, b) => b.total - a.total), sitesDown });
  } catch (err) { sendError(res, 'NetOps', err); }
});

network.get('/devices', async (req, res) => {
  try {
    const params = {};
    for (const k of ['type', 'status', 'site', 'q']) if (req.query[k]) params[k] = str(req.query[k]);
    const rows = await netops('/api/devices', params);
    res.json(rows.map(d => pick(d, DEVICE_FIELDS)));
  } catch (err) { sendError(res, 'NetOps', err); }
});

network.get('/devices/:id', async (req, res) => {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad device id' });
  try {
    const d = await netops('/api/devices/' + encodeURIComponent(req.params.id), null, 15000);
    res.json({
      ...pick(d, DEVICE_FIELDS),
      interfaces: (d.interfaces || []).map(i => pick(i, ['if_index', 'if_name', 'speed_mbps', 'oper_status', 'in_mbps', 'out_mbps', 'util_pct', 'errors_ps', 'updated_at'])),
      alerts: (d.alerts || []).map(a => pick(a, ['id', 'severity', 'alert_type', 'message', 'status', 'triggered_at']))
    });
  } catch (err) { sendError(res, 'NetOps', err); }
});

network.get('/alerts', async (req, res) => {
  try {
    const rows = await netops('/api/alerts');
    res.json(rows.map(a => pick(a, ['id', 'device_id', 'severity', 'alert_type', 'message', 'status', 'triggered_at', 'ack_by', 'hostname', 'ip_address', 'site', 'device_type'])));
  } catch (err) { sendError(res, 'NetOps', err); }
});

network.get('/interfaces', async (req, res) => {
  try {
    const rows = await netops('/api/interfaces', null, 30000);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(rows.slice(0, limit).map(i => pick(i, ['device_id', 'hostname', 'site', 'device_type', 'if_name', 'speed_mbps', 'oper_status', 'in_mbps', 'out_mbps', 'util_pct', 'errors_ps', 'updated_at'])));
  } catch (err) { sendError(res, 'NetOps', err); }
});

// ── Firewall (PAN-OS portal) ──────────────────────────────────────────────────
const firewall = express.Router();

firewall.use((req, res, next) => {
  if (!PANOS_URL) return res.status(404).json({ error: 'Firewall view is turned off (PANOS_PORTAL_URL is empty)' });
  next();
});

firewall.get('/health', async (req, res) => {
  try {
    const h = await panos('/api/health', null, 30000);
    res.json({ source: 'PAN-OS portal', status: h.status, device: h.device || null });
  } catch (err) {
    if (err.response && err.response.data && err.response.data.status === 'unreachable')
      return res.json({ source: 'PAN-OS portal', status: 'unreachable', error: str(err.response.data.error, 300) });
    sendError(res, 'PAN-OS portal', err);
  }
});

// The most recent sessions (up to 500), summarised: action mix and the top denied rules, sources,
// destinations and applications.  A busy firewall logs 500 sessions in seconds, so this is a sample
// of "right now", not a daily total.
firewall.get('/traffic', async (req, res) => {
  try {
    const [all, denied] = await Promise.all([
      panos('/api/traffic', { nlogs: 500, hours: 1 }, 60000),
      panos('/api/traffic', { nlogs: 500, hours: 1, action: 'deny' }, 60000)
    ]);
    const logs = all.logs || [];
    const actions = {};
    for (const l of logs) actions[l.action || 'unknown'] = (actions[l.action || 'unknown'] || 0) + 1;
    const top = (rows, f, n = 8) => {
      const c = {};
      for (const r of rows) { const k = r[f] == null || r[f] === '' ? '(none)' : String(r[f]); c[k] = (c[k] || 0) + 1; }
      return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
    };
    const blocked = logs.filter(l => l.action && l.action !== 'allow');
    const times = logs.map(l => l.time).filter(Boolean).sort();
    res.json({
      sample: logs.length,
      from: times[0] || null,
      to: times[times.length - 1] || null,
      actions,
      topApps: top(logs, 'app'),
      topBlockedRules: top(blocked, 'rule'),
      topDeniedSources: top(denied.logs || [], 'src'),
      topDeniedDestinations: top(denied.logs || [], 'dst'),
      topDeniedPorts: top(denied.logs || [], 'dport'),
      recentBlocked: blocked.slice(0, 25).map(l => pick(l, ['time', 'src', 'dst', 'dport', 'proto', 'app', 'rule', 'action', 'srcZone', 'dstZone']))
    });
  } catch (err) { sendError(res, 'PAN-OS portal', err); }
});

// Firewall devices as NetOps sees them (reachability), so the tab shows every firewall, not only the
// one the portal is connected to.
firewall.get('/devices', async (req, res) => {
  if (!NETOPS_URL) return res.json([]);
  try {
    const rows = await netops('/api/devices', { type: 'Palo Alto Firewall' });
    res.json(rows.map(d => pick(d, DEVICE_FIELDS)));
  } catch (err) { sendError(res, 'NetOps', err); }
});

module.exports = { network, firewall };
