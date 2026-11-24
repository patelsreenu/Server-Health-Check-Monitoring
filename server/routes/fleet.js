'use strict';

const { Router }         = require('express');
const fs                 = require('fs');
const path               = require('path');
const { probeAll, probeServer } = require('../services/tcpProbe');
const { groupServersByEnv } = require('../services/subnetGrouping');
const vmcService         = require('../services/vmcService');
const awsService         = require('../services/awsService');
const ociService         = require('../services/ociService');
const azureService       = require('../services/azureService');
const healthCache        = require('../services/healthCache');

const { loadServers, loadPos } = require('../services/excelConfig');

const router = Router();
const CLOUDS_PATH = path.resolve(__dirname, '../config/clouds.json');

function loadClouds() { return JSON.parse(fs.readFileSync(CLOUDS_PATH, 'utf8').replace(/^﻿/, '')); }

function groupPosServers(servers) {
  const groups = new Map();
  for (const s of servers) {
    const key = s.group || 'POS';
    if (!groups.has(key)) groups.set(key, { group: key, env: 'POS', servers: [] });
    groups.get(key).servers.push(s);
  }
  return Array.from(groups.values());
}

function toCountRow(cached) {
  const status   = cached?.health?.status ?? 'error';
  // If the WinRM health check collected real metrics the connection worked —
  // don't let a TCP-probe timeout override that fact.
  const healthOk = ['healthy', 'warning', 'critical'].includes(status);
  return {
    status,
    winrmUp: cached?.probe?.winrm === 'up' || healthOk,
    rdpUp:   cached?.probe?.rdp   === 'up'
  };
}

function sanitize(s) {
  const { winrm, ssh, _note, domain, ...safe } = s;
  if (winrm) safe.winrm = { host: winrm.host, port: winrm.port };
  return safe;
}

// ── OS-split helpers ──────────────────────────────────────────────────────────
function isLinux(s) { return (s.os || 'windows') === 'linux'; }

function buildWindowsCounts(servers) {
  return {
    total:      servers.length,
    up:         servers.filter(s => s.upDown === 'up').length,
    poweredOff: servers.filter(s => s.upDown === 'powered-off').length,
    stopped:    servers.filter(s => s.upDown === 'stopped').length,
    down:       servers.filter(s => s.upDown === 'down').length,
    winrmDown:  servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
    bothDown:   servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
    rdpDown:    servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length,
  };
}

function buildLinuxCounts(servers) {
  return {
    total:   servers.length,
    up:      servers.filter(s => s.upDown === 'up').length,
    down:    servers.filter(s => s.upDown === 'down').length,
    sshDown: servers.filter(s => s.upDown === 'down').length,
  };
}

function splitGroups(enriched) {
  const win   = enriched.filter(s => !isLinux(s));
  const linux = enriched.filter(s =>  isLinux(s));
  return {
    windowsGroups: groupServersByEnv(win).map(g => ({
      ...g, os: 'windows', counts: buildWindowsCounts(g.servers)
    })),
    linuxGroups: groupServersByEnv(linux).map(g => ({
      ...g, os: 'linux', counts: buildLinuxCounts(g.servers)
    })),
  };
}

function splitHealthGroups(withStatus) {
  const win   = withStatus.filter(s => !isLinux(s));
  const linux = withStatus.filter(s =>  isLinux(s));

  const windowsHealthCounts = groupServersByEnv(win).map(g => ({
    group:      g.group,
    healthy:    g.servers.filter(s => s.status === 'healthy').length,
    warning:    g.servers.filter(s => s.status === 'warning').length,
    critical:   g.servers.filter(s => s.status === 'critical').length,
    error:      g.servers.filter(s => s.status === 'error').length,
    poweredOff: g.servers.filter(s => s.status === 'powered-off').length,
    stopped:    g.servers.filter(s => s.status === 'stopped').length,
    winrmDown:  g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:   g.servers.filter(s => !s.winrmUp && !s.rdpUp && !['powered-off','stopped'].includes(s.status)).length,
    rdpDown:    g.servers.filter(s =>  s.winrmUp && !s.rdpUp).length,
  }));

  const linuxHealthCounts = groupServersByEnv(linux).map(g => ({
    group:    g.group,
    healthy:  g.servers.filter(s => s.status === 'healthy').length,
    warning:  g.servers.filter(s => s.status === 'warning').length,
    critical: g.servers.filter(s => s.status === 'critical').length,
    error:    g.servers.filter(s => s.status === 'error').length,
    sshDown:  g.servers.filter(s => !s.winrmUp).length,
  }));

  return { windowsHealthCounts, linuxHealthCounts };
}

