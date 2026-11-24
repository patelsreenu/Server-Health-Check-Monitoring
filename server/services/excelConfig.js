'use strict';

/**
 * excelConfig.js
 * ──────────────
 * Single source of truth for server / POS / database configuration.
 *
 * Priority:
 *   1. server/config/servers.xlsx  (3 sheets: Servers | POS | Databases)
 *   2. server/config/servers.json + pos.json + databases.json  (JSON fallback)
 *
 * To add or remove a server: edit the Excel, save it, then click the
 * hard-refresh button in the Health Monitor (no app restart needed).
 *
 * Column docs:
 *   Servers sheet:
 *     id             – required; unique key used throughout the app
 *     name           – display name (defaults to id)
 *     group          – environment label: Prod / Non-Prod / DR / etc.
 *     provider       – VMC | OnPrem | Azure
 *     os             – windows (default)
 *     host           – FQDN or IP address
 *     domain         – Windows domain (e.g. corp.example.com)
 *     legacyPs       – TRUE for PowerShell 2.0 servers
 *     poweredOff     – TRUE to exclude from health checks
 *     winrm_host     – WinRM host (defaults to host)
 *     winrm_port     – WinRM port (default 5985)
 *     winrm_username – leave blank to use ${WINRM_USERNAME} env var
 *     winrm_password – leave blank to use ${WINRM_PASSWORD} env var
 *     winrm_domain   – WinRM auth domain (usually blank for domain servers)
 *     ssh_host       – SSH host for Linux servers (defaults to host)
 *     ssh_port       – SSH port (default 22)
 *     ssh_username   – SSH username, or use ${SSH_USERNAME} env var
 *     ssh_password   – SSH password, or use ${SSH_PASSWORD} env var
 *     ssh_key        – path to SSH private key file (alternative to password)
 *     services       – comma-separated service names (adds SQL badge on Windows; systemd on Linux)
 *     notes          – free text, ignored by the app
 *
 *   POS sheet:
 *     id, name, host, group, process, poweredOff,
 *     winrm_host, winrm_port, winrm_username, winrm_password, notes
 *
 *   Databases sheet:
 *     id, name, host, type (mssql|mysql|oracle), port, group, notes
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_DIR   = path.resolve(__dirname, '../config');
const EXCEL_PATH   = path.join(CONFIG_DIR, 'servers.xlsx');
const SERVERS_JSON = path.join(CONFIG_DIR, 'servers.json');
const POS_JSON     = path.join(CONFIG_DIR, 'pos.json');
const DB_JSON      = path.join(CONFIG_DIR, 'databases.json');

// ── Helpers ────────────────────────────────────────────────────────────────────

// Expand ${VAR} environment-variable references (same as existing JSON loaders).
function resolveEnv(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? '');
}

function resolveEnvDeep(obj) {
  if (typeof obj === 'string') return resolveEnv(obj);
  if (Array.isArray(obj))     return obj.map(resolveEnvDeep);
  if (obj && typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveEnvDeep(v)]));
  return obj;
}

function str(v, def = '') {
  if (v == null || v === '') return def;
  return resolveEnv(String(v).trim());
}

function num(v, def) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return isNaN(n) ? def : n;
}

function bool(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function excelExists() {
  try { return fs.existsSync(EXCEL_PATH); } catch { return false; }
}

// Lazy-load xlsx so the app still starts even if the package isn't installed yet.
function getXLSX() {
  try { return require('xlsx'); }
  catch { return null; }
}

// ── Sheet parsers ──────────────────────────────────────────────────────────────

function parseServersSheet(wb) {
  const XLSX = getXLSX();
  const ws   = wb.Sheets['Servers'];
  if (!ws) return null;

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows
    .filter(r => str(r.id))   // skip blank rows
    .map(r => {
      const id   = str(r.id);
      const host = str(r.host, id);
      const s = {
        id,
        name:     str(r.name, id),
        provider: str(r.provider, 'VMC'),
        os:       str(r.os, 'windows'),
        host,
      };

      // Optional fields — only set if non-empty so JSON consumers see same shape
      const grp = str(r.group);
      if (grp)           s.group    = grp;
      const acct = str(r.account);
      if (acct)          s.account  = acct;
      const dom = str(r.domain);
      if (dom)           s.domain   = dom;
      if (bool(r.legacyPs))   s.legacyPs   = true;
      if (bool(r.poweredOff)) s.poweredOff = true;

      // winrm block
      const wHost = str(r.winrm_host, host);
      const wPort = num(r.winrm_port, 5985);
      s.winrm = { host: wHost, port: wPort };
      const wUser = str(r.winrm_username);
      const wPass = str(r.winrm_password);
      const wDom  = str(r.winrm_domain);
      if (wUser) s.winrm.username = wUser;
      if (wPass) s.winrm.password = wPass;
      if (wDom)  s.winrm.domain   = wDom;

      // ssh block (Linux servers — os=linux)
      if (s.os === 'linux') {
        const sHost = str(r.ssh_host, host);
        const sPort = num(r.ssh_port, 22);
        s.ssh = { host: sHost, port: sPort };
        const sUser = str(r.ssh_username);
        const sPass = str(r.ssh_password);
        const sKey  = str(r.ssh_key);
        if (sUser) s.ssh.username   = sUser;
        if (sPass) s.ssh.password   = sPass;
        if (sKey)  s.ssh.privateKey = sKey;
      }

      // services — comma-separated service names
      const svcRaw = str(r.services);
      s.services = svcRaw
        ? svcRaw.split(',').map(x => x.trim()).filter(Boolean)
        : [];

      return s;
    });
}

function parsePosSheet(wb) {
  const XLSX = getXLSX();
  const ws   = wb.Sheets['POS'];
  if (!ws) return null;

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows
    .filter(r => str(r.id))
    .map(r => {
      const id   = str(r.id);
      const host = str(r.host, id);
      const s = {
        id,
        name:     str(r.name, id),
        host,
        provider: 'POS',
        group:    str(r.group, 'POS'),
      };

      const proc = str(r.process);
      if (proc)               s.process    = proc;
      if (bool(r.poweredOff)) s.poweredOff = true;

      const wHost = str(r.winrm_host, host);
      const wPort = num(r.winrm_port, 5985);
      s.winrm = { host: wHost, port: wPort };
      const wUser = str(r.winrm_username);
      const wPass = str(r.winrm_password);
      if (wUser) s.winrm.username = wUser;
      if (wPass) s.winrm.password = wPass;

      return s;
    });
}

function parseDatabasesSheet(wb) {
  const XLSX = getXLSX();
  const ws   = wb.Sheets['Databases'];
  if (!ws) return null;

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows
    .filter(r => str(r.id))
    .map(r => {
      const id = str(r.id);
      const db = {
        id,
        name: str(r.name, id),
        type: str(r.type, 'mssql').toLowerCase(),
        host: str(r.host, id),
      };
      const p   = num(r.port);
      const grp = str(r.group);
      if (p)   db.port  = p;
      if (grp) db.group = grp;
      return db;
    });
}

// ── Public loaders ─────────────────────────────────────────────────────────────
//
// Each loader tries Excel first, falls back to the matching JSON file.
// The JSON fallback also passes through resolveEnvDeep so ${VAR} still works.

function loadServersRaw() {
  if (excelExists()) {
    const XLSX = getXLSX();
    if (XLSX) {
      try {
        const wb     = XLSX.readFile(EXCEL_PATH);
        const result = parseServersSheet(wb);
        if (result && result.length > 0) return result;
        console.warn('[excelConfig] Servers sheet is empty — falling back to servers.json');
      } catch (e) {
        console.error('[excelConfig] Error reading Servers sheet:', e.message, '— falling back to servers.json');
      }
    } else {
      console.warn('[excelConfig] xlsx package not found — falling back to servers.json. Run: npm install xlsx');
    }
  }

  const raw = fs.readFileSync(SERVERS_JSON, 'utf8').replace(/^﻿/, '');
  return resolveEnvDeep(JSON.parse(raw));
}

/**
 * VMC servers on config/exclusions.json are treated exactly like `poweredOff: TRUE` in the spreadsheet: they are
 * not health-checked and the VMC pages show them as powered off instead of down.  (Only the VMC pages and the
 * subnet pages understand powered-off; other providers are left out of the dashboard, forecasts and alerts only.)
 */
