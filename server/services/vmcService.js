'use strict';

const { execFile } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs/promises');

// ── Temp file race-condition fix ──────────────────────────────────────────────
function tmpPath() {
  return path.join(os.tmpdir(),
    `hmv2_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
}

function sanitizeHost(host) {
  if (!/^[\w.\-]+$/.test(host)) throw new Error(`Invalid host: ${host}`);
  return host;
}

function esc(str) { return String(str || '').replace(/'/g, "''"); }

async function runRemotePS(server, scriptLines, timeoutMs = 60000) {
  const host = sanitizeHost(server.winrm?.host || server.host);
  const { username, password, port = 5985, auth = 'Negotiate' } = server.winrm || {};

  const credBlock = (password && password !== '')
    ? `$pass = ConvertTo-SecureString '${esc(password)}' -AsPlainText -Force\n` +
      `$cred = New-Object PSCredential('${esc(username)}', $pass)\n` +
      `$extra = @{ Credential = $cred }`
    : `$extra = @{}`;

  const script = [
    `Set-StrictMode -Off`,
    `$ErrorActionPreference = 'Stop'`,
    credBlock,
    `$sb = {`, scriptLines, `}`,
    `try {`,
    `  $r = Invoke-Command -ComputerName '${host}' -Port ${port} -Authentication ${auth} -ScriptBlock $sb @extra`,
    `  if ($r -is [string]) { $r } else { $r | ConvertTo-Json -Depth 5 -Compress -WarningAction SilentlyContinue }`,
    `} catch {`,
    `  $msg = $_.Exception.Message`,
    `  if ($_.Exception.InnerException) { $msg += ' >> ' + $_.Exception.InnerException.Message }`,
    `  Write-Output "WINRM_ERROR:$msg"`,
    `  exit 1`,
    `}`
  ].join('\n');

  const tmpFile = tmpPath();
  await fs.writeFile(tmpFile, '﻿' + script, 'utf8');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      async (err, stdout, stderr) => {
        await fs.unlink(tmpFile).catch(() => {});
        const out = stdout.trim();
        if (out.startsWith('WINRM_ERROR:')) {
          return reject(new Error(out.replace('WINRM_ERROR:', '').trim()));
        }
        if (err) {
          const lines = (stderr || '').trim().split('\n')
            .filter(l => l && !l.startsWith('At ') && !l.startsWith('+') && !l.startsWith('    '));
          return reject(new Error(lines[0] || err.message));
        }
        if (!out) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { resolve(out); }
      }
    );
  });
}

// ── Sustained threshold tracking ─────────────────────────────────────────────
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

function evalCpuStatus(id, cpu) { return evalMetricStatus(cpuConsecutive, id, cpu, 85, 90); }
function evalMemStatus(id, mem) { return evalMetricStatus(memConsecutive, id, mem, 90, 95); }

// ── Health scripts ────────────────────────────────────────────────────────────
const HEALTH_SCRIPT = `
$cpu = $null
try { $cpu = [math]::Round((Get-WmiObject Win32_Processor | Measure-Object LoadPercentage -Average).Average, 1) } catch {}
$os   = Get-WmiObject Win32_OperatingSystem
$memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$memFreeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$memUsedPct = [math]::Round(100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100), 1)
$uptime = (Get-Date) - $os.ConvertToDateTime($os.LastBootUpTime)
$ip = (Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled -eq $true -and $_.IPAddress -ne $null } | Select-Object -First 1).IPAddress | Where-Object { $_ -notlike "*:*" } | Select-Object -First 1
$rdpSvc = Get-Service TermService -ErrorAction SilentlyContinue
$rdpStatus = if ($rdpSvc -and $rdpSvc.Status -eq "Running") { "Running" } else { "Stopped" }
$disks = @(Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [PSCustomObject]@{
    drive   = $_.DeviceID
    sizeGB  = [math]::Round($_.Size / 1GB, 1)
    freeGB  = [math]::Round($_.FreeSpace / 1GB, 1)
    usedPct = [math]::Round(100 - ($_.FreeSpace / $_.Size * 100), 1)
  }
})
$netInKB = 0; $netOutKB = 0
try {
  $netStats = @(Get-WmiObject Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($netStats) { $netInKB = [math]::Round($netStats.BytesReceivedPerSec / 1024, 1); $netOutKB = [math]::Round($netStats.BytesSentPerSec / 1024, 1) }
} catch {}
[PSCustomObject]@{
  cpu        = $cpu
  memTotalGB = $memTotalGB
  memFreeGB  = $memFreeGB
  memUsedPct = $memUsedPct
  uptimeDays = [math]::Round($uptime.TotalDays, 1)
  osName     = $os.Caption
  hostname   = $env:COMPUTERNAME
  ipAddress  = $ip
  rdpStatus  = $rdpStatus
  disks      = $disks
  netInKB    = $netInKB
  netOutKB   = $netOutKB
} | ConvertTo-Json -Depth 4 -Compress`.trim();

// PS 2.0 compatible script — no ConvertTo-Json, builds JSON manually
const HEALTH_SCRIPT_LEGACY = `
$cpu = $null
try { $cpu = [math]::Round((Get-WmiObject Win32_Processor | Measure-Object LoadPercentage -Average).Average, 1) } catch {}
$os   = Get-WmiObject Win32_OperatingSystem
$memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$memFreeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$memUsedPct = [math]::Round(100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100), 1)
$uptime = (Get-Date) - $os.ConvertToDateTime($os.LastBootUpTime)
$ip = (Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled -eq $true -and $_.IPAddress -ne $null } | Select-Object -First 1).IPAddress | Where-Object { $_ -notlike "*:*" } | Select-Object -First 1
$rdpSvc = Get-Service TermService -ErrorAction SilentlyContinue
$rdpStatus = if ($rdpSvc -and $rdpSvc.Status -eq "Running") { "Running" } else { "Stopped" }
$diskParts = @()
Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $used = [math]::Round(100 - ($_.FreeSpace / $_.Size * 100), 1)
  $diskParts += "{""drive"":""$($_.DeviceID)"",""sizeGB"":$([math]::Round($_.Size/1GB,1)),""freeGB"":$([math]::Round($_.FreeSpace/1GB,1)),""usedPct"":$used}"
}
$disksJson = $diskParts -join ","
$ipVal  = if ($ip)  { """$ip""" }  else { "null" }
$cpuVal = if ($cpu -ne $null) { $cpu } else { "null" }
$osEsc = ($os.Caption -replace '"','')
$hn    = $env:COMPUTERNAME
$ud    = [math]::Round($uptime.TotalDays, 1)
"{""cpu"":$cpuVal,""memTotalGB"":$memTotalGB,""memFreeGB"":$memFreeGB,""memUsedPct"":$memUsedPct,""uptimeDays"":$ud,""osName"":""$osEsc"",""hostname"":""$hn"",""ipAddress"":$ipVal,""rdpStatus"":""$rdpStatus"",""disks"":[$disksJson],""netInKB"":0,""netOutKB"":0}"`.trim();

function buildServiceScript(serviceNames) {
  const list = serviceNames.map(s => `'${esc(s)}'`).join(',');
  return `