// Returns Map of UPPERCASED-vm-name → azure power state ('running'|'stopped'|'deallocated'|'unknown')
// Returns empty Map if credentials not configured or API call fails.
async function getAzureStateMap() {
  try {
    const clouds = loadClouds();
    const credential = azureService.getCredential(clouds);
    if (!credential) return new Map();
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID || clouds.azure.subscriptionId;
    if (!subscriptionId) return new Map();
    const vms = await azureService.getFleetStatus(credential, subscriptionId);
    return new Map(vms.map(v => [v.name.toUpperCase(), v.state]));
  } catch {
    return new Map();
  }
}

function azureVmName(server) {
  return (server.host || '').split('.')[0].toUpperCase();
}


// ── VMC Fleet — TCP probes only (fast) ───────────────────────────────────────
router.get('/vmc', async (req, res) => {
  const allServers = loadServers().filter(s => s.provider === 'VMC');
  const poweredOff = allServers.filter(s => s.poweredOff);
  const active     = allServers.filter(s => !s.poweredOff);

  const probeResults = await probeAll(active);
  const probeMap = new Map(probeResults.map(p => [p.id, p]));

  const enriched = [
    ...active.map(s => {
      const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
      return { ...sanitize(s), winrm: probe.winrm, rdp: probe.rdp, upDown: probe.winrm === 'up' ? 'up' : 'down' };
    }),
    ...poweredOff.map(s => ({ ...sanitize(s), winrm: 'off', rdp: 'off', upDown: 'powered-off' }))
  ];

  const grouped = groupServersByEnv(enriched);
  const groupsWithCounts = grouped.map(g => ({
    ...g,
    counts: {
      total:      g.servers.length,
      up:         g.servers.filter(s => s.upDown === 'up').length,
      poweredOff: g.servers.filter(s => s.upDown === 'powered-off').length,
      down:       g.servers.filter(s => s.upDown === 'down').length,
      winrmDown:  g.servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
      bothDown:   g.servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
      rdpDown:    g.servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length
    }
  }));

  const { windowsGroups, linuxGroups } = splitGroups(enriched);
  res.json({ provider: 'vmc', groups: groupsWithCounts, windowsGroups, linuxGroups, timestamp: new Date().toISOString() });
});

// ── VMC Health — uses shared cache so fleet overview and subnet detail always agree ──
router.get('/vmc/health', async (req, res) => {
  const allServers = loadServers().filter(s => s.provider === 'VMC');
  const poweredOff = allServers.filter(s => s.poweredOff);
  const active     = allServers.filter(s => !s.poweredOff);

  const cached = await healthCache.ensure(active, 10);
  healthCache.startBackgroundRefresh('vmc', active);
  const rows   = cached.map(toCountRow);

  const activeStatuses = active.map((s, i) => ({ ...s, ...rows[i] }));
  const offStatuses    = poweredOff.map(s => ({ ...s, status: 'powered-off', winrmUp: false, rdpUp: false }));
  const withStatus     = [...activeStatuses, ...offStatuses];

  const grouped = groupServersByEnv(withStatus);
  const healthCounts = grouped.map(g => ({
    group:      g.group,
    healthy:    g.servers.filter(s => s.status === 'healthy').length,
    warning:    g.servers.filter(s => s.status === 'warning').length,
    critical:   g.servers.filter(s => s.status === 'critical').length,
    error:      g.servers.filter(s => s.status === 'error').length,
    poweredOff: g.servers.filter(s => s.status === 'powered-off').length,
    winrmDown:  g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:   g.servers.filter(s => !s.winrmUp && !s.rdpUp && s.status !== 'powered-off').length,
    rdpDown:    g.servers.filter(s =>  s.winrmUp && !s.rdpUp).length
  }));

  const { windowsHealthCounts, linuxHealthCounts } = splitHealthGroups(withStatus);
  res.json({ provider: 'vmc', healthCounts, windowsHealthCounts, linuxHealthCounts, timestamp: new Date().toISOString() });
});

