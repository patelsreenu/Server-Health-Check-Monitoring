'use strict';

const { NodeSSH } = require('node-ssh');
const fs = require('fs');

// ── Sustained threshold tracking (same pattern as vmcService) ─────────────────
const cpuConsecutive = new Map();
const memConsecutive = new Map();

function evalMetricStatus(map, serverId, value, warnThreshold, critThreshold) {
  const prev = map.get(serverId) || { warn: 0, crit: 0 };
  let { warn, crit } = prev;
  if (value > critThreshold)      { crit += 1; warn = 0; }
  else if (value > warnThreshold) { warn += 1; crit = 0; }
  else                            { warn = 0;  crit = 0; }
  map.set(serverId, { warn, crit });
  if (crit >= 2) return 'critical';
  if (warn >= 2) return 'warning';
  return 'healthy';
}

// Bash script run remotely — outputs a single JSON line.
// Shell ${VAR:-default} patterns are escaped as \${...} so JS doesn't interpolate them.
// In the awk printf, \" must be written as \\" in this template literal so the backslash survives into bash.
const HEALTH_SCRIPT = `\
MEM_TOTAL=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_AVAIL=$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_USED=$(( \${MEM_TOTAL:-0} - \${MEM_AVAIL:-0} ))
UPTIME=$(awk '{printf "%.0f",$1}' /proc/uptime 2>/dev/null || echo 0)
OS_NAME=$(grep '^PRETTY_NAME' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | head -1 || echo Linux)
CPU=$(awk '/^cpu /{u=$2+$4;t=0;for(i=2;i<=NF;i++)t+=$i;if(t>0)printf "%.1f",u/t*100;else print 0;exit}' /proc/stat 2>/dev/null || echo 0)
LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
DISKS_JSON=$(df -PB1 2>/dev/null | awk 'NR>1 && $1!~/^(tmpfs|devtmpfs|overlay|squashfs|udev|none)$/ && substr($6,1,7)!="/media/" && substr($6,1,5)!="/run/" && $2+0>1048576{if(n>0)printf ",";printf "{\\"mount\\":\\"%s\\",\\"total\\":%s,\\"used\\":%s}",$6,$2,$3;n++}')
printf '{"hostname":"%s","osName":"%s","cpu":%s,"memTotal":%s,"memUsed":%s,"uptime":%s,"load1":%s,"disks":[%s]}' "$(hostname)" "\${OS_NAME:-Linux}" "\${CPU:-0}" "\${MEM_TOTAL:-0}" "\${MEM_USED:-0}" "\${UPTIME:-0}" "\${LOAD:-0}" "\${DISKS_JSON:-}"`;

const TIMEOUT_MS = 30000;

async function getServerHealth(server) {
  const sshCfg  = server.ssh || {};
  const host     = sshCfg.host     || server.host;
  const port     = sshCfg.port     || 22;
  const username = sshCfg.username || process.env.SSH_USERNAME;
  const password = sshCfg.password || process.env.SSH_PASSWORD;
  const keyPath  = sshCfg.privateKey;

  if (!host)     return { ...server, status: 'error', state: 'unknown', error: 'No SSH host configured' };
  if (!username) return { ...server, status: 'error', state: 'unknown', error: 'No SSH username configured' };

  const conn = new NodeSSH();
  try {
    const cfg = { host, port, username, readyTimeout: TIMEOUT_MS };
    if (keyPath && fs.existsSync(keyPath)) {
      cfg.privateKey = fs.readFileSync(keyPath, 'utf8');
    } else if (password) {
      cfg.password = password;
    } else {
      return { ...server, status: 'error', state: 'unknown', error: 'No SSH password or private key configured' };
    }

    await conn.connect(cfg);
    const result = await conn.execCommand(HEALTH_SCRIPT);

    if (!result.stdout) throw new Error(result.stderr || 'Empty response from server');

    const data = JSON.parse(result.stdout.trim());

    const memTotalGB = data.memTotal / (1024 ** 3);
    const memFreeGB  = (data.memTotal - data.memUsed) / (1024 ** 3);
    const memUsedPct = data.memTotal > 0 ? (data.memUsed / data.memTotal) * 100 : 0;
    const uptimeDays = data.uptime / 86400;
    const cpu        = parseFloat(data.cpu || 0);

    // Build disk array from all reported filesystems
    let maxDiskPct = 0;
    const disks = Array.isArray(data.disks) ? data.disks.map(d => {
      const sizeGB  = d.total / (1024 ** 3);
      const freeGB  = (d.total - d.used) / (1024 ** 3);
      const usedPct = d.total > 0 ? (d.used / d.total) * 100 : 0;
      if (usedPct > maxDiskPct) maxDiskPct = usedPct;
      return {
        drive:   d.mount,
        sizeGB:  Math.round(sizeGB  * 10) / 10,
        freeGB:  Math.round(freeGB  * 10) / 10,
        usedPct: Math.round(usedPct * 10) / 10,
      };
    }) : [];

    const cpuStatus = evalMetricStatus(cpuConsecutive, server.id, cpu, 85, 90);
    const memStatus = evalMetricStatus(memConsecutive, server.id, memUsedPct, 90, 95);
    let status = 'healthy';
    if (cpuStatus === 'critical' || memStatus === 'critical' || maxDiskPct >= 95) status = 'critical';
    else if (cpuStatus === 'warning' || memStatus === 'warning' || maxDiskPct >= 90) status = 'warning';

    return {
      ...server,
      provider:   server.provider || 'OnPrem',
      os:         'linux',
      state:      'running',
      status,
      osName:     data.osName   || 'Linux',
      hostname:   data.hostname || server.id,
      uptimeDays: Math.round(uptimeDays * 10) / 10,
      metrics: {
        cpu:        Math.round(cpu        * 10)  / 10,
        memUsedPct: Math.round(memUsedPct * 10)  / 10,
        memTotalGB: Math.round(memTotalGB * 100) / 100,
        memFreeGB:  Math.round(memFreeGB  * 100) / 100,
        maxDiskPct: Math.round(maxDiskPct * 10)  / 10,
        load1:      parseFloat(data.load1 || 0),
      },
      disks,
    };
  } catch (err) {
    console.error(`[linuxHealth] ${server.id}: ${err.message}`);
    return { ...server, status: 'error', state: 'unknown', error: err.message };
  } finally {
    conn.dispose();
  }
}

module.exports = { getServerHealth };
