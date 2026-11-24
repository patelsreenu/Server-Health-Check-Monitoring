'use strict';

const net = require('net');

const PROBE_TIMEOUT_MS = 3000;

function tcpProbe(host, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done('up'));
    socket.once('timeout', () => done('down'));
    socket.once('error',   () => done('down'));
    socket.connect(port, host);
  });
}

// Retry once before declaring 'down' — prevents a single network blip from
// marking a server as down for the full cache TTL period.
async function tcpProbeWithRetry(host, port) {
  const first = await tcpProbe(host, port);
  if (first === 'up') return 'up';
  await new Promise(r => setTimeout(r, 500));
  return tcpProbe(host, port);
}

async function probeServer(server) {
  if (server.os === 'linux') {
    const host = server.ssh?.host || server.host;
    if (!host) return { id: server.id, winrm: 'down', rdp: 'n/a' };
    const ssh = await tcpProbeWithRetry(host, server.ssh?.port || 22);
    return { id: server.id, name: server.name, host, winrm: ssh, rdp: 'n/a' };
  }

  const host = server.winrm?.host || server.host;
  if (!host) return { id: server.id, winrm: 'down', rdp: 'down' };

  const [winrm, rdp] = await Promise.all([
    tcpProbeWithRetry(host, server.winrm?.port || 5985),
    tcpProbeWithRetry(host, 3389)
  ]);

  return { id: server.id, name: server.name, host, winrm, rdp };
}

async function probeAll(servers, concurrency = 25) {
  const results = new Array(servers.length);
  let next = 0;
  async function worker() {
    while (next < servers.length) {
      const i = next++;
      results[i] = await probeServer(servers[i]).catch(() => ({
        id: servers[i].id, name: servers[i].name, host: servers[i].host, winrm: 'down', rdp: 'down'
      }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, worker));
  return results;
}

module.exports = { probeServer, probeAll };
