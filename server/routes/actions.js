'use strict';

const { Router }     = require('express');
const fs             = require('fs');
const path           = require('path');
const { NodeSSH }    = require('node-ssh');
const vmcService     = require('../services/vmcService');
const snService      = require('../services/servicenowService');
const { loadServers } = require('../services/excelConfig');
const { getEnvGroup } = require('../services/subnetGrouping');

const router = Router();
const SCRIPTS_PATH  = path.resolve(__dirname, '../config/scripts.json');
const HOST_SERVER_ID = process.env.HOST_SERVER_ID || '';

function loadScripts() {
  try { return JSON.parse(fs.readFileSync(SCRIPTS_PATH, 'utf8').replace(/^﻿/, '')); }
  catch { return []; }
}

function getSubnetLabel(server) {
  const hostname = (server.host || server.id || '').split('.')[0].toUpperCase();
  return getEnvGroup(hostname).group;
}

// POST /api/v2/actions/:id/verify-access
// Validates that the supplied credentials have admin rights on the server.
// Windows: connects via WinRM and checks IsInRole(Administrator).
// Linux: connects via SSH and checks sudo/wheel/root group membership.
router.post('/:id/verify-access', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const isLinux = (server.os || 'windows') === 'linux';

  if (isLinux) {
    const conn = new NodeSSH();
    try {
      await conn.connect({
        host: server.ssh?.host || server.host,
        port: server.ssh?.port || 22,
        username,
        password,
        readyTimeout: 15000
      });
      // Check if user is root (uid 0) or in sudo/wheel group
      const result = await conn.execCommand(
        'uid=$(id -u); groups=$(id -Gn); echo "$uid $groups"'
      );
      conn.dispose();
      const [uid, ...groupParts] = (result.stdout || '').trim().split(' ');
      const groups = groupParts.join(' ');
      const isAdmin = uid === '0' || /\b(sudo|wheel|root|admin)\b/.test(groups);
      if (!isAdmin) return res.status(403).json({ error: `Access denied — ${username} does not have sudo/admin rights on this server` });
      return res.json({ authorized: true, username });
    } catch (err) {
      try { conn.dispose(); } catch {}
      return res.status(403).json({ error: `Access denied — ${err.message}` });
    }
  } else {
    // Windows — test WinRM with provided credentials and check admin group
    const testServer = {
      ...server,
      winrm: { ...(server.winrm || {}), username, password }
    };
    try {
      const result = await vmcService.runScript(
        testServer,
        `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
      );
      const isAdmin = result.stdout?.trim().toLowerCase() === 'true';
      if (!isAdmin) return res.status(403).json({ error: `Access denied — ${username} does not have Administrator rights on this server` });
      return res.json({ authorized: true, username });
    } catch (err) {
      return res.status(403).json({ error: `Access denied — ${err.message}` });
    }
  }
});

// POST /api/v2/actions/:id/restart
router.post('/:id/restart', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { ticketType, ticketDescription, ticketSysId } = req.body;

  try {
    const result = await vmcService.restartServer(server);

    // Update ticket to Resolved if sysId provided
    if (ticketSysId) {
      await snService.updateTicket(ticketType || 'incident', ticketSysId, 'Resolved').catch(() => {});
    }

    res.json({ success: true, ...result });
  } catch (err) {
    if (ticketSysId) {
      await snService.updateTicket(ticketType || 'incident', ticketSysId, 'Failed', err.message).catch(() => {});
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v2/actions/:id/stop
router.post('/:id/stop', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (server.provider === 'VMC') {
    return res.status(400).json({ error: 'VMC VM stop requires vCenter API access — not configured' });
  }
  res.status(400).json({ error: `Stop not implemented for provider: ${server.provider}` });
});

// POST /api/v2/actions/:id/start
router.post('/:id/start', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (server.provider === 'VMC') {
    return res.status(400).json({ error: 'VMC VM start requires vCenter API access — not configured' });
  }
  res.status(400).json({ error: `Start not implemented for provider: ${server.provider}` });
});

// POST /api/v2/actions/:id/script
router.post('/:id/script', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { scriptId, script: scriptBody, ticketType, ticketSysId } = req.body;
  if (!scriptId && !scriptBody) return res.status(400).json({ error: 'Provide scriptId or script body' });

  let scriptContent = scriptBody;
  if (scriptId && !scriptBody) {
    const found = loadScripts().find(s => s.id === scriptId && (!s.os || s.os === server.os || s.os === 'any'));
    if (!found) return res.status(404).json({ error: 'Script not found or not compatible with this server OS' });
    scriptContent = found.script;
  }

  try {
    const result = await vmcService.runScript(server, scriptContent);

    if (ticketSysId) {
      await snService.updateTicket(ticketType || 'incident', ticketSysId, 'Resolved').catch(() => {});
    }

    res.json({ success: true, ...result });
  } catch (err) {
    if (ticketSysId) {
      await snService.updateTicket(ticketType || 'incident', ticketSysId, 'Failed', err.message).catch(() => {});
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Service restart ──────────────────────────────────────────────────────────
// Access control, all enforced here (not just in the browser):
//   1. signed in (requireAuth) and, if serviceControl.json lists allowedUsers, on that list;
//   2. the service is not on the protected list;
//   3. the person's own admin credentials for the server: the restart runs AS them, so the
//      server's own permissions decide (an account without admin rights is refused there too);
//   4. the request repeats the service name as confirmation (the "type the name" step).
// Every attempt, allowed or refused, goes to data/service-actions.log, and each restart is emailed
// to ALERT_TO unless SERVICE_RESTART_NOTIFY=false.
const POLICY_PATH = path.resolve(__dirname, '../config/serviceControl.json');
const AUDIT_PATH  = path.resolve(__dirname, '../data/service-actions.log');
const SERVICE_NAME_RE = /^[A-Za-z0-9_.\-$@ ]{1,256}$/;
const inFlight = new Set();

function loadPolicy() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8').replace(/^﻿/, ''));
    return { allowedUsers: (p.allowedUsers || []).map(u => String(u).toLowerCase()), protected: (p.protected || []).map(n => String(n).toLowerCase()) };
  } catch { return { allowedUsers: [], protected: [] }; }
}
const whoIs = req => req.sessionData?.accountName || 'unknown';
const userAllowed = (policy, req) => !policy.allowedUsers.length || policy.allowedUsers.includes(whoIs(req).toLowerCase());

function audit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(AUDIT_PATH, line, () => {});
}

// GET /api/v2/actions/service-policy — what the signed-in person may do (the page uses it to show buttons)
router.get('/service-policy', (req, res) => {
  const policy = loadPolicy();
  res.json({ canRestart: userAllowed(policy, req), protected: policy.protected });
});

// POST /api/v2/actions/:id/services/restart  { service, confirm, username, password, reason }
router.post('/:id/services/restart', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const { service, confirm, username, password, reason } = req.body || {};
  const base = { by: whoIs(req), server: server.name || server.id, service, adminUser: username || null, reason: reason ? String(reason).slice(0, 300) : null };
  const refuse = (status, error) => { audit({ ...base, result: 'refused', error }); return res.status(status).json({ error }); };

  if ((server.os || 'windows') === 'linux') return refuse(400, 'Service restart is available for Windows servers only');
  if (!service || !SERVICE_NAME_RE.test(service)) return refuse(400, 'Invalid service name');
  if (confirm !== service) return refuse(400, 'Confirmation does not match the service name');
  if (!username || !password) return refuse(400, 'Admin username and password for this server are required');
  const policy = loadPolicy();
  if (!userAllowed(policy, req)) return refuse(403, `${whoIs(req)} is not allowed to restart services from the dashboard`);
  if (policy.protected.includes(service.toLowerCase())) return refuse(403, `${service} is a protected service and cannot be restarted from the dashboard`);

  const key = `${server.id}::${service.toLowerCase()}`;
  if (inFlight.has(key)) return refuse(409, `A restart of ${service} on this server is already in progress`);
  inFlight.add(key);
  try {
    const r = await vmcService.restartService(server, service, { username, password });
    const ok = r.after === 'Running' && !r.timedOut;
    audit({ ...base, result: ok ? 'restarted' : 'not running after restart', before: r.before, after: r.after, dependents: r.dependents || [] });
    notifyServiceRestart({ ...base, r, ok }).catch(e => console.warn('[actions] restart email failed:', e.message));
    res.json({ success: ok, ...r });
  } catch (err) {
    const msg = String(err.message || err);
    const denied = /ACCESS_DENIED|Access is denied|logon failure|user name or password/i.test(msg);
    const notFound = /NOT_FOUND/.test(msg);
    const clean = msg.replace(/^.*?(ACCESS_DENIED|NOT_FOUND):\s*/, '');
    audit({ ...base, result: 'failed', error: clean });
    res.status(denied ? 403 : notFound ? 404 : 500).json({ error: denied ? `Access denied: ${clean}` : clean });
  } finally {
    inFlight.delete(key);
  }
});

async function notifyServiceRestart({ by, server, service, adminUser, reason, r, ok }) {
  if (/^(0|false|off|no)$/i.test(process.env.SERVICE_RESTART_NOTIFY || '')) return;
  const alerts = require('../services/alertService');
  const host = String(server).split('.')[0];
  const lines = [
    `Service ${ok ? 'restarted' : 'restart attempted, service is NOT running'}: ${r.display || service} (${service})`,
    `Server: ${server}`,
    `Requested by: ${by} (admin account used: ${adminUser})`,
    `Reason: ${reason || 'not given'}`,
    `Status before: ${r.before || 'unknown'}, after: ${r.after || 'unknown'}${r.timedOut ? ' (did not reach Running within 60 seconds)' : ''}`,
    r.dependents?.length ? `Dependent services restarted: ${r.dependents.join(', ')}` : null,
    `Time: ${new Date().toLocaleString('en-AU')}`
  ].filter(Boolean);
  const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  await alerts.sendMail({
    subject: `[Health Monitor] ${ok ? 'Service restarted' : 'Service restart FAILED'}: ${service} on ${host}`,
    text: lines.join('\n'),
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${lines.map(l => `<p style="margin:0 0 6px">${e(l)}</p>`).join('')}</div>`
  });
}

// GET /api/v2/actions/scripts — list predefined scripts
router.get('/scripts', (req, res) => {
  res.json(loadScripts());
});

// GET /api/v2/actions/host-server — tell frontend which server is the host
router.get('/host-server', (req, res) => {
  res.json({ hostServerId: HOST_SERVER_ID });
});

module.exports = router;