function loadServers() {
  const exclusions = require('./exclusions');
  return loadServersRaw().map(s => (s.provider === 'VMC' && !s.poweredOff && exclusions.isExcluded(s.id)) ? { ...s, poweredOff: true } : s);
}

function loadPos() {
  if (excelExists()) {
    const XLSX = getXLSX();
    if (XLSX) {
      try {
        const wb     = XLSX.readFile(EXCEL_PATH);
        const result = parsePosSheet(wb);
        if (result && result.length > 0) return result;
      } catch (e) {
        console.error('[excelConfig] Error reading POS sheet:', e.message, '— falling back to pos.json');
      }
    }
  }

  try {
    const raw = fs.readFileSync(POS_JSON, 'utf8').replace(/^﻿/, '');
    return resolveEnvDeep(JSON.parse(raw)).map(s => ({ ...s, provider: 'POS' }));
  } catch { return []; }
}

function loadDatabases() {
  if (excelExists()) {
    const XLSX = getXLSX();
    if (XLSX) {
      try {
        const wb     = XLSX.readFile(EXCEL_PATH);
        const result = parseDatabasesSheet(wb);
        if (result) return result;
      } catch (e) {
        console.error('[excelConfig] Error reading Databases sheet:', e.message, '— falling back to databases.json');
      }
    }
  }

  try {
    const raw = fs.readFileSync(DB_JSON, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch { return []; }
}

module.exports = { loadServers, loadPos, loadDatabases };
