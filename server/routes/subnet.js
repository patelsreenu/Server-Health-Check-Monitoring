'use strict';

const { Router }      = require('express');
const { probeServer } = require('../services/tcpProbe');
const { getEnvGroup } = require('../services/subnetGrouping');
const healthCache     = require('../services/healthCache');

const { loadServers, loadPos, loadDatabases } = require('../services/excelConfig');

const router = Router();

function sanitize(s) {
  const { winrm, ssh, _note, domain, ...safe } = s;
  if (winrm) safe.winrm = { host: winrm.host, port: winrm.port };
  if (ssh)   safe.ssh   = { host: ssh.host,   port: ssh.port };
  return safe;
}

// If the WinRM health check collected real metrics the connection worked —
// don't let a short TCP-probe timeout override that fact.
function winrmEffectivelyUp(probe, health) {
  if (probe?.winrm === 'up') return true;
  return ['healthy', 'warning', 'critical'].includes(health?.status);
}

// GET /api/v2/subnet/vmc/:group/servers
router.get('/vmc/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const allServers = loadServers().filter(s => {
    if (s.provider !== 'VMC') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });

  if (!allServers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const poweredOff = allServers.filter(s => s.poweredOff);
  const active     = allServers.filter(s => !s.poweredOff);

  const cached = await healthCache.read(active, 8);
  const activeResults = active.map((s, i) => {
    const r = cached[i];
    const health = r?.health ?? { ...s, provider: 'VMC', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    const rdpUp   = r?.probe?.rdp === 'up';
    return { ...sanitize(health), upDown: (winrmUp || rdpUp) ? 'up' : 'down', winrm: winrmUp ? 'up' : 'down', rdp: rdpUp ? 'up' : 'down' };
  });

  const offResults = poweredOff.map(s => ({
    ...sanitize(s), status: 'powered-off', upDown: 'powered-off', winrm: 'off', rdp: 'off'
  }));

  res.json({ provider: 'vmc', group: targetGroup, servers: [...activeResults, ...offResults], fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/vmc/:group/databases
router.get('/vmc/:group/databases', async (req, res) => {
  const targetGroup = req.params.group;
  const allDbs = loadDatabases();
  const dbs = allDbs.filter(db => {
    const hostname = (db.host || '').split('.')[0].toUpperCase();
    return getEnvGroup(hostname).group === targetGroup;
  });

  if (!dbs.length) return res.json({ group: targetGroup, databases: [], fetchedAt: new Date().toISOString() });

  // Basic connectivity check for databases (ping host port)
  const { probeServer } = require('../services/tcpProbe');
  const results = await Promise.all(dbs.map(async db => {
    const portMap = { mssql: 1433, mysql: 3306, oracle: 1521 };
    const port = db.port || portMap[db.type] || 1433;
    try {
      const probe = await probeServer({ id: db.id, host: db.host, winrm: { host: db.host } });
      const tcpUp = probe.winrm === 'up'; // reuse winrm slot for main DB port check
      return { ...db, upDown: tcpUp ? 'up' : 'down', status: tcpUp ? 'healthy' : 'error' };
    } catch {
      return { ...db, upDown: 'down', status: 'error' };
    }
  }));

  const sanitized = results.map(({ ssh, password, ...safe }) => safe);
  res.json({ provider: 'vmc', group: targetGroup, databases: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/onprem/:group/servers
router.get('/onprem/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => {
    if (s.provider !== 'OnPrem') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });

  if (!servers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const cached = await healthCache.read(servers, 8);
  const sanitized = servers.map((s, i) => {
    const r = cached[i];
    const health = r?.health ?? { ...s, provider: 'OnPrem', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    const rdpUp   = r?.probe?.rdp === 'up';
    return { ...sanitize(health), upDown: (winrmUp || rdpUp) ? 'up' : 'down', winrm: winrmUp ? 'up' : 'down', rdp: rdpUp ? 'up' : 'down' };
  });

  res.json({ provider: 'onprem', group: targetGroup, servers: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/onprem/:group/databases
router.get('/onprem/:group/databases', async (req, res) => {
  res.json({ group: req.params.group, databases: [], fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/azure/:group/servers
router.get('/azure/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => {
    if (s.provider !== 'Azure') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });

  if (!servers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const cached = await healthCache.read(servers, 8);
  const sanitized = servers.map((s, i) => {
    const r = cached[i];
    const health = r?.health ?? { ...s, provider: 'Azure', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    const rdpUp   = r?.probe?.rdp === 'up';
    return { ...sanitize(health), upDown: (winrmUp || rdpUp) ? 'up' : 'down', winrm: winrmUp ? 'up' : 'down', rdp: rdpUp ? 'up' : 'down' };
  });

  res.json({ provider: 'azure', group: targetGroup, servers: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/azure/:group/databases
router.get('/azure/:group/databases', async (req, res) => {
  res.json({ group: req.params.group, databases: [], fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/pos/:group/servers
router.get('/pos/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadPos().filter(s => (s.group || 'POS') === targetGroup);

  if (!servers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const cached = await healthCache.read(servers, 8);
  const sanitized = servers.map((s, i) => {
    const r      = cached[i];
    const health = r?.health ?? { ...s, provider: 'POS', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    return {
      ...sanitize(health),
      upDown:         winrmUp ? 'up' : 'down',
      winrm:          winrmUp ? 'up' : 'down',
      processRunning: health.processRunning ?? false,
      processName:    health.processName    ?? s.process ?? 'unknown',
      processPid:     health.processPid     ?? null
    };
  });

  res.json({ provider: 'pos', group: targetGroup, servers: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/pos/:group/databases
router.get('/pos/:group/databases', async (req, res) => {
  res.json({ group: req.params.group, databases: [], fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/aws/:group/servers  — manually-configured AWS servers
router.get('/aws/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => {
    if (s.provider !== 'AWS') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });

  if (!servers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const cached = await healthCache.read(servers, 8);
  const sanitized = servers.map((s, i) => {
    const r = cached[i];
    const health = r?.health ?? { ...s, provider: 'AWS', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    const rdpUp   = r?.probe?.rdp === 'up';
    return { ...sanitize(health), upDown: (winrmUp || rdpUp) ? 'up' : 'down', winrm: winrmUp ? 'up' : 'down', rdp: rdpUp ? 'up' : 'down' };
  });

  res.json({ provider: 'aws', group: targetGroup, servers: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/aws/:group/databases
router.get('/aws/:group/databases', async (req, res) => {
  res.json({ group: req.params.group, databases: [], fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/oci/:group/servers  — manually-configured OCI servers
router.get('/oci/:group/servers', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => {
    if (s.provider !== 'OCI') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });

  if (!servers.length) return res.json({ group: targetGroup, servers: [], fetchedAt: new Date().toISOString() });

  const cached = await healthCache.read(servers, 8);
  const sanitized = servers.map((s, i) => {
    const r = cached[i];
    const health = r?.health ?? { ...s, provider: 'OCI', status: 'error', state: 'unknown' };
    const winrmUp = winrmEffectivelyUp(r?.probe, health);
    const rdpUp   = r?.probe?.rdp === 'up';
    return { ...sanitize(health), upDown: (winrmUp || rdpUp) ? 'up' : 'down', winrm: winrmUp ? 'up' : 'down', rdp: rdpUp ? 'up' : 'down' };
  });

  res.json({ provider: 'oci', group: targetGroup, servers: sanitized, fetchedAt: new Date().toISOString() });
});

// GET /api/v2/subnet/oci/:group/databases
router.get('/oci/:group/databases', async (req, res) => {
  res.json({ group: req.params.group, databases: [], fetchedAt: new Date().toISOString() });
});

// ── Hard refresh endpoints ─────────────────────────────────────────────────────
// Clears cache for the group's servers and re-fetches them synchronously.
// The subnet GET endpoint then reads the freshly-populated cache.
// Returns 200 once the refresh is complete (typically 5–20 s for a single group).

router.post('/vmc/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const allServers = loadServers().filter(s => {
    if (s.provider !== 'VMC') return false;
    if (s.group) return s.group === targetGroup;
    return getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup;
  });
  const active = allServers.filter(s => !s.poweredOff);
  await healthCache.forceRefreshServers(active, 8);
  res.json({ ok: true, refreshed: active.length });
});

router.post('/aws/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => s.provider === 'AWS' &&
    (s.group ? s.group === targetGroup : getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup));
  await healthCache.forceRefreshServers(servers, 8);
  res.json({ ok: true, refreshed: servers.length });
});

router.post('/onprem/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => s.provider === 'OnPrem' &&
    (s.group ? s.group === targetGroup : getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup));
  await healthCache.forceRefreshServers(servers, 8);
  res.json({ ok: true, refreshed: servers.length });
});

router.post('/azure/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => s.provider === 'Azure' &&
    (s.group ? s.group === targetGroup : getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup));
  await healthCache.forceRefreshServers(servers, 8);
  res.json({ ok: true, refreshed: servers.length });
});

router.post('/oci/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadServers().filter(s => s.provider === 'OCI' &&
    (s.group ? s.group === targetGroup : getEnvGroup((s.host || s.id || '').split('.')[0].toUpperCase()).group === targetGroup));
  await healthCache.forceRefreshServers(servers, 8);
  res.json({ ok: true, refreshed: servers.length });
});

router.post('/pos/:group/refresh', async (req, res) => {
  const targetGroup = req.params.group;
  const servers = loadPos().filter(s => (s.group || 'POS') === targetGroup);
  await healthCache.forceRefreshServers(servers, 8);
  res.json({ ok: true, refreshed: servers.length });
});

module.exports = router;
