'use strict';

const SubnetPage = (() => {
  let currentFilter   = 'all';
  let currentSearch   = '';
  let currentSort     = { field: 'name', dir: 1 };
  let currentData     = { servers: [], databases: [] };
  let currentProvider = '';
  let currentOs       = null;   // 'windows' | 'linux' | null (show all)

  // ── Cache helpers ─────────────────────────────────────────────────────────
  function cacheKey(provider, group) { return `${provider}:${group}`; }

  function getCached(provider, group) {
    const key  = cacheKey(provider, group);
    const entry = App.state.cache.subnets.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > 15 * 60 * 1000) return null; // expired
    return entry;
  }

  function setCache(provider, group, servers, databases) {
    App.state.cache.subnets.set(cacheKey(provider, group), {
      servers, databases, fetchedAt: Date.now()
    });
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load(provider, group, os) {
    currentProvider = provider || '';
    currentOs       = os || null;
    document.getElementById('subnet-title').textContent = `${(provider || '').toUpperCase()} — ${group}`;
    document.getElementById('subnet-meta').textContent  = 'Loading…';
    document.getElementById('servers-tbody').innerHTML   = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#8C8279">Loading…</td></tr>';
    document.getElementById('databases-tbody').innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#8C8279">Loading…</td></tr>';
    document.getElementById('stale-banner').classList.add('hidden');
    resetTabs();

    const cached = getCached(provider, group);
    if (cached) {
      currentData = { servers: cached.servers, databases: cached.databases };
      renderPage(provider, group, cached.fetchedAt, false);
      return;
    }

    // Fetch
    try {
      const [sRes, dRes] = await Promise.allSettled([
        App.api(`/api/v2/subnet/${provider}/${group}/servers`),
        App.api(`/api/v2/subnet/${provider}/${group}/databases`)
      ]);
      const servers   = sRes.status  === 'fulfilled' ? (sRes.value.servers   || []) : [];
      const databases = dRes.status  === 'fulfilled' ? (dRes.value.databases || []) : [];

      setCache(provider, group, servers, databases);
      currentData = { servers, databases };
      renderPage(provider, group, Date.now(), false);
    } catch (err) {
      document.getElementById('subnet-meta').textContent = `Error: ${err.message}`;
    }
  }

  function renderPage(provider, group, fetchedAt, isStale) {
    const meta = `${currentData.servers.length} server${currentData.servers.length !== 1 ? 's' : ''} · ${currentData.databases.length} database${currentData.databases.length !== 1 ? 's' : ''} · fetched ${new Date(fetchedAt).toLocaleTimeString()}`;
    document.getElementById('subnet-meta').textContent = meta;

    // Tab counts
    document.getElementById('servers-tab-count').textContent  = currentData.servers.length;
    document.getElementById('databases-tab-count').textContent = currentData.databases.length;

    if (isStale) {
      document.getElementById('stale-banner').classList.remove('hidden');
    }

    const winrmTh = document.querySelector('#servers-table thead th:nth-child(3)');
    const rdpTh   = document.querySelector('#servers-table thead th:nth-child(4)');
    if (winrmTh) winrmTh.textContent = currentOs === 'linux' ? 'SSH' : 'WinRM';
    if (rdpTh)   rdpTh.textContent   = provider === 'pos' ? 'Process' : (currentOs === 'linux' ? '—' : 'RDP');

    renderServers();
    renderDatabases();
  }

  // ── Stale check ───────────────────────────────────────────────────────────
  function checkStale(provider, group) {
    const key = cacheKey(provider, group);
    const entry = App.state.cache.subnets.get(key);
    if (entry && Date.now() - entry.fetchedAt > 15 * 60 * 1000) {
      document.getElementById('stale-banner').classList.remove('hidden');
    }
  }

  // ── Render servers table ──────────────────────────────────────────────────
  function metricVal(v) { return v != null ? `${v}%` : '—'; }
  function metricClass(v, warnAt, critAt) {
    if (v == null) return '';
    if (v >= critAt) return 'val-critical';
    if (v >= warnAt) return 'val-warn';
    return '';
  }

  function renderServers() {
    let rows = [...currentData.servers];

    // Filter by OS when navigating from an OS tab
    if      (currentOs === 'linux')   rows = rows.filter(s => (s.os || 'windows') === 'linux');
    else if (currentOs === 'windows') rows = rows.filter(s => (s.os || 'windows') === 'windows');

    // Filter
    if (currentFilter !== 'all') {
      rows = rows.filter(s => {
        if (currentFilter === 'error') return s.status === 'error' || s.upDown === 'down';
        return s.status === currentFilter;
      });
    }

    // Search
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      rows = rows.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.host || '').toLowerCase().includes(q)
      );
    }

    // Sort
    rows.sort((a, b) => {
      let va, vb;
      if (currentSort.field === 'name')   { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); }
      if (currentSort.field === 'cpu')    { va = a.metrics?.cpu    ?? -1; vb = b.metrics?.cpu    ?? -1; }
      if (currentSort.field === 'mem')    { va = a.metrics?.memUsedPct ?? -1; vb = b.metrics?.memUsedPct ?? -1; }
      if (currentSort.field === 'disk')   { va = maxDisk(a); vb = maxDisk(b); }
      if (currentSort.field === 'uptime') { va = a.uptimeDays ?? -1; vb = b.uptimeDays ?? -1; }
      // Status / WinRM / RDP: problems rank highest, so the first click (descending) puts them on top.
      if (currentSort.field === 'status') { const r = { critical: 6, error: 5, warning: 4, healthy: 3, stopped: 2, 'powered-off': 1 }; va = r[a.status] ?? 0; vb = r[b.status] ?? 0; }
      if (currentSort.field === 'winrm')  { const r = x => x.status === 'powered-off' ? 1 : x.winrm === 'up' ? 2 : 3; va = r(a); vb = r(b); }
      if (currentSort.field === 'rdp')    { const r = x => (x.os || 'windows') === 'linux' ? 0 : x.status === 'powered-off' ? 1 : x.rdp === 'up' ? 2 : 3; va = r(a); vb = r(b); }
      if (va == null) va = vb == null ? 0 : -1;
      return va < vb ? -currentSort.dir : va > vb ? currentSort.dir : 0;
    });

    // show which column is sorted, and which way
    document.querySelectorAll('#servers-table th[data-sort]').forEach(th => {
      const icon = th.querySelector('.sort-icon'), on = th.dataset.sort === currentSort.field;
      if (icon) icon.textContent = on ? (currentSort.dir > 0 ? '▲' : '▼') : '⇕';
      th.classList.toggle('sorted-active', on);
    });

    const tbody = document.getElementById('servers-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#8C8279">No servers match the current filter.</td></tr>';
      return;
    }

    const isPos = currentProvider === 'pos';
    tbody.innerHTML = rows.map(s => {
      const cpu    = s.metrics?.cpu;
      const mem    = s.metrics?.memUsedPct;
      const uptime = s.uptimeDays != null ? `${s.uptimeDays}d` : '—';
      const isPoweredOff  = s.status === 'powered-off';
      const isLinuxServer = (s.os || 'windows') === 'linux';
      const winrmBadge    = s.winrm === 'up' ? 'badge-up' : (isPoweredOff ? 'badge-off' : 'badge-down');
      const winrmText     = s.winrm === 'up' ? 'UP' : (isPoweredOff ? 'OFF' : 'DOWN');
      const col4   = isPos
        ? `<td><span class="${s.processRunning ? 'badge-up' : 'badge-down'}">${s.processRunning ? 'RUNNING' : 'STOPPED'}</span></td>`
        : isLinuxServer
          ? `<td style="color:#9C8B7A;text-align:center">—</td>`
          : isPoweredOff
            ? `<td><span class="badge-off">OFF</span></td>`
            : `<td><span class="${s.rdp === 'up' ? 'badge-up' : 'badge-down'}">${s.rdp === 'up' ? 'UP' : 'DOWN'}</span></td>`;
      const sqlTag = Array.isArray(s.services) && s.services.length > 0
        ? `<span style="display:inline-block;margin-left:6px;padding:1px 5px;font-size:9px;font-weight:700;border-radius:3px;background:#1565c0;color:#fff;vertical-align:middle">SQL</span>`
        : '';
      return `
        <tr data-server-id="${App.esc(s.id)}">
          <td><strong>${App.esc(s.name || s.id)}</strong>${sqlTag}<br><span style="font-size:10px;color:#9C8B7A">${App.esc(s.host || '')}</span></td>
          <td><span class="status-pill ${App.esc(s.status || 'unknown')}">${App.esc(s.status || 'unknown')}</span></td>
          <td><span class="${winrmBadge}">${winrmText}</span></td>
          ${col4}
          <td class="${metricClass(cpu,  85, 90)}">${metricVal(cpu)}</td>
          <td class="${metricClass(mem,  90, 95)}">${metricVal(mem)}</td>
          ${renderDiskCell(s)}
          <td>${App.esc(uptime)}</td>
        </tr>`;
    }).join('');
  }

  function maxDisk(s) {
    if (!s.disks?.length) return s.metrics?.diskMaxPct ?? null;
    return Math.max(...s.disks.map(d => d.usedPct || 0));
  }

  function renderDiskCell(s) {
    if (!s.disks?.length) {
      const pct = s.metrics?.diskMaxPct ?? null;
      return `<td class="${metricClass(pct, 90, 95)}">${metricVal(pct)}</td>`;
    }
    const lines = s.disks.map(d => {
      const usedGB = Math.round((d.sizeGB - d.freeGB) * 10) / 10;
      const cls = metricClass(d.usedPct, 90, 95);
      return `<div class="${cls}" style="white-space:nowrap;line-height:1.6">` +
        `<strong>${App.esc(d.drive)}</strong> ${d.usedPct}%` +
        `<span style="font-size:10px;color:#9C8B7A;margin-left:4px">${usedGB}/${d.sizeGB}GB</span>` +
        `</div>`;
    }).join('');
    return `<td>${lines}</td>`;
  }

  // ── Render databases table ────────────────────────────────────────────────
  function renderDatabases() {
    const tbody = document.getElementById('databases-tbody');
    const dbs   = currentData.databases;
    if (!dbs.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#8C8279">No databases in this group.</td></tr>';
      return;
    }
    tbody.innerHTML = dbs.map(db => `
      <tr data-db-id="${App.esc(db.id)}">
        <td><strong>${App.esc(db.name || db.id)}</strong></td>
        <td><span class="status-pill ${App.esc(db.status || 'unknown')}">${App.esc(db.upDown === 'up' ? 'Up' : 'Down')}</span></td>
        <td style="font-family:monospace;font-size:11px">${App.esc(db.host || '')}</td>
        <td>${App.esc((db.type || '').toUpperCase())}</td>
      </tr>`).join('');
  }

  // ── Wire events ───────────────────────────────────────────────────────────
  function resetTabs() {
    document.querySelectorAll('.subnet-tabs .stab').forEach(t => t.classList.remove('active'));
    document.querySelector('.subnet-tabs .stab[data-stab="servers"]').classList.add('active');
    document.getElementById('subnet-servers-panel').classList.remove('hidden');
    document.getElementById('subnet-databases-panel').classList.add('hidden');
    currentFilter = 'all';
    currentSearch = '';
    document.getElementById('server-search').value = '';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
  }

  // Tab switch
  document.querySelector('.subnet-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.stab');
    if (!tab) return;
    document.querySelectorAll('.subnet-tabs .stab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (tab.dataset.stab === 'servers') {
      document.getElementById('subnet-servers-panel').classList.remove('hidden');
      document.getElementById('subnet-databases-panel').classList.add('hidden');
    } else {
      document.getElementById('subnet-servers-panel').classList.add('hidden');
      document.getElementById('subnet-databases-panel').classList.remove('hidden');
    }
  });

  // Filter buttons
  document.querySelector('.filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderServers();
  });

  // Sort columns
  document.getElementById('servers-table').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const field = th.dataset.sort;
    if (currentSort.field === field) currentSort.dir *= -1;
    else currentSort = { field, dir: field === 'name' ? 1 : -1 }; // names A→Z first; metrics and problems, highest first
    renderServers();
  });

  // Row click → server detail
  document.getElementById('servers-tbody').addEventListener('click', e => {
    const row = e.target.closest('tr[data-server-id]');
    if (!row) return;
    App.navigateTo('detail', { serverId: row.dataset.serverId });
  });

  // Search
  document.getElementById('server-search').addEventListener('input', e => {
    currentSearch = e.target.value.trim();
    renderServers();
  });

  // Subnet hard refresh — clears server-side cache for this group then reloads.
  async function hardRefresh() {
    const { provider, group } = App.state.nav;
    const btn = document.getElementById('subnet-refresh-btn');
    const meta = document.getElementById('subnet-meta');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    if (meta) meta.textContent = 'Refreshing servers… please wait';

    try {
      await App.api(`/api/v2/subnet/${provider}/${encodeURIComponent(group)}/refresh`, { method: 'POST' });
    } catch { /* ignore — fall through to reload */ }

    App.state.cache.subnets.delete(cacheKey(provider, group));
    await load(provider, group);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }

  document.getElementById('subnet-refresh-btn').addEventListener('click', hardRefresh);
  document.getElementById('stale-refresh-btn').addEventListener('click', hardRefresh);

  return { load };
})();