@(${list}) | ForEach-Object {
  $svc = Get-Service $_ -ErrorAction SilentlyContinue
  $lastStart = $null
  try {
    $evt = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=7036 } -MaxEvents 200 -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -like "*$_*started*" } |
      Select-Object -First 1
    if ($evt) { $lastStart = $evt.TimeCreated.ToUniversalTime().ToString('o') }
  } catch {}
  if ($svc) { [PSCustomObject]@{ name=$svc.Name; display=$svc.DisplayName; status=$svc.Status.ToString(); lastStart=$lastStart } }
  else       { [PSCustomObject]@{ name=$_; display=$_; status='NotFound'; lastStart=$null } }
} | ConvertTo-Json -Depth 3 -Compress`.trim();
}

// ── POS process monitor ───────────────────────────────────────────────────────

function buildPosScript(processName) {
  const safe = esc(processName.replace(/\.exe$/i, ''));
  return `
$proc = @(Get-Process '${safe}' -ErrorAction SilentlyContinue)
$running = ($proc.Count -gt 0)
$pid2 = if ($running) { $proc[0].Id } else { $null }
$cpu = $null
try { $cpu = [math]::Round((Get-WmiObject Win32_Processor | Measure-Object LoadPercentage -Average).Average, 1) } catch {}
$os = Get-WmiObject Win32_OperatingSystem
$memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$memFreeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$memUsedPct = [math]::Round(100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100), 1)
$uptime = (Get-Date) - $os.ConvertToDateTime($os.LastBootUpTime)
$disks = @(Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [PSCustomObject]@{
    drive   = $_.DeviceID
    sizeGB  = [math]::Round($_.Size / 1GB, 1)
    freeGB  = [math]::Round($_.FreeSpace / 1GB, 1)
    usedPct = [math]::Round(100 - ($_.FreeSpace / $_.Size * 100), 1)
  }
})
[PSCustomObject]@{
  processRunning = $running
  processPid     = $pid2
  cpu            = $cpu
  memTotalGB     = $memTotalGB
  memFreeGB      = $memFreeGB
  memUsedPct     = $memUsedPct
  uptimeDays     = [math]::Round($uptime.TotalDays, 1)
  osName         = $os.Caption
  hostname       = $env:COMPUTERNAME
  disks          = $disks
} | ConvertTo-Json -Depth 4 -Compress`.trim();
}

async function getPosHealth(server) {
  const processName = (server.process || 'unknown').replace(/\.exe$/i, '');
  try {
    const data = await runRemotePS(server, buildPosScript(processName));
    return {
      ...server,
      provider:       'POS',
      state:          'running',
      status:         data.processRunning ? 'healthy' : 'critical',
      processRunning: data.processRunning,
      processName,
      processPid:     data.processPid ?? null,
      osName:         data.osName,
      hostname:       data.hostname,
      uptimeDays:     data.uptimeDays,
      disks:          Array.isArray(data.disks) ? data.disks : (data.disks ? [data.disks] : []),
      metrics: {
        cpu:        data.cpu,
        memUsedPct: data.memUsedPct,
        memTotalGB: data.memTotalGB,
        memFreeGB:  data.memFreeGB
      }
    };
  } catch (err) {
    console.error(`[posHealth] ${server.id}: ${err.message}`);
    return { ...server, provider: 'POS', state: 'unknown', status: 'error', processRunning: false, error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

async function getServerHealth(server) {
  if (server.provider === 'POS') return getPosHealth(server);
  try {
    const script = server.legacyPs ? HEALTH_SCRIPT_LEGACY : HEALTH_SCRIPT;
    const data = await runRemotePS(server, script);
    const disks = Array.isArray(data.disks) ? data.disks : (data.disks ? [data.disks] : []);
    const maxDiskPct = disks.reduce((m, d) => Math.max(m, d.usedPct || 0), 0);

    const cpuStatus = evalCpuStatus(server.id, data.cpu);
    const memStatus = evalMemStatus(server.id, data.memUsedPct);
    let status = 'healthy';
    if (cpuStatus === 'critical' || memStatus === 'critical' || maxDiskPct >= 95) status = 'critical';
    else if (cpuStatus === 'warning' || memStatus === 'warning' || maxDiskPct >= 90) status = 'warning';

    let services = [];
    if (server.services?.length) {
      try {
        const svcData = await runRemotePS(server, buildServiceScript(server.services));
        services = Array.isArray(svcData) ? svcData : [svcData].filter(Boolean);
        const critDown = services.some(s => server.criticalServices?.includes(s.name) && s.status !== 'Running');
        if (critDown) status = 'critical';
      } catch {}
    }

    return {
      ...server,
      provider: 'VMC',
      state: 'running',
      status,
      osName:     data.osName,
      hostname:   data.hostname,
      ipAddress:  data.ipAddress || null,
      rdpStatus:  data.rdpStatus || 'Unknown',
      uptimeDays: data.uptimeDays,
      metrics: {
        cpu:       data.cpu,
        memUsedPct: data.memUsedPct,
        memTotalGB: data.memTotalGB,
        memFreeGB:  data.memFreeGB,
        netInKB:   data.netInKB,
        netOutKB:  data.netOutKB
      },
      disks,
      services
    };
  } catch (err) {
    console.error(`[vmcService] ${server.id}: ${err.message}`);
    return { ...server, provider: 'VMC', state: 'unknown', status: 'error', error: err.message };
  }
}

async function getServerServices(server) {
  if (!server.services?.length) return [];
  const svcData = await runRemotePS(server, buildServiceScript(server.services));
  return Array.isArray(svcData) ? svcData : [svcData].filter(Boolean);
}

async function getAllAutomaticServices(server) {
  const script = `