// Manual hard refresh — triggers an immediate background cycle (non-blocking).
// The fleet health GET will return fresh data once the cycle completes (~60–120 s for VMC).
router.post('/vmc/refresh',    (req, res) => { healthCache.triggerRefresh('vmc');    res.status(202).json({ ok: true }); });
router.post('/aws/refresh',    (req, res) => { healthCache.triggerRefresh('aws');    res.status(202).json({ ok: true }); });
router.post('/azure/refresh',  (req, res) => { healthCache.triggerRefresh('azure');  res.status(202).json({ ok: true }); });
router.post('/onprem/refresh', (req, res) => { healthCache.triggerRefresh('onprem'); res.status(202).json({ ok: true }); });
router.post('/oci/refresh',    (req, res) => { healthCache.triggerRefresh('oci');    res.status(202).json({ ok: true }); });
router.post('/pos/refresh',    (req, res) => { healthCache.triggerRefresh('pos');    res.status(202).json({ ok: true }); });

// ── AWS Fleet ─────────────────────────────────────────────────────────────────
// Shows two kinds of servers:
//   1. Manually-configured servers (provider: AWS in Excel) — WinRM/TCP probes
//   2. EC2 instances discovered via AWS API (if credentials are configured)
router.get('/aws', async (req, res) => {
  // ── Manually-configured AWS servers from Excel ────────────────────────────
  const configServers = loadServers().filter(s => s.provider === 'AWS');
  let configGroups = [];
  if (configServers.length > 0) {
    const probeResults = await probeAll(configServers);
    const probeMap     = new Map(probeResults.map(p => [p.id, p]));
    const enriched     = configServers.map(s => {
      const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
      return { ...sanitize(s), winrm: probe.winrm, rdp: probe.rdp, upDown: probe.winrm === 'up' ? 'up' : 'down' };
    });
    configGroups = groupServersByEnv(enriched).map(g => ({
      ...g,
      counts: {
        total:     g.servers.length,
        up:        g.servers.filter(s => s.upDown === 'up').length,
        down:      g.servers.filter(s => s.upDown === 'down').length,
        winrmDown: g.servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
        bothDown:  g.servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
        rdpDown:   g.servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length
      }
    }));
  }

  // ── AWS API-discovered EC2 instances (optional — silently skipped on error) ─
  let apiGroups = [];
  try {
    const { credentials, region } = req.sessionData || {};
    if (credentials && region) {
      // Fix AWS SDK v3 bug: expiration must be a Date object, not a string
      if (credentials.expiration && !(credentials.expiration instanceof Date))
        credentials.expiration = new Date(credentials.expiration);
      const instances = await awsService.getFleetStatus(credentials, region);
      const subnetMap = new Map();
      for (const inst of instances) {
        const key = inst.subnetId || inst.vpcId || 'default';
        if (!subnetMap.has(key)) subnetMap.set(key, { group: key, env: 'AWS', servers: [] });
        subnetMap.get(key).servers.push(inst);
      }
      apiGroups = Array.from(subnetMap.values()).map(g => ({
        ...g,
        counts: {
          total: g.servers.length,
          up:    g.servers.filter(s => s.upDown === 'up').length,
          down:  g.servers.filter(s => s.upDown === 'down').length,
          rdpDown: 0
        }
      }));
    }
  } catch { /* AWS API unavailable or credentials not configured — show only manual servers */ }

  const allGroups   = [...configGroups, ...apiGroups];
  const allEnriched = allGroups.flatMap(g => g.servers || []);
  const { windowsGroups, linuxGroups } = splitGroups(allEnriched);
  res.json({ provider: 'aws', groups: allGroups, windowsGroups, linuxGroups, timestamp: new Date().toISOString() });
});

