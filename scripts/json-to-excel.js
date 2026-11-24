'use strict';

/**
 * json-to-excel.js
 * ────────────────
 * One-time migration: reads the existing servers.json, pos.json, and
 * databases.json files and writes them all into a single Excel workbook
 * at server/config/servers.xlsx with three sheets.
 *
 * Run from the project root:
 *   node scripts/json-to-excel.js
 *
 * After running:
 *   1. Open server/config/servers.xlsx in Excel and check your data.
 *   2. The Health Monitor will now read from Excel automatically.
 *      The JSON files are kept as an automatic fallback — do NOT delete them.
 *   3. To add/remove servers in future: edit the Excel, save it, then
 *      click the ↺ refresh button in the Health Monitor.
 *
 * Re-running this script OVERWRITES the existing Excel — use it only
 * once for the initial migration, then maintain via Excel directly.
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const CONFIG = path.resolve(__dirname, '../server/config');
const OUT    = path.join(CONFIG, 'servers.xlsx');

function readJson(file) {
  try {
    const raw = fs.readFileSync(path.join(CONFIG, file), 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`  ⚠  Could not read ${file}: ${e.message}`);
    return [];
  }
}

// ── Build Servers sheet ────────────────────────────────────────────────────────
const servers = readJson('servers.json');

const serverRows = servers.map(s => ({
  id:             s.id                                    ?? '',
  name:           s.name                                  ?? s.id ?? '',
  group:          s.group                                 ?? '',
  provider:       s.provider                              ?? 'VMC',
  os:             s.os                                    ?? 'windows',
  host:           s.host                                  ?? '',
  domain:         s.domain                                ?? '',
  legacyPs:       s.legacyPs   ? 'TRUE' : '',
  poweredOff:     s.poweredOff ? 'TRUE' : '',
  winrm_host:     s.winrm?.host                           ?? s.host ?? '',
  winrm_port:     s.winrm?.port                           ?? 5985,
  winrm_username: s.winrm?.username                       ?? '',
  winrm_password: s.winrm?.password                       ?? '',
  winrm_domain:   s.winrm?.domain                         ?? '',
  services:       Array.isArray(s.services)
                    ? s.services.join(', ')
                    : '',
  notes:          s._note                                 ?? '',
}));

// ── Build POS sheet ────────────────────────────────────────────────────────────
const posData = readJson('pos.json');

const posRows = posData.map(s => ({
  id:             s.id             ?? '',
  name:           s.name           ?? s.id ?? '',
  host:           s.host           ?? '',
  group:          s.group          ?? 'POS',
  process:        s.process        ?? '',
  poweredOff:     s.poweredOff ? 'TRUE' : '',
  winrm_host:     s.winrm?.host    ?? s.host ?? '',
  winrm_port:     s.winrm?.port    ?? 5985,
  winrm_username: s.winrm?.username ?? '',
  winrm_password: s.winrm?.password ?? '',
  notes:          '',
}));

// ── Build Databases sheet ──────────────────────────────────────────────────────
const dbData = readJson('databases.json');

const dbRows = dbData.map(d => ({
  id:    d.id    ?? '',
  name:  d.name  ?? d.id ?? '',
  host:  d.host  ?? '',
  type:  d.type  ?? 'mssql',
  port:  d.port  ?? '',
  group: d.group ?? '',
  notes: '',
}));

// ── Helper: apply column widths ────────────────────────────────────────────────
function setColWidths(ws, cols) {
  ws['!cols'] = cols.map(w => ({ wch: w }));
}

// ── Build workbook ─────────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();

// Servers sheet
const wsServers = XLSX.utils.json_to_sheet(
  serverRows.length ? serverRows : [{
    id:'', name:'', group:'', provider:'VMC', os:'windows',
    host:'', domain:'', legacyPs:'', poweredOff:'',
    winrm_host:'', winrm_port:5985, winrm_username:'', winrm_password:'',
    winrm_domain:'', services:'', notes:''
  }]
);
setColWidths(wsServers, [30, 35, 12, 10, 10, 40, 25, 10, 10, 40, 8, 22, 22, 22, 30, 20]);
XLSX.utils.book_append_sheet(wb, wsServers, 'Servers');

// POS sheet
const wsPos = XLSX.utils.json_to_sheet(
  posRows.length ? posRows : [{
    id:'', name:'', host:'', group:'POS', process:'', poweredOff:'',
    winrm_host:'', winrm_port:5985, winrm_username:'', winrm_password:'', notes:''
  }]
);
setColWidths(wsPos, [20, 20, 25, 12, 20, 10, 25, 8, 20, 20, 30]);
XLSX.utils.book_append_sheet(wb, wsPos, 'POS');

// Databases sheet
const wsDb = XLSX.utils.json_to_sheet(
  dbRows.length ? dbRows : [{ id:'', name:'', host:'', type:'mssql', port:'', group:'', notes:'' }]
);
setColWidths(wsDb, [20, 25, 35, 8, 6, 12, 30]);
XLSX.utils.book_append_sheet(wb, wsDb, 'Databases');

XLSX.writeFile(wb, OUT);

console.log('');
console.log('✅  Migration complete!');
console.log(`   Output : ${OUT}`);
console.log(`   Servers sheet   : ${serverRows.length} rows`);
console.log(`   POS sheet       : ${posRows.length} rows`);
console.log(`   Databases sheet : ${dbRows.length} rows`);
console.log('');
console.log('Next steps:');
console.log('  1. Open server/config/servers.xlsx in Excel and verify the data looks correct.');
console.log('  2. The Health Monitor will now read from Excel automatically (JSON files kept as backup).');
console.log('  3. In future, add/remove servers by editing the Excel and clicking ↺ in the app.');
console.log('');
