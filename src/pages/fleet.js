'use strict';

const FleetPage = (() => {
  const PROVIDERS = ['vmc', 'azure', 'onprem', 'aws', 'oci'];
  const PROVIDER_LABELS = { vmc: 'VMC', aws: 'AWS', azure: 'Azure', oci: 'OCI', onprem: 'On-Prem vCenter' };
  const POS_PROVIDER = 'pos';
  const FLEET_REFRESH_MS = 3 * 60 * 1000;  // 3 minutes — matches cache TTL
  let _posRefreshTimer   = null;
  let _fleetRefreshTimer = null;
  const _osTab     = new Map();  // provider → 'windows' | 'linux' (active tab)
  const _acctFilter = new Map(); // provider → active account name or 'all'

  function envTagClass(env) {
    const map = { Prod: 'env-prod', Test: 'env-test', Dev: 'env-dev', UAT: 'env-uat', Infra: 'env-infra', AWS: 'env-prod', Azure: 'env-prod', OCI: 'env-prod', 'Non-Prod': 'env-dev' };
    return map[env] || 'env-infra';
  }

  function providerBadgeClass(p) {
    return `badge-${p.toLowerCase()}`;
  }

  function acctLabel(name) {
    if (!name) return '';
    const abbrevs = new Set(['uat', 'dr', 'aws', 'vpn', 'rdp', 'sql', 'rds']);
    return name.replace(/^aws-/i, '').split('-').map(w =>
      abbrevs.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  function acctStyle(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('prod'))                          return 'background:#E8F2F8;color:#1A4D6B';
    if (n.includes('uat') || n.includes('non') || n.includes('test')) return 'background:#EEF3E5;color:#4A5A2E';
    if (n.includes('share') || n.includes('service')) return 'background:#F3E5EF;color:#5A2E4A';
    return 'background:#F5F0E0;color:#5A4A1A';
  }

  function statusColour(counts) {
    if (counts.down > 0 || counts.critical > 0) return '#b71c1c';
    if (counts.warning > 0 || counts.rdpDown > 0) return '#c4853a';
    if (counts.stopped > 0 && counts.up === 0) return '#888';
    return '#5a8a5a';
  }

  // Render the group rows for one OS tab (or the untabbed default view)
  function renderGroupRows(provider, groups, os) {
    if (!groups.length) return `<div class="fleet-loading">No servers</div>`;
    return groups.map(g => {
      const col = statusColour(g.counts);
      const counts = g.counts;
      const bits = [];
      if (counts.healthy  > 0) bits.push(`<span class="count-up">&#10003; ${counts.healthy} healthy</span>`);
      if (counts.warning  > 0) bits.push(`<span class="count-rdp">&#9888; ${counts.warning} warning</span>`);
      if (counts.critical > 0) bits.push(`<span class="count-down">&#9888; ${counts.critical} critical</span>`);
      if (counts.down     > 0) bits.push(`<span class="count-down">&#10007; ${counts.down} error</span>`);
      if (os === 'linux') {
        if (counts.sshDown > 0) bits.push(`<span class="count-down">&#8681; ${counts.sshDown} SSH down</span>`);
      } else {
        if (counts.bothDown  > 0) bits.push(`<span class="count-down">&#8681; ${counts.bothDown} both down</span>`);
        if (counts.winrmDown > 0) bits.push(`<span class="count-down">&#8681; ${counts.winrmDown} WinRM down</span>`);
        if (counts.rdpDown   > 0) bits.push(`<span class="count-rdp">&#128187; ${counts.rdpDown} RDP down</span>`);
        if (counts.stopped    > 0) bits.push(`<span class="count-stopped">&#9646; ${counts.stopped} stopped</span>`);
        if (counts.poweredOff > 0) bits.push(`<span class="count-off">&#9900; ${counts.poweredOff} powered off</span>`);
      }
      bits.push(`<span class="count-total">${counts.total} total</span>`);
      const acctBadge = provider === 'aws' && g.account
        ? `<span class="acct-badge" style="${acctStyle(g.account)}">${App.esc(acctLabel(g.account))}</span>`
        : '';
      return `
        <div class="subnet-row" data-provider="${App.esc(provider)}" data-group="${App.esc(g.group)}" data-os="${App.esc(os || '')}" data-account="${App.esc(g.account || '')}">
          <div class="subnet-row-left">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0"></span>
            <span class="subnet-env-tag ${envTagClass(g.env)}">${App.esc(g.env)}</span>
            <span class="subnet-name">${App.esc(g.group)}</span>
            ${acctBadge}
          </div>
          <div class="subnet-counts">${bits.join('')}</div>
        </div>`;
    }).join('');
  }

  function renderProviderBlock(provider, data, isLoading, error) {
    const label         = PROVIDER_LABELS[provider] || provider.toUpperCase();
    const groups        = data?.groups        || [];
    const winGroups     = data?.windowsGroups || [];
    const linGroups     = data?.linuxGroups   || [];
    const hasLinux      = linGroups.length > 0;
    const activeTab     = _osTab.get(provider) || 'windows';

    const totalUp         = groups.reduce((s, g) => s + g.counts.up, 0);
    const total           = groups.reduce((s, g) => s + g.counts.total, 0);
    const totalPoweredOff = groups.reduce((s, g) => s + (g.counts.poweredOff || 0), 0);
    const totalHealthy    = groups.reduce((s, g) => s + (g.counts.healthy  || 0), 0);
    const totalWarning    = groups.reduce((s, g) => s + (g.counts.warning  || 0), 0);
    const totalCritical   = groups.reduce((s, g) => s + (g.counts.critical || 0), 0);
    // RDP/WinRM counts are Windows-only — mixed `groups` would count Linux hosts as RDP down
    const rdpGroups       = data?.windowsGroups ? winGroups : groups;
    const totalRdpDown    = rdpGroups.reduce((s, g) => s + (g.counts.rdpDown   || 0), 0);
    const totalBothDown   = rdpGroups.reduce((s, g) => s + (g.counts.bothDown  || 0), 0);
    const totalWinrmDown  = rdpGroups.reduce((s, g) => s + (g.counts.winrmDown || 0), 0);
    const totalStopped    = groups.reduce((s, g) => s + (g.counts.stopped   || 0), 0);
    const fetchedAt       = data?.timestamp ? `Fetched ${new Date(data.timestamp).toLocaleTimeString()}` : '';

    const summaryText = isLoading ? 'Loading…' : error ? 'Error'
      : `${totalUp} up${totalBothDown > 0 ? ` · ${totalBothDown} both down` : ''}${totalWinrmDown > 0 ? ` · ${totalWinrmDown} WinRM down` : ''}${totalRdpDown > 0 ? ` · ${totalRdpDown} RDP down` : ''}${totalCritical > 0 ? ` · ${totalCritical} critical` : ''}${totalWarning > 0 ? ` · ${totalWarning} warning` : ''}${totalStopped > 0 ? ` · ${totalStopped} stopped` : ''}${totalPoweredOff > 0 ? ` · ${totalPoweredOff} powered off` : ''} of ${total}`;

    // Account filter bar — AWS only, when servers have account names
    const uniqueAccounts = provider === 'aws'
      ? [...new Set(groups.map(g => g.account).filter(Boolean))]
      : [];
    const activeAcct = _acctFilter.get(provider) || 'all';
    const acctFilterBar = uniqueAccounts.length > 0 ? `
      <div class="acct-filter-bar">
        <span class="acct-filter-label">Account</span>
        <button class="acct-filter-btn${activeAcct === 'all' ? ' active' : ''}" data-provider="${App.esc(provider)}" data-account="all">ALL</button>
        ${uniqueAccounts.map(a => `<button class="acct-filter-btn${activeAcct === a ? ' active' : ''}" data-provider="${App.esc(provider)}" data-account="${App.esc(a)}" style="${activeAcct === a ? '' : acctStyle(a)}">${App.esc(acctLabel(a))}</button>`).join('')}
      </div>` : '';

    let rowsHtml = '';
    if (isLoading) {
      rowsHtml = `<div class="fleet-loading"><div class="spinner"></div> Loading ${label} fleet…</div>`;
    } else if (error) {
      rowsHtml = `<div class="fleet-loading" style="color:#b71c1c">&#9888; ${App.esc(error)}</div>`;
    } else if (!groups.length) {
      rowsHtml = `<div class="fleet-loading">No servers found</div>`;
    } else if (hasLinux) {
      // OS tabs view
      const winUp  = winGroups.reduce((s, g) => s + g.counts.up, 0);
      const winTot = winGroups.reduce((s, g) => s + g.counts.total, 0);
      const linUp  = linGroups.reduce((s, g) => s + g.counts.up, 0);
      const linTot = linGroups.reduce((s, g) => s + g.counts.total, 0);

      const tabBar = `<div class="os-tab-bar">
        <button class="os-tab${activeTab === 'windows' ? ' active' : ''}" data-provider="${App.esc(provider)}" data-os="windows">
          &#10064; Windows <span class="os-tab-count">${winUp}/${winTot}</span>
        </button>
        <button class="os-tab${activeTab === 'linux' ? ' active' : ''}" data-provider="${App.esc(provider)}" data-os="linux">
          &#9670; Linux <span class="os-tab-count">${linUp}/${linTot}</span>
        </button>
      </div>`;

      rowsHtml = `${acctFilterBar}${tabBar}
        <div class="os-tab-content${activeTab !== 'windows' ? ' os-tab-hidden' : ''}" data-os-content="windows">
          ${renderGroupRows(provider, winGroups, 'windows')}
        </div>
        <div class="os-tab-content${activeTab !== 'linux' ? ' os-tab-hidden' : ''}" data-os-content="linux">
          ${renderGroupRows(provider, linGroups, 'linux')}
        </div>`;
    } else {
      // Original view — no Linux servers, no tabs needed
      rowsHtml = acctFilterBar + renderGroupRows(provider, groups, 'windows');
    }

    return `
      <div class="hyperscaler-group collapsed" data-provider="${App.esc(provider)}" id="hg-${provider}">
        <div class="hyperscaler-header" data-collapse="${App.esc(provider)}">
          <div class="hyperscaler-name">
            <span class="hyperscaler-badge ${providerBadgeClass(provider)}">${label}</span>
            ${label} Fleet
          </div>
          <div style="display:flex;align-items:center;gap:16px">
            <span class="hyperscaler-summary">${App.esc(summaryText)}</span>
            ${fetchedAt ? `<span class="subnet-fetched" id="fetched-${App.esc(provider)}">${App.esc(fetchedAt)}</span>` : ''}
            <button class="fleet-refresh-btn" data-provider="${App.esc(provider)}" title="Hard refresh — re-check all servers now" onclick="event.stopPropagation()" style="background:none;border:1px solid #8C8279;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:13px;color:#8C8279;line-height:1">↺</button>
            <span class="hyperscaler-chevron">&#9660;</span>
          </div>
        </div>
        <div class="hyperscaler-rows">${rowsHtml}</div>
      </div>`;
  }

  // ── POS Fleet rendering ───────────────────────────────────────────────────────
  function renderPosBlock(data, isLoading, error) {
    const groups     = data?.groups || [];
    const total      = groups.reduce((s, g) => s + g.counts.total, 0);
    const totalRun   = groups.reduce((s, g) => s + (g.counts.processRunning || 0), 0);
    const totalStop  = groups.reduce((s, g) => s + (g.counts.processStopped || 0), 0);
    const totalDown  = groups.reduce((s, g) => s + (g.counts.machineDown   || g.counts.down || 0), 0);
    const fetchedAt  = data?.timestamp ? `Fetched ${new Date(data.timestamp).toLocaleTimeString()}` : '';

    let rowsHtml = '';
    if (isLoading) {
      rowsHtml = `<div class="fleet-loading"><div class="spinner"></div> Loading POS fleet…</div>`;
    } else if (error) {
      rowsHtml = `<div class="fleet-loading" style="color:#b71c1c">&#9888; ${App.esc(error)}</div>`;
    } else if (!groups.length) {
      rowsHtml = `<div class="fleet-loading">No POS machines configured</div>`;
    } else {
      rowsHtml = groups.map(g => {
        const run  = g.counts.processRunning || 0;
        const stop = g.counts.processStopped || 0;
        const down = g.counts.machineDown    || g.counts.down || 0;
        const col  = (stop > 0 || down > 0) ? '#b71c1c' : '#5a8a5a';
        return `
          <div class="subnet-row" data-provider="pos" data-group="${App.esc(g.group)}">
            <div class="subnet-row-left">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0"></span>
              <span class="subnet-env-tag env-pos">${App.esc(g.group)}</span>
            </div>
            <div class="subnet-counts">
              ${run  > 0 ? `<span class="count-up">&#10003; ${run} process running</span>`  : ''}
              ${stop > 0 ? `<span class="count-down">&#9888; ${stop} process stopped</span>` : ''}
              ${down > 0 ? `<span class="count-down">&#8681; ${down} machine down</span>`    : ''}
              <span class="count-total">${g.counts.total} total</span>
            </div>
          </div>`;
      }).join('');
    }

    const summaryText = isLoading ? 'Loading…' : error ? 'Error'
      : `${totalRun} process running${totalStop > 0 ? ` · ${totalStop} process stopped` : ''}${totalDown > 0 ? ` · ${totalDown} machine down` : ''} of ${total}`;

    return `
      <div class="hyperscaler-group collapsed" data-provider="pos" id="hg-pos">
        <div class="hyperscaler-header" data-collapse="pos">
          <div class="hyperscaler-name">
            <span class="hyperscaler-badge badge-pos">POS</span>
            POS Machines Fleet
          </div>
          <div style="display:flex;align-items:center;gap:16px">
            <span class="hyperscaler-summary">${App.esc(summaryText)}</span>
            ${fetchedAt ? `<span class="subnet-fetched">${App.esc(fetchedAt)}</span>` : ''}
            <span class="hyperscaler-chevron">&#9660;</span>
          </div>
        </div>
        <div class="hyperscaler-rows">${rowsHtml}</div>
      </div>`;
  }

  function updatePosBlock(data, isLoading, error) {
    const existing = document.getElementById('hg-pos');
    if (!existing) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderPosBlock(data, isLoading, error);
    const newBlock = tmp.firstElementChild;
    if (existing.classList.contains('collapsed')) newBlock.classList.add('collapsed');
    existing.replaceWith(newBlock);
  }

  async function loadPosHealth(fleetData) {
    try {
      const health = await App.api('/api/v2/fleet/pos/health');
      const healthMap = new Map(health.healthCounts.map(h => [h.group, h]));
      const merged = {
        ...fleetData,
        groups: fleetData.groups.map(g => {
          const h = healthMap.get(g.group);
          if (!h) return g;
          return { ...g, counts: { ...g.counts, processRunning: h.processRunning, processStopped: h.processStopped, machineDown: h.machineDown } };
        })
      };
      App.state.cache.fleet.set(POS_PROVIDER, { data: merged, fetchedAt: Date.now() });
      updatePosBlock(merged, false, null);
    } catch { /* keep showing probe-only counts */ }
  }

  // ── Fleet hard-refresh ────────────────────────────────────────────────────────
  async function triggerFleetRefresh(provider) {
    const btn      = document.querySelector(`.fleet-refresh-btn[data-provider="${provider}"]`);
    const fetchedEl = document.getElementById(`fetched-${provider}`);
    if (!btn || btn.disabled) return;

    btn.disabled    = true;
    btn.textContent = '⟳';
    btn.title       = 'Refreshing… please wait';
    if (fetchedEl) fetchedEl.textContent = 'Refreshing…';

    try { await App.api(`/api/v2/fleet/${provider}/refresh`, { method: 'POST' }); }
    catch { /* ignore — cycle will run regardless */ }

    // Poll every 15 s (up to 10 times = 150 s) for updated health counts.
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const cached = App.state.cache.fleet.get(provider);
        if (cached?.data) await loadHealth(provider, cached.data);
      } catch { /* ignore */ }

      if (attempts >= 10) {
        clearInterval(poll);
        if (btn) { btn.disabled = false; btn.textContent = '↺'; btn.title = 'Hard refresh — re-check all servers now'; }
        if (fetchedEl) fetchedEl.textContent = `Fetched ${new Date().toLocaleTimeString()}`;
      }
    }, 15_000);
  }

  // ── Single delegated handler — added once, no accumulation ───────────────────
  document.getElementById('fleet-grid').addEventListener('click', e => {
    // Fleet hard-refresh button
    const refreshBtn = e.target.closest('.fleet-refresh-btn');
    if (refreshBtn) {
      e.stopPropagation();
      triggerFleetRefresh(refreshBtn.dataset.provider);
      return;
    }

    // Account filter button
    const acctBtn = e.target.closest('.acct-filter-btn');
    if (acctBtn) {
      e.stopPropagation();
      const provider = acctBtn.dataset.provider;
      const account  = acctBtn.dataset.account;
      _acctFilter.set(provider, account);
      const block = document.getElementById(`hg-${provider}`);
      if (!block) return;
      block.querySelectorAll('.acct-filter-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.account === account)
      );
      block.querySelectorAll('.subnet-row[data-account]').forEach(row => {
        row.classList.toggle('acct-hidden', account !== 'all' && row.dataset.account !== account);
      });
      return;
    }

    // OS tab switch (Windows / Linux)
    const osTab = e.target.closest('.os-tab');
    if (osTab) {
      e.stopPropagation();
      const provider = osTab.dataset.provider;
      const os       = osTab.dataset.os;
      _osTab.set(provider, os);
      const block = document.getElementById(`hg-${provider}`);
      if (!block) return;
      block.querySelectorAll('.os-tab').forEach(t => t.classList.toggle('active', t.dataset.os === os));
      block.querySelectorAll('.os-tab-content').forEach(c => c.classList.toggle('os-tab-hidden', c.dataset.osContent !== os));
      return;
    }

    const header = e.target.closest('[data-collapse]');
    if (header) {
      const group = header.closest('.hyperscaler-group');
      if (group) group.classList.toggle('collapsed');
      return;
    }
    const row = e.target.closest('.subnet-row');
    if (!row) return;
    const provider = row.dataset.provider;
    const group    = row.dataset.group;
    const os       = row.dataset.os || null;
    if (provider && group) {
      // Always force a fresh fetch when navigating from the fleet so the
      // subnet counts match exactly what the fleet summary just showed.
      App.state.cache.subnets.delete(`${provider}:${group}`);
      App.navigateTo('subnet', { provider, group, os });
    }
  });

  // ── Data loading ──────────────────────────────────────────────────────────────
  async function loadProvider(provider) {
    const cached = App.state.cache.fleet.get(provider);
    if (cached) return cached.data;
    const data = await App.api(`/api/v2/fleet/${provider}`);
    App.state.cache.fleet.set(provider, { data, fetchedAt: Date.now() });
    return data;
  }

  function updateBlock(provider, data, isLoading, error) {
    const existing = document.getElementById(`hg-${provider}`);
    if (!existing) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderProviderBlock(provider, data, isLoading, error);
    const newBlock = tmp.firstElementChild;
    if (existing.classList.contains('collapsed')) newBlock.classList.add('collapsed');
    existing.replaceWith(newBlock);
  }

  async function loadHealth(provider, fleetData) {
    try {
      const health = await App.api(`/api/v2/fleet/${provider}/health`);

      function mergeGroups(groups, map) {
        return (groups || []).map(g => {
          const h = map.get(g.group);
          if (!h) return g;
          return {
            ...g,
            counts: {
              ...g.counts,
              healthy:    h.healthy,
              warning:    h.warning,
              critical:   h.critical,
              down:       h.error,
              winrmDown:  h.winrmDown,
              bothDown:   h.bothDown,
              rdpDown:    h.rdpDown,
              sshDown:    h.sshDown,
              stopped:    h.stopped    ?? g.counts.stopped    ?? 0,
              poweredOff: h.poweredOff ?? g.counts.poweredOff ?? 0,
            }
          };
        });
      }

      const healthMap    = new Map(health.healthCounts.map(h => [h.group, h]));
      const winMap       = new Map((health.windowsHealthCounts || []).map(h => [h.group, h]));
      const linMap       = new Map((health.linuxHealthCounts   || []).map(h => [h.group, h]));

      const merged = {
        ...fleetData,
        groups:        mergeGroups(fleetData.groups,        healthMap),
        windowsGroups: mergeGroups(fleetData.windowsGroups, winMap),
        linuxGroups:   mergeGroups(fleetData.linuxGroups,   linMap),
      };
      App.state.cache.fleet.set(provider, { data: merged, fetchedAt: Date.now() });
      updateBlock(provider, merged, false, null);
    } catch { /* health data unavailable — keep showing probe-only counts */ }
  }

  async function load() {
    if (_posRefreshTimer)   { clearInterval(_posRefreshTimer);   _posRefreshTimer   = null; }
    if (_fleetRefreshTimer) { clearInterval(_fleetRefreshTimer); _fleetRefreshTimer = null; }
    AiPanels.loadFleet();   // independent of health checks; failures stay inside the panel
    const grid = document.getElementById('fleet-grid');
    grid.innerHTML = PROVIDERS.map(p => renderProviderBlock(p, null, true, null)).join('') +
                     renderPosBlock(null, true, null);

    // Health-check providers staggered to avoid flooding the semaphore simultaneously.
    // VMC (60+ servers) fires first; Azure and OnPrem follow 20s apart so their
    // PowerShell processes don't all queue up at once → fewer intermittent ERRORs.
    const HEALTH_STAGGER_ORDER = ['vmc', 'azure', 'onprem', 'aws', 'oci'];
    const HEALTH_STAGGER_MS    = 20 * 1000;  // 20 s between each fleet

    await Promise.all([
      ...PROVIDERS.map(async provider => {
        try {
          const data = await loadProvider(provider);
          updateBlock(provider, data, false, null);
          const idx = HEALTH_STAGGER_ORDER.indexOf(provider);
          if (idx >= 0) setTimeout(() => loadHealth(provider, data), idx * HEALTH_STAGGER_MS);
        } catch (err) {
          updateBlock(provider, null, false, err.message);
        }
      }),
      (async () => {
        try {
          const data = await App.api('/api/v2/fleet/pos');
          App.state.cache.fleet.set(POS_PROVIDER, { data, fetchedAt: Date.now() });
          updatePosBlock(data, false, null);
          await loadPosHealth(data);
          _posRefreshTimer = setInterval(async () => {
            const cached = App.state.cache.fleet.get(POS_PROVIDER);
            if (cached?.data) await loadPosHealth(cached.data);
          }, 30000);
        } catch (err) {
          updatePosBlock(null, false, err.message);
        }
      })()
    ]);

    // Auto-refresh all fleets every 3 minutes — matches cache TTL so health
    // changes (errors, recoveries) are visible without manual page refresh.
    // Probe calls (TCP) are parallel (fast); health calls (PowerShell) are
    // staggered 20s apart to avoid flooding the semaphore on the jumpbox.
    _fleetRefreshTimer = setInterval(async () => {
      App.state.cache.fleet.clear();
      await Promise.all(PROVIDERS.map(async provider => {
        try {
          const data = await loadProvider(provider);
          updateBlock(provider, data, false, null);
          const idx = HEALTH_STAGGER_ORDER.indexOf(provider);
          if (idx >= 0) setTimeout(() => loadHealth(provider, data), idx * HEALTH_STAGGER_MS);
        } catch (err) {
          updateBlock(provider, null, false, err.message);
        }
      }));
    }, FLEET_REFRESH_MS);
  }

  return { load };
})();
