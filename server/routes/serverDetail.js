'use strict';

const { Router }  = require('express');
const vmcService    = require('../services/vmcService');
const linuxService  = require('../services/linuxService');
const { loadServers } = require('../services/excelConfig');

const router = Router();

function sanitize(s) {
  const { winrm, ssh, _note, domain, ...safe } = s;
  if (winrm) safe.winrm = { host: winrm.host, port: winrm.port };
  return safe;
}

// GET /api/v2/server/:id/metrics
router.get('/:id/metrics', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    if (server.provider === 'VMC' || (server.provider === 'OnPrem' && server.os !== 'linux')) {
      const data = await vmcService.getServerHealth(server);
      return res.json({ ...sanitize(data), fetchedAt: new Date().toISOString() });
    }
    if (server.provider === 'OnPrem' && server.os === 'linux') {
      const data = await linuxService.getServerHealth(server);
      return res.json({ ...sanitize(data), fetchedAt: new Date().toISOString() });
    }
    if (server.provider === 'AWS' || server.provider === 'Azure' || server.provider === 'OCI') {
      const data = server.os === 'linux'
        ? await linuxService.getServerHealth(server)
        : await vmcService.getServerHealth(server);
      return res.json({ ...sanitize(data), fetchedAt: new Date().toISOString() });
    }
    res.status(400).json({ error: `Metrics not supported for provider: ${server.provider}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v2/server/:id/services
router.get('/:id/services', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // All Windows servers — return all Automatic services; critical services from Excel config get a star marker
  if (server.os !== 'linux') {
    try {
      const services = await vmcService.getAllAutomaticServices(server);
      return res.json({ services, criticalServices: server.criticalServices || [], fetchedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Linux — not supported
  res.json({ services: [], message: 'No service monitoring available for Linux servers' });
});

// GET /api/v2/server/:id/rdp — a Remote Desktop (.rdp) file for this Windows server.
// The browser downloads it and Windows opens it in Remote Desktop, which asks for the user's own
// credentials: nothing is stored or sent here.  The address comes from the server list by id, never from the request.
router.get('/:id/rdp', (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const host = server.winrm?.host || server.host;
  if (server.os === 'linux') return res.status(400).json({ error: `Linux server — connect with: ssh ${server.ssh?.host || host}`, ssh: server.ssh?.host || host });
  if (!host) return res.status(404).json({ error: 'No host name on file for this server' });

  const lines = [
    `full address:s:${host}`,
    'prompt for credentials:i:1',
    'screen mode id:i:1',
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'redirectclipboard:i:1',
    'redirectprinters:i:0',
    'audiomode:i:2',
    'authentication level:i:2',
    'enablecredsspsupport:i:1'
  ];
  const file = `${host.split('.')[0].replace(/[^A-Za-z0-9_-]/g, '_')}.rdp`;
  console.log(`[rdp] ${req.sessionData?.accountName || 'unknown'} downloaded an RDP file for ${server.id} (${host})`);
  res.set({ 'Content-Type': 'application/x-rdp', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' });
  res.send(lines.join('\r\n') + '\r\n');
});

// GET /api/v2/server/:id/logs
router.get('/:id/logs', async (req, res) => {
  const server = loadServers().find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 500);

  try {
    if (server.os === 'linux') {
      return res.json({ lines: [], source: 'none', message: 'Log retrieval not available for Linux servers' });
    }
    // Windows servers — pull System + Application event log via WinRM
    const result = await vmcService.getLogs(server, lines);
    return res.json({ ...result, summary: require('../services/logSummary').summarize(result.lines) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