// ── AWS Health — WinRM health checks for manually-configured AWS servers ──────
router.get('/aws/health', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'AWS');
  if (!servers.length) return res.json({ provider: 'aws', healthCounts: [], windowsHealthCounts: [], linuxHealthCounts: [], timestamp: new Date().toISOString() });

  const cached = await healthCache.ensure(servers, 10);
  healthCache.startBackgroundRefresh('aws', servers);
  const rows       = cached.map(toCountRow);
  const withStatus = servers.map((s, i) => ({ ...s, ...rows[i] }));

  const grouped = groupServersByEnv(withStatus);
  const healthCounts = grouped.map(g => ({
    group:     g.group,
    healthy:   g.servers.filter(s => s.status === 'healthy').length,
    warning:   g.servers.filter(s => s.status === 'warning').length,
    critical:  g.servers.filter(s => s.status === 'critical').length,
    error:     g.servers.filter(s => s.status === 'error').length,
    winrmDown: g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:  g.servers.filter(s => !s.winrmUp && !s.rdpUp).length,
    rdpDown:   g.servers.filter(s =>  s.winrmUp && !s.rdpUp).length
  }));

  const { windowsHealthCounts, linuxHealthCounts } = splitHealthGroups(withStatus);
  res.json({ provider: 'aws', healthCounts, windowsHealthCounts, linuxHealthCounts, timestamp: new Date().toISOString() });
});

// ── Azure Fleet — TCP probes + Azure power state (fast) ──────────────────────
router.get('/azure', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'Azure');
  const [probeResults, azureStateMap] = await Promise.all([probeAll(servers), getAzureStateMap()]);
  const probeMap = new Map(probeResults.map(p => [p.id, p]));

  const enriched = servers.map(s => {
    const azState = azureStateMap.get(azureVmName(s));
    const isStopped = azState === 'stopped' || azState === 'deallocated';
    const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
    return {
      ...sanitize(s),
      winrm:   isStopped ? 'stopped' : probe.winrm,
      rdp:     isStopped ? 'stopped' : probe.rdp,
      upDown:  isStopped ? 'stopped' : (probe.winrm === 'up' ? 'up' : 'down'),
      azState: azState || null
    };
  });

  const grouped = groupServersByEnv(enriched);
  const groupsWithCounts = grouped.map(g => ({
    ...g,
    counts: {
      total:     g.servers.length,
      up:        g.servers.filter(s => s.upDown === 'up').length,
      stopped:   g.servers.filter(s => s.upDown === 'stopped').length,
      down:      g.servers.filter(s => s.upDown === 'down').length,
      winrmDown: g.servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
      bothDown:  g.servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
      rdpDown:   g.servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length
    }
  }));

  const { windowsGroups, linuxGroups } = splitGroups(enriched);
  res.json({ provider: 'azure', groups: groupsWithCounts, windowsGroups, linuxGroups, timestamp: new Date().toISOString() });
});

// ── Azure Health — uses shared cache + Azure power state ─────────────────────
router.get('/azure/health', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'Azure');
  const azureStateMap = await getAzureStateMap();

  const activeServers  = servers.filter(s => { const st = azureStateMap.get(azureVmName(s)); return st !== 'stopped' && st !== 'deallocated'; });
  const stoppedServers = servers.filter(s => { const st = azureStateMap.get(azureVmName(s)); return st === 'stopped' || st === 'deallocated'; });

  const cached = await healthCache.ensure(activeServers, 10);
  healthCache.startBackgroundRefresh('azure', activeServers);
  const activeStatuses  = activeServers.map((s, i) => ({ ...s, ...toCountRow(cached[i]) }));
  const stoppedStatuses = stoppedServers.map(s => ({ ...s, status: 'stopped', rdpUp: false }));
  const withStatus      = [...activeStatuses, ...stoppedStatuses];

  const grouped = groupServersByEnv(withStatus);
  const healthCounts = grouped.map(g => ({
    group:     g.group,
    healthy:   g.servers.filter(s => s.status === 'healthy').length,
    warning:   g.servers.filter(s => s.status === 'warning').length,
    critical:  g.servers.filter(s => s.status === 'critical').length,
    error:     g.servers.filter(s => s.status === 'error').length,
    stopped:   g.servers.filter(s => s.status === 'stopped').length,
    winrmDown: g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:  g.servers.filter(s => !s.winrmUp && !s.rdpUp).length,
    rdpDown:   g.servers.filter(s =>  s.winrmUp && !s.rdpUp && s.status !== 'stopped').length
  }));

  const { windowsHealthCounts, linuxHealthCounts } = splitHealthGroups(withStatus);
  res.json({ provider: 'azure', healthCounts, windowsHealthCounts, linuxHealthCounts, timestamp: new Date().toISOString() });
});

