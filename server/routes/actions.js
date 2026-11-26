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

// ── Admin credentials: one check for every action ────────────────────────────
// Server start, stop and restart, Run Script and service restart are all protected the same way,
// on the server (never only in the browser):
//   1. signed in (requireAuth) and, if serviceControl.json lists allowedUsers, on that list;
//   2. the person gives admin credentials for THIS server, and the server confirms they are an
//      administrator (Windows: WinRM + IsInRole(Administrator); Linux: SSH + root or sudo/wheel/admin);
//   3. the action then runs AS that person, not as the collection account, so the server's own
//      permissions decide;
//   4. every attempt, allowed or refused, is written to data/service-actions.log (never the password),
//      and each action that runs is emailed to ALERT_TO unless ACTION_NOTIFY=false.
const isLinux = server => (server.os || 'windows') === 'linux';
const asUser  = (server, username, password) => ({ ...server, winrm: { ...(server.winrm || {}), username, password } });
const IS_ADMIN_PS = `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`;

function sshTarget(server, username, password) {
  return { host: server.ssh?.host || server.host, port: server.ssh?.port || 22, username, password, readyTimeout: 15000 };
}

// Run a command over SSH as the person. With sudo, their password is given to sudo on stdin.
async function sshRun(server, username, password, command, { sudo = false, stdin } = {}) {
  const conn = new NodeSSH();
  try {
    await conn.connect(sshTarget(server, username, password));
    const r = await conn.execCommand(sudo ? `sudo -S -p '' ${command}` : command,
      { stdin: sudo ? password + '\n' + (stdin || '') : stdin });
    return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.code ?? 0 };
  } finally { try { conn.dispose(); } catch {} }
}