Get-Service | Where-Object { $_.StartType -eq 'Automatic' } |
  Sort-Object DisplayName |
  ForEach-Object {
    [PSCustomObject]@{ name=$_.Name; display=$_.DisplayName; status=$_.Status.ToString(); startType='Automatic' }
  } | ConvertTo-Json -Depth 2 -Compress`.trim();
  const data = await runRemotePS(server, script, 30000);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

async function getLogs(server, lines = 100) {
  const script = `
$events = Get-WinEvent -FilterHashtable @{ LogName='System','Application'; Level=1,2,3 } -MaxEvents ${Math.min(lines, 500)} -ErrorAction SilentlyContinue |
  Sort-Object TimeCreated -Descending
@($events | ForEach-Object {
  [PSCustomObject]@{
    timestamp = $_.TimeCreated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    level     = $_.LevelDisplayName
    source    = $_.ProviderName
    message   = ($_.Message -replace "[\\r\\n]+"," ").Substring(0, [Math]::Min(($_.Message -replace "[\\r\\n]+"," ").Length, 300))
  }
}) | ConvertTo-Json -Depth 3 -Compress`.trim();

  const data = await runRemotePS(server, script, 45000);
  const entries = Array.isArray(data) ? data : (data ? [data] : []);
  return {
    source: 'windows-event-log',
    lines: entries.map(e => ({ timestamp: e.timestamp, message: `[${e.level}] [${e.source}] ${e.message}` }))
  };
}

async function restartServer(server) {
  await runRemotePS(server, `Restart-Computer -Force`, 15000);
  return { message: `Restart command sent to ${server.name}` };
}

async function runScript(server, scriptContent) {
  const result = await runRemotePS(server, scriptContent, 120000);
  const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { stdout: output, stderr: '', exitCode: 0, success: true };
}

/**
 * Restart one Windows service, running AS the person who asked (their own admin credentials), so the
 * server's own permissions decide.  Running dependants that stop with it are started again.
 * The name must already be validated by the caller (letters, digits and _ . - $ @ space only).
 */
async function restartService(server, serviceName, { username, password }) {
  const name = String(serviceName).replace(/'/g, "''");
  const asUser = { ...server, winrm: { ...(server.winrm || {}), username, password } };
  const script = `
$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ACCESS_DENIED: this account is not an administrator on the server' }
$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue
if (-not $s) { throw 'NOT_FOUND: no service with that name on the server' }
$before = $s.Status.ToString()
$deps = @($s.DependentServices | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name })
Restart-Service -Name '${name}' -Force
$timedOut = $false
try { $s.WaitForStatus('Running', [TimeSpan]::FromSeconds(60)) } catch { $timedOut = $true }
foreach ($d in $deps) { $x = Get-Service -Name $d; if ($x.Status -ne 'Running') { try { Start-Service -Name $d } catch {} } }
$s.Refresh()
[PSCustomObject]@{ name = $s.Name; display = $s.DisplayName; before = $before; after = $s.Status.ToString(); dependents = $deps; timedOut = $timedOut }`.trim();
  const r = await runRemotePS(asUser, script, 120000);
  return typeof r === 'object' && r ? r : { name: serviceName, after: 'Unknown', raw: r };
}

module.exports = { getServerHealth, getPosHealth, getServerServices, getAllAutomaticServices, getLogs, restartServer, runScript, restartService };