// ── On-Prem vCenter Fleet — TCP probes only (fast) ───────────────────────────
router.get('/onprem', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'OnPrem');
  const probeResults = await probeAll(servers);
  const probeMap = new Map(probeResults.map(p => [p.id, p]));

  const enriched = servers.map(s => {
    const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
    return {
      ...sanitize(s),
      winrm:  probe.winrm,
      rdp:    probe.rdp,
      upDown: probe.winrm === 'up' ? 'up' : 'down'
    };
  });

  const grouped = groupServersByEnv(enriched);
  const groupsWithCounts = grouped.map(g => ({
    ...g,
    counts: {
      total:    g.servers.length,
      up:       g.servers.filter(s => s.upDown === 'up').length,
      down:     g.servers.filter(s => s.upDown === 'down').length,
      winrmDown: g.servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
      bothDown: g.servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
      rdpDown:  g.servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length
    }
  }));

  const { windowsGroups, linuxGroups } = splitGroups(enriched);
  res.json({ provider: 'onprem', groups: groupsWithCounts, windowsGroups, linuxGroups, timestamp: new Date().toISOString() });
});

// ── On-Prem vCenter Health — uses shared cache ───────────────────────────────
router.get('/onprem/health', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'OnPrem');
  const cached  = await healthCache.ensure(servers, 10);
  healthCache.startBackgroundRefresh('onprem', servers);
  const rows       = cached.map(toCountRow);
  const withStatus = servers.map((s, i) => ({ ...s, ...rows[i] }));

  const grouped = groupServersByEnv(withStatus);
  const healthCounts = grouped.map(g => ({
    group:     g.group,
    healthy:   g.servers.filter(s => s.status === 'healthy').length,
    warning:   g.servers.filter(s => s.status === 'warning').length,
    critical:  g.servers.filter(s => s.status === 'critical').length,
    error:     g.servers.filter(s => s.status === 'error').length,
    winrmDown: g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:  g.servers.filter(s => !s.winrmUp && !s.rdpUp).length,
    rdpDown:   g.servers.filter(s =>  s.winrmUp && !s.rdpUp).length
  }));

  const { windowsHealthCounts, linuxHealthCounts } = splitHealthGroups(withStatus);
  res.json({ provider: 'onprem', healthCounts, windowsHealthCounts, linuxHealthCounts, timestamp: new Date().toISOString() });
});

// ── OCI Fleet ─────────────────────────────────────────────────────────────────
router.get('/oci', async (req, res) => {
  // ── Manually-configured OCI servers from Excel ────────────────────────────
  const manualServers = loadServers().filter(s => s.provider === 'OCI');
  let manualGroups = [];
  if (manualServers.length > 0) {
    const probeResults = await probeAll(manualServers);
    const probeMap     = new Map(probeResults.map(p => [p.id, p]));
    const enriched     = manualServers.map(s => {
      const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
      return { ...sanitize(s), winrm: probe.winrm, rdp: probe.rdp, upDown: probe.winrm === 'up' ? 'up' : 'down' };
    });
    manualGroups = groupServersByEnv(enriched).map(g => ({
      ...g,
      counts: {
        total:     g.servers.length,
        up:        g.servers.filter(s => s.upDown === 'up').length,
        down:      g.servers.filter(s => s.upDown === 'down').length,
        winrmDown: g.servers.filter(s => s.upDown === 'down' && s.rdp === 'up').length,
        bothDown:  g.servers.filter(s => s.upDown === 'down' && s.rdp === 'down').length,
        rdpDown:   g.servers.filter(s => s.upDown === 'up'   && s.rdp === 'down').length,
      }
    }));
  }

  // ── OCI API-discovered instances (silently skipped if not configured) ──────
  let apiGroups = [];
  try {
    const clouds    = loadClouds();
    const instances = await ociService.getFleetStatus(clouds);
    const regionMap = new Map();
    for (const inst of instances) {
      const key = inst.region || 'default';
      if (!regionMap.has(key)) regionMap.set(key, { group: key, env: 'OCI', servers: [] });
      regionMap.get(key).servers.push(inst);
    }
    apiGroups = Array.from(regionMap.values()).map(g => ({
      ...g,
      counts: { total: g.servers.length, up: g.servers.filter(s => s.upDown === 'up').length, down: g.servers.filter(s => s.upDown === 'down').length, rdpDown: 0 }
    }));
  } catch { /* OCI API not configured — manual servers only */ }

  const allGroups   = [...manualGroups, ...apiGroups];
  const allEnriched = allGroups.flatMap(g => g.servers || []);
  const { windowsGroups, linuxGroups } = splitGroups(allEnriched);
  res.json({ provider: 'oci', groups: allGroups, windowsGroups, linuxGroups, timestamp: new Date().toISOString() });
});