// Is this account an administrator on this server?  Returns { ok, error }.
async function checkAdmin(server, username, password) {
  try {
    if (isLinux(server)) {
      const r = await sshRun(server, username, password, 'echo "$(id -u) $(id -Gn)"');
      const [uid, ...groups] = r.stdout.trim().split(' ');
      return uid === '0' || /\b(sudo|wheel|root|admin)\b/.test(groups.join(' '))
        ? { ok: true } : { ok: false, error: `${username} does not have sudo/admin rights on this server` };
    }
    const r = await vmcService.runScript(asUser(server, username, password), IS_ADMIN_PS);
    return String(r.stdout).trim().toLowerCase() === 'true'
      ? { ok: true } : { ok: false, error: `${username} does not have Administrator rights on this server` };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// Runs checks 1, 2 and the audit of refusals.  Returns { username, password, base } or null (already answered).
async function adminGate(req, res, server, action, extra = {}) {
  const { username, password, reason } = req.body || {};
  const base = { action, by: whoIs(req), server: server.name || server.id, adminUser: username || null,
                 reason: reason ? String(reason).slice(0, 300) : null, ...extra };
  const refuse = (status, error) => { audit({ ...base, result: 'refused', error }); res.status(status).json({ error }); return null; };
  if (!username || !password) return refuse(400, 'Admin username and password for this server are required');
  if (!userAllowed(loadPolicy(), req)) return refuse(403, `${whoIs(req)} is not allowed to run server actions from the dashboard`);
  const a = await checkAdmin(server, username, password);
  if (!a.ok) return refuse(403, `Access denied: ${a.error}`);
  return { username, password, base };
}

const findServer = req => loadServers().find(s => s.id === req.params.id);
const updateTicket = (body, outcome, detail) => body?.ticketSysId
  ? snService.updateTicket(body.ticketType || 'incident', body.ticketSysId, outcome, detail).catch(() => {}) : null;

// POST /api/v2/actions/:id/verify-access  { username, password }
// Lets the credentials dialog say "access denied" straight away.  It is a convenience only: every
// action below repeats the same check before it runs.
router.post('/:id/verify-access', async (req, res) => {
  const server = findServer(req);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (!userAllowed(loadPolicy(), req)) return res.status(403).json({ error: `${whoIs(req)} is not allowed to run server actions from the dashboard` });
  const a = await checkAdmin(server, username, password);
  if (!a.ok) return res.status(403).json({ error: `Access denied: ${a.error}` });
  res.json({ authorized: true, username });
});

// POST /api/v2/actions/:id/restart  { username, password, reason, ticketType?, ticketSysId? }
router.post('/:id/restart', async (req, res) => {
  const server = findServer(req);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const key = `${server.id}::server`;
  if (inFlight.has(key)) return res.status(409).json({ error: 'An action on this server is already in progress' });
  inFlight.add(key);
  try {
    const g = await adminGate(req, res, server, 'server restart');
    if (!g) return;
    try {
      if (isLinux(server)) {
        const r = await sshRun(server, g.username, g.password, 'shutdown -r +0', { sudo: true });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `shutdown exited with code ${r.exitCode}`);
      } else {
        await vmcService.restartServer(asUser(server, g.username, g.password));
      }
      audit({ ...g.base, result: 'restart sent' });
      notifyAction(g.base, 'Restart command sent').catch(e => console.warn('[actions] email failed:', e.message));
      await updateTicket(req.body, 'Resolved');
      res.json({ success: true, message: `Restart command sent to ${server.name || server.id}` });
    } catch (err) {
      const msg = String(err.message || err);
      audit({ ...g.base, result: 'failed', error: msg });
      await updateTicket(req.body, 'Failed', msg);
      res.status(/Access is denied|logon failure|incorrect password|not in the sudoers/i.test(msg) ? 403 : 500).json({ error: msg });
    }
  } finally { inFlight.delete(key); }
});

// POST /api/v2/actions/:id/start and /stop  { username, password, reason }
// Not available yet for any provider.  They still go through the admin check first, so whatever is
// added here later is protected the same way.
for (const action of ['start', 'stop']) {
  router.post(`/:id/${action}`, async (req, res) => {
    const server = findServer(req);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const g = await adminGate(req, res, server, `server ${action}`);
    if (!g) return;
    const error = `Server ${action} is not available yet for ${server.provider || 'this provider'}`;
    audit({ ...g.base, result: 'not available', error });
    res.status(400).json({ error });
  });
}

// POST /api/v2/actions/:id/script  { scriptId | script, username, password, reason, ticketType?, ticketSysId? }
router.post('/:id/script', async (req, res) => {
  const server = findServer(req);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { scriptId, script: scriptBody } = req.body || {};
  if (!scriptId && !scriptBody) return res.status(400).json({ error: 'Provide scriptId or script body' });
  let scriptContent = scriptBody;
  if (scriptId && !scriptBody) {
    const found = loadScripts().find(s => s.id === scriptId && (!s.os || s.os === server.os || s.os === 'any'));
    if (!found) return res.status(404).json({ error: 'Script not found or not compatible with this server OS' });
    scriptContent = found.script;
  }

  const key = `${server.id}::server`;
  if (inFlight.has(key)) return res.status(409).json({ error: 'An action on this server is already in progress' });
  inFlight.add(key);
  try {
    const g = await adminGate(req, res, server, 'run script',
      { script: scriptId ? `predefined: ${scriptId}` : String(scriptContent).slice(0, 500) });
    if (!g) return;
    try {
      const result = isLinux(server)
        ? await sshRun(server, g.username, g.password, 'bash -s', { stdin: scriptContent })
        : await vmcService.runScript(asUser(server, g.username, g.password), scriptContent);
      audit({ ...g.base, result: 'ran', exitCode: result.exitCode });
      notifyAction(g.base, `Script ran, exit code ${result.exitCode}`).catch(e => console.warn('[actions] email failed:', e.message));
      await updateTicket(req.body, result.exitCode === 0 ? 'Resolved' : 'Failed');
      res.json({ success: result.exitCode === 0, ...result });
    } catch (err) {
      const msg = String(err.message || err);
      audit({ ...g.base, result: 'failed', error: msg });
      await updateTicket(req.body, 'Failed', msg);
      res.status(500).json({ error: msg });
    }
  } finally { inFlight.delete(key); }
});

async function notifyAction({ action, by, server, adminUser, reason, script }, outcome) {
  if (/^(0|false|off|no)$/i.test(process.env.ACTION_NOTIFY || process.env.SERVICE_RESTART_NOTIFY || '')) return;
  const alerts = require('../services/alertService');
  const lines = [
    `${action[0].toUpperCase() + action.slice(1)}: ${outcome}`,
    `Server: ${server}`,
    `Requested by: ${by} (admin account used: ${adminUser})`,
    `Reason: ${reason || 'not given'}`,
    script ? `Script: ${script}` : null,
    `Time: ${new Date().toLocaleString('en-AU')}`
  ].filter(Boolean);
  const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  await alerts.sendMail({
    subject: `[Health Monitor] ${action}: ${String(server).split('.')[0]}`,
    text: lines.join('\n'),
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${lines.map(l => `<p style="margin:0 0 6px">${e(l)}</p>`).join('')}</div>`
  });
}

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
  const base = { action: 'service restart', by: whoIs(req), server: server.name || server.id, service, adminUser: username || null, reason: reason ? String(reason).slice(0, 300) : null };
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
