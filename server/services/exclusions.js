'use strict';

/**
 * exclusions.js
 * ─────────────
 * Servers listed in config/exclusions.json (powered off, awaiting removal, …) are left out of the fleet
 * tiles and lists, the forecasts, the correlation and the e-mail alerts.  The file is re-read when it
 * changes, so edits apply without a restart.  Nothing is deleted: history is kept, and removing an entry
 * brings the server straight back.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.EXCLUSIONS_FILE || path.join(__dirname, '../config/exclusions.json');
let _mtime = -1, _map = new Map();

function load() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (m === _mtime) return _map;
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _map = new Map((cfg.excluded || [])
      .map(e => typeof e === 'string' ? { id: e } : e)
      .filter(e => e && e.id)
      .map(e => [e.id, e.reason || 'Excluded from monitoring']));
    _mtime = m;
  } catch (err) {
    if (err.code === 'ENOENT') { _map = new Map(); _mtime = -1; }
    else console.error(`[exclusions] cannot read ${FILE}: ${err.message}`);   // keep the last good list
  }
  return _map;
}

const isExcluded = id => load().has(id);
const list = () => [...load()].map(([id, reason]) => ({ id, reason }));

module.exports = { isExcluded, list };