// ── OCI Health — SSH/WinRM health checks for manually-configured OCI servers ──
router.get('/oci/health', async (req, res) => {
  const servers = loadServers().filter(s => s.provider === 'OCI');
  if (!servers.length) return res.json({ provider: 'oci', healthCounts: [], windowsHealthCounts: [], linuxHealthCounts: [], timestamp: new Date().toISOString() });

  const cached = await healthCache.ensure(servers, 10);
  healthCache.startBackgroundRefresh('oci', servers);
  const rows       = cached.map(toCountRow);
  const withStatus = servers.map((s, i) => ({ ...s, ...rows[i] }));

  const grouped = groupServersByEnv(withStatus);
  const healthCounts = grouped.map(g => ({
    group:     g.group,
    healthy:   g.servers.filter(s => s.status === 'healthy').length,
    warning:   g.servers.filter(s => s.status === 'warning').length,
    critical:  g.servers.filter(s => s.status === 'critical').length,
    error:     g.servers.filter(s => s.status === 'error').length,
    winrmDown: g.servers.filter(s => !s.winrmUp &&  s.rdpUp).length,
    bothDown:  g.servers.filter(s => !s.winrmUp && !s.rdpUp).length,
    rdpDown:   g.servers.filter(s =>  s.winrmUp && !s.rdpUp).length
  }));

  const { windowsHealthCounts, linuxHealthCounts } = splitHealthGroups(withStatus);
  res.json({ provider: 'oci', healthCounts, windowsHealthCounts, linuxHealthCounts, timestamp: new Date().toISOString() });
});

// ── POS Fleet — TCP probes only (fast) ───────────────────────────────────────
router.get('/pos', async (req, res) => {
  const servers = loadPos();
  if (!servers.length) return res.json({ provider: 'pos', groups: [], timestamp: new Date().toISOString() });

  const probeResults = await probeAll(servers);
  const probeMap = new Map(probeResults.map(p => [p.id, p]));

  const enriched = servers.map(s => {
    const probe = probeMap.get(s.id) || { winrm: 'down', rdp: 'down' };
    return { ...sanitize(s), winrm: probe.winrm, upDown: probe.winrm === 'up' ? 'up' : 'down' };
  });

  const grouped = groupPosServers(enriched);
  const groupsWithCounts = grouped.map(g => ({
    ...g,
    counts: {
      total: g.servers.length,
      up:    g.servers.filter(s => s.upDown === 'up').length,
      down:  g.servers.filter(s => s.upDown === 'down').length
    }
  }));

  res.json({ provider: 'pos', groups: groupsWithCounts, timestamp: new Date().toISOString() });
});

// ── POS Health — process check via shared cache ───────────────────────────────
router.get('/pos/health', async (req, res) => {
  const servers = loadPos();
  if (!servers.length) return res.json({ provider: 'pos', healthCounts: [], timestamp: new Date().toISOString() });

  const cached = await healthCache.ensure(servers, 10);
  healthCache.startBackgroundRefresh('pos', servers);

  const withStatus = servers.map((s, i) => {
    const c = cached[i];
    return {
      ...s,
      status:         c?.health?.status         ?? 'error',
      processRunning: c?.health?.processRunning ?? false,
      machineUp:      c?.probe?.winrm           === 'up'
    };
  });

  const grouped = groupPosServers(withStatus);
  const healthCounts = grouped.map(g => ({
    group:          g.group,
    processRunning: g.servers.filter(s => s.processRunning).length,
    processStopped: g.servers.filter(s => s.machineUp && !s.processRunning).length,
    machineDown:    g.servers.filter(s => !s.machineUp).length,
    total:          g.servers.length
  }));

  res.json({ provider: 'pos', healthCounts, timestamp: new Date().toISOString() });
});

module.exports = router;
