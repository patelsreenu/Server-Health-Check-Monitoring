'use strict';

const DetailPage = (() => {
  let currentServer = null;
  let selectedScriptId = null;

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load(serverId) {
    currentServer = null;
    selectedScriptId = null;
    App.show('detail-loading');
    App.hide('detail-content');

    const hostWarning = document.getElementById('host-server-warning');
    if (App.state.hostServerId && serverId === App.state.hostServerId) {
      hostWarning.classList.remove('hidden');
    } else {
      hostWarning.classList.add('hidden');
    }

    // Clear action log display
    document.getElementById('action-log').innerHTML = '';

    try {
      const [metricsRes, servicesRes] = await Promise.allSettled([
        App.api(`/api/v2/server/${encodeURIComponent(serverId)}/metrics`),
        App.api(`/api/v2/server/${encodeURIComponent(serverId)}/services`)
      ]);

      const metrics  = metricsRes.status  === 'fulfilled' ? metricsRes.value  : null;
      const services = servicesRes.status === 'fulfilled' ? servicesRes.value : null;

      currentServer = metrics || { id: serverId, name: serverId };
      renderDetail(currentServer, services);

      App.hide('detail-loading');
      App.show('detail-content');
    } catch (err) {
      document.getElementById('detail-loading').innerHTML =
        `<div style="color:#b71c1c">Error loading server data: ${App.esc(err.message)}</div>
         <button class="btn btn-ghost" onclick="DetailPage.load('${App.esc(serverId)}')">Retry</button>`;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderDetail(s, svcData) {
    document.getElementById('detail-server-name').textContent = s.displayName || s.name || s.id;
    const sub = document.getElementById('detail-server-sub');
    const hostText = s.host || s.id;
    sub.innerHTML = App.esc(`${s.provider || 'VMC'} · ${s.os === 'windows' ? 'Windows' : s.os || 'Windows'} · `) +
      `<button type="button" class="ai-host-link" id="detail-host-link" title="${s.os === 'linux' ? 'Copy the ssh command' : 'Open Remote Desktop'}">${App.esc(hostText)}</button>`;
    document.getElementById('detail-host-link').onclick = () => App.connectHost(s.id, s.os === 'linux' ? 'linux' : 'windows', hostText);

    const pill = document.getElementById('detail-status-pill');
    pill.className   = `status-pill ${s.status || 'unknown'}`;
    pill.textContent = s.status || 'unknown';

    renderMetricsRow(s);
    renderInfoRows(s);
    renderDisks(s);
    renderServices(s, svcData);
    AiPanels.loadInsight(s.id);
  }

  function renderMetricsRow(s) {
    const m   = s.metrics || {};
    const row = document.getElementById('detail-metrics-row');

    const cpuClass  = m.cpu        >= 90 ? 'val-critical' : m.cpu        >= 85 ? 'val-warn' : '';
    const memClass  = m.memUsedPct >= 95 ? 'val-critical' : m.memUsedPct >= 90 ? 'val-warn' : '';

    row.innerHTML = `
      <div class="metric-cell"><div class="metric-val ${cpuClass}">${m.cpu != null ? m.cpu + '%' : '—'}</div><div class="metric-lbl">CPU</div></div>
      <div class="metric-cell"><div class="metric-val ${memClass}">${m.memUsedPct != null ? m.memUsedPct + '%' : '—'}</div><div class="metric-lbl">Memory</div></div>
      <div class="metric-cell"><div class="metric-val">${s.uptimeDays != null ? s.uptimeDays + 'd' : '—'}</div><div class="metric-lbl">Uptime</div></div>`;
  }

  function renderInfoRows(s) {
    const m = s.metrics || {};
    const isLinux = (s.os || 'windows') === 'linux';
    const connLabel = isLinux ? 'SSH' : 'RDP';
    const connVal   = isLinux
      ? (s.status && s.status !== 'error' && s.status !== 'unknown' ? 'UP' : (s.status === 'error' ? 'DOWN' : '—'))
      : (s.rdpStatus || '—');
    const connColour = connVal === 'UP' ? '#2d6a35' : (connVal === 'DOWN' ? '#b71c1c' : null);
    const rows = [
      ['IP Address',    s.ipAddress    || s.privateIp || '—'],
      ['Hostname',      s.hostname     || '—'],
      ['OS',            s.osName       || s.os        || '—'],
      [connLabel,       connVal,        connColour],
      ['Memory',        m.memTotalGB ? `${m.memFreeGB} GB free / ${m.memTotalGB} GB total` : '—'],
      ['Provider',      s.provider     || '—'],
      ['Host',          s.host         || '—'],
      ['Instance Type', s.instanceType || s.vmSize    || '—']
    ];

    document.getElementById('detail-info-rows').innerHTML = rows.map(([k, v, col]) => `
      <div class="info-row-item">
        <span class="info-key-d">${App.esc(k)}</span>
        <span class="info-val-d" ${col ? `style="color:${col};font-weight:700"` : ''}>${App.esc(String(v))}</span>
      </div>`).join('');
  }

  function renderDisks(s) {
    const disksEl = document.getElementById('detail-disks');
    const disks   = s.disks || [];
    if (!disks.length) { disksEl.innerHTML = '<p style="font-size:12px;color:#9C8B7A">No disk data available</p>'; return; }

    disksEl.innerHTML = disks.map(d => {
      const cls = d.usedPct >= 95 ? 'crit' : d.usedPct >= 90 ? 'warn' : '';
      const col = d.usedPct >= 95 ? 'val-critical' : d.usedPct >= 90 ? 'val-warn' : '';
      return `
        <div class="disk-row">
          <div class="disk-label">
            <span>${App.esc(d.drive)} &mdash; ${App.esc(String(d.sizeGB))} GB total</span>
            <span class="${col}">${App.esc(String(d.usedPct))}% used &nbsp;(${App.esc(String(d.freeGB))} GB free)</span>
          </div>
          <div class="disk-bar-bg"><div class="disk-bar-fill ${cls}" style="width:${Math.min(d.usedPct,100)}%"></div></div>
        </div>`;
    }).join('');
  }

  let _allServices = [];
  let _criticalServices = [];
  let _svcFilter = 'all';
  let _svcPolicy = null;          // { canRestart, protected[] } for the signed-in person

  const svcActionsOn = () => !!(_svcPolicy?.canRestart && currentServer && (currentServer.os || 'windows') !== 'linux');

  function renderServicesRows() {
    const tbody = document.getElementById('detail-services-tbody');
    const filtered = _svcFilter === 'running' ? _allServices.filter(s => s.status === 'Running')
                   : _svcFilter === 'stopped'  ? _allServices.filter(s => s.status !== 'Running')
                   : _allServices;
    tbody.innerHTML = filtered.map(svc => {
      const running   = svc.status === 'Running';
      const critical  = _criticalServices.includes(svc.name);
      const dotClass  = running ? 'running' : 'stopped';
      const statusCol = running ? '#2d6a35' : '#b71c1c';
      const lastStart = svc.lastStart ? new Date(svc.lastStart).toLocaleString() : '—';
      const isProtected = (_svcPolicy?.protected || []).includes(String(svc.name).toLowerCase());
      const actCell = !svcActionsOn() ? ''
        : isProtected ? `<td><span style="font-size:11px;color:#8C8279" title="Protected: restarting it could cut the dashboard off from this server">Protected</span></td>`
        : `<td><button class="btn btn-ghost btn-xs" data-svc-restart="${App.esc(svc.name)}">${running ? 'Restart' : 'Start'}</button></td>`;
      return `
        <tr>
          <td><span class="service-dot ${dotClass}"></span>${App.esc(svc.display || svc.name)}${critical ? ' <span style="font-size:10px;color:#b71c1c">★</span>' : ''}</td>
          <td style="color:${statusCol};font-weight:700">${App.esc(svc.status)}</td>
          <td style="font-size:11px;color:#8C8279">${App.esc(lastStart)}</td>
          ${actCell}
        </tr>`;
    }).join('');
  }

  document.getElementById('svc-filter-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    _svcFilter = btn.dataset.filter;
    document.querySelectorAll('.svc-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderServicesRows();
  });

  function renderServices(s, svcData) {
    const section = document.getElementById('detail-services-section');
    const services = svcData?.services || [];

    if (!services.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    _allServices      = services;
    _criticalServices = svcData?.criticalServices || s.criticalServices || [];
    _svcFilter        = 'all';

    document.querySelectorAll('.svc-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    document.getElementById('svc-count-running').textContent = services.filter(sv => sv.status === 'Running').length;
    document.getElementById('svc-count-stopped').textContent = services.filter(sv => sv.status !== 'Running').length;

    if (!_svcPolicy) {
      App.api('/api/v2/actions/service-policy')
        .then(p => { _svcPolicy = p; applySvcActionColumn(); renderServicesRows(); })
        .catch(() => { _svcPolicy = { canRestart: false, protected: [] }; });
    }
    applySvcActionColumn();
    renderServicesRows();
  }

  function applySvcActionColumn() {
    document.querySelectorAll('.svc-act-col').forEach(th => th.classList.toggle('hidden', !svcActionsOn()));
  }

  // ── Service restart: warning → admin credentials + reason → type the name → restart ──
  document.getElementById('detail-services-tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-svc-restart]');
    if (btn) restartService(btn.dataset.svcRestart, btn);
  });

  async function restartService(name, btn) {
    const server = currentServer;
    const svc = _allServices.find(x => x.name === name);
    if (!server || !svc) return;
    const serverName = server.hostname || server.name || server.id;
    const verb = svc.status === 'Running' ? 'restart' : 'start';

    try { await App.showServiceWarning({ serverName, display: svc.display, name, status: svc.status, critical: _criticalServices.includes(name) }); }
    catch { return; }

    let verified;
    try { verified = await App.showAdminModal(`${verb} service ${name}`, server.name || server.id, App.state.nav.group || '', server.id, { ticket: false }); }
    catch { return; }

    let typed;
    try { typed = await App.showTypedConfirm({ serverName, name, verb }); }
    catch { App.addActionLog(`Service ${verb} of ${name} cancelled at final confirmation`); return; }

    btn.disabled = true; btn.textContent = 'Working…';
    App.addActionLog(`Service ${verb}: ${name} requested by ${App.state.session?.accountName || 'admin'} (as ${verified.username})`);
    try {
      const r = await App.api(`/api/v2/actions/${encodeURIComponent(server.id)}/services/restart`, {
        method: 'POST',
        body: { service: name, confirm: typed, username: verified.username, password: verified.password, reason: verified.ticketDesc }
      });
      const deps = r.dependents?.length ? ` (dependants: ${r.dependents.join(', ')})` : '';
      if (r.success) {
        App.toast(`${name} is running again on ${serverName}${deps}`, 'success', null, 6000);
        App.addActionLog(`Service ${name}: ${r.before} → ${r.after}${deps}`);
      } else {
        App.toast(`${name} was restarted but is ${r.after}${r.timedOut ? ' after 60 seconds' : ''}. Check the server.`, 'warning', null, 9000);
        App.addActionLog(`Service ${name}: ${r.before} → ${r.after}${r.timedOut ? ' (timed out)' : ''}`, 'error');
      }
    } catch (err) {
      App.toast(`Service ${verb} failed: ${err.message}`, 'error', null, 9000);
      App.addActionLog(`Service ${verb} of ${name} failed: ${err.message}`, 'error');
    }
    try {
      const fresh = await App.api(`/api/v2/server/${encodeURIComponent(server.id)}/services`);
      renderServices(server, fresh);
    } catch { renderServicesRows(); }
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  document.querySelector('.action-btns').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (!currentServer) return;

    if (action === 'logs') { openLogs(); return; }
    if (action === 'script') { openScript(); return; }

    // Destructive actions — may need host warning first
    const isHostServer = App.state.hostServerId && currentServer.id === App.state.hostServerId;
    if (action === 'stop' && isHostServer) {
      try { await App.showHostWarning(); }
      catch { return; }
    }

    await executeAction(action);
  });

  async function executeAction(action) {
    const server = currentServer;
    const group  = App.state.nav.group || '';
    const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);

    // Step 1 — confirmation warning
    try { await App.showActionConfirm(action, server.hostname || server.name || server.id); }
    catch { return; }

    // Step 2 — admin password
    let verified;
    try {
      verified = await App.showAdminModal(actionLabel, server.name || server.id, group, server.id);
    } catch { return; }

    // Create ServiceNow ticket first
    let ticket = null;
    try {
      const ticketRes = await App.api('/api/v2/tickets', {
        method: 'POST',
        body: {
          ticketType:   verified.ticketType,
          shortDescription: `${actionLabel} on ${server.name}`,
          description:  verified.ticketDesc,
          serverName:   server.name,
          hyperscaler:  server.provider || 'VMC',
          subnet:       group,
          actionType:   action
        }
      });
      if (ticketRes.ticket) {
        ticket = ticketRes.ticket;
        App.toast(`Ticket ${ticket.number} created`, 'success', { label: `View ${ticket.number}`, url: ticket.url });
      } else if (ticketRes.skipped) {
        App.toast('ServiceNow not configured — proceeding without ticket', 'warning');
      }
    } catch (err) {
      App.toast(`Ticket creation failed — action aborted: ${err.message}`, 'error');
      return;
    }

    // Execute action
    App.addActionLog(`${actionLabel} initiated by ${App.state.session?.accountName || 'admin'}`);
    try {
      await App.api(`/api/v2/actions/${encodeURIComponent(server.id)}/${action}`, {
        method: 'POST',
        body: {
          ticketType: verified.ticketType,
          ticketSysId: ticket?.sysId
        }
      });
      App.toast(`${actionLabel} command sent for ${server.name}`, 'success');
      App.addActionLog(`${actionLabel} completed successfully`);

      if (action === 'restart') {
        setTimeout(() => DetailPage.load(server.id), 5000);
      }
    } catch (err) {
      App.toast(`${actionLabel} failed: ${err.message}`, 'error');
      App.addActionLog(`${actionLabel} failed: ${err.message}`, 'error');
    }
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  async function openLogs() {
    if (!currentServer) return;
    document.getElementById('logs-title').textContent = `Event Logs — ${currentServer.name || currentServer.id}`;
    document.getElementById('log-content').textContent = 'Loading…';
    App.openModal('logs-modal');
    await fetchLogs();

    document.getElementById('refresh-logs-btn').onclick = fetchLogs;
    document.getElementById('log-lines-select').onchange = fetchLogs;
  }

  // ── Log summary (grouped findings; optional AI explanation) ───────────
  const VERDICT = {
    attention: { label: 'Needs a look', cls: 'critical' },
    info:      { label: 'Good to know', cls: 'warning' },
    noise:     { label: 'Usually ignorable', cls: 'healthy' }
  };
  let _logSummary = null, _aiLogsConfigured = null;

  const when = iso => iso ? new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  function renderLogSummary(s) {
    const box = document.getElementById('log-summary');
    _logSummary = s;
    if (!s) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="log-headline ${s.needsAttention ? 'attention' : 'calm'}">${App.esc(s.headline)}</div>
      ${(s.groups || []).map(g => {
        const v = VERDICT[g.verdict] || VERDICT.info;
        return `<div class="log-finding">
          <div class="log-finding-head">
            <span class="status-pill ${v.cls}">${App.esc(v.label)}</span>
            <strong>${App.esc(g.title)}</strong>
            <span class="ai-muted">×${App.esc(g.count)}${g.last ? ' · last ' + App.esc(when(g.last)) : ''}${g.count > 1 && g.first ? ' · first ' + App.esc(when(g.first)) : ''}</span>
          </div>
          <div>${App.esc(g.meaning)}</div>
          ${g.action ? `<div class="log-action"><strong>What to do:</strong> ${App.esc(g.action)}</div>` : ''}
        </div>`;
      }).join('')}
      ${s.hiddenGroups ? `<p class="ai-muted">…and ${App.esc(s.hiddenGroups)} more kinds of event, lower priority. Open the full log below to see them.</p>` : ''}
      ${s.groups && s.groups.length ? `<div class="log-ai-row"><button class="btn btn-secondary btn-sm" id="log-ai-btn">Explain with AI</button><span id="log-ai-note" class="ai-muted"></span></div><div id="log-ai-out"></div>` : ''}`;

    const btn = document.getElementById('log-ai-btn');
    if (btn) {
      btn.onclick = explainLogsWithAi;
      if (_aiLogsConfigured === null) {
        App.api('/api/v2/ai/status').then(st => { _aiLogsConfigured = !!st.aiConfigured; applyAiState(); }).catch(() => { _aiLogsConfigured = false; applyAiState(); });
      } else applyAiState();
    }
  }

  function applyAiState() {
    const btn = document.getElementById('log-ai-btn'), note = document.getElementById('log-ai-note');
    if (!btn) return;
    btn.disabled = !_aiLogsConfigured;
    if (note) note.textContent = _aiLogsConfigured ? 'Plain-language read of the findings above. Suggests only.' : 'AI explanation is not configured on the server (AI_API_KEY). The summary above works without it.';
  }

  async function explainLogsWithAi() {
    if (!_logSummary || !currentServer) return;
    const btn = document.getElementById('log-ai-btn'), out = document.getElementById('log-ai-out');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Explaining…';
    out.innerHTML = '<div class="ai-muted">Asking the AI to read the findings…</div>';
    try {
      const r = await App.api(`/api/v2/ai/logs/${encodeURIComponent(currentServer.id)}/explain`, { method: 'POST', body: { groups: _logSummary.groups, headline: _logSummary.headline } });
      const x = r.explanation, pill = { act: 'critical', monitor: 'warning', ignore: 'healthy' }[x.assessment] || 'warning';
      out.innerHTML = `<div class="ai-result">
        <div class="ai-result-head"><span class="ai-badge">AI-generated</span>
          <span class="ai-muted">AI · ${App.esc(x.confidence || '')} confidence${r.cached ? ' · cached' : ''}</span>
          <span class="status-pill ${pill}">${App.esc({ act: 'Act', monitor: 'Watch', ignore: 'Ignore' }[x.assessment] || x.assessment)}</span></div>
        <p class="ai-summary">${App.esc(x.headline)}</p>
        ${x.commonCause ? `<p><strong>Likely common cause:</strong> ${App.esc(x.commonCause)}</p>` : ''}
        ${(x.findings || []).map(f => `<div class="ai-action"><span class="status-pill ${f.severity === 'high' ? 'critical' : f.severity === 'medium' ? 'warning' : 'healthy'}">${App.esc(f.severity)}</span>
          <div><strong>${App.esc(f.title)}</strong><div class="ai-muted">${App.esc(f.meaning)}</div><div>${App.esc(f.suggestedAction)}</div></div></div>`).join('')}
        <p class="ai-muted">Suggestions only — nothing is run for you.</p></div>`;
    } catch (err) {
      out.innerHTML = `<div class="error-banner">${App.esc(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function fetchLogs() {
    const lines = parseInt(document.getElementById('log-lines-select').value, 10);
    document.getElementById('log-summary').innerHTML = '<span class="ai-muted">Summarising…</span>';
    try {
      const r = await App.api(`/api/v2/server/${encodeURIComponent(currentServer.id)}/logs?lines=${lines}`);
      document.getElementById('log-content').textContent =
        (r.lines || []).map(l => l.timestamp ? `[${l.timestamp}] ${l.message}` : l.message).join('\n') || '(no log entries)';
      document.getElementById('log-raw-count').textContent = `(${(r.lines || []).length} entries)`;
      renderLogSummary(r.summary || null);   // older servers return no summary: the raw log still works
      if (!r.summary) document.getElementById('log-raw').open = true;
    } catch (err) {
      document.getElementById('log-summary').innerHTML = '';
      document.getElementById('log-raw').open = true;
      document.getElementById('log-content').textContent = `Error: ${err.message}`;
    }
  }

  // ── Script ────────────────────────────────────────────────────────────────
  async function openScript() {
    if (!currentServer) return;
    selectedScriptId = null;
    document.getElementById('custom-script-server-name').textContent = currentServer.name || currentServer.id;
    document.getElementById('custom-script-input').value = '';
    document.getElementById('custom-script-confirm').checked = false;
    document.getElementById('run-script-btn').disabled = true;
    document.getElementById('run-script-label').textContent = 'Run with Admin Auth';

    // Reset to predefined tab
    document.querySelectorAll('#script-modal .stab').forEach(t => t.classList.remove('active'));
    document.querySelector('#script-modal .stab[data-stab="predefined"]').classList.add('active');
    App.show('script-stab-predefined'); App.hide('script-stab-custom');

    // Load predefined scripts
    try {
      const scripts = await App.api('/api/v2/actions/scripts');
      document.getElementById('scripts-list').innerHTML = scripts.map(s => `
        <div class="script-item" data-script-id="${App.esc(s.id)}">
          <div>
            <div class="script-name">${App.esc(s.name)}</div>
            <div class="script-desc">${App.esc(s.description)}</div>
          </div>
          ${s.requiresConfirmation ? '<span class="requires-confirm">&#9888; requires confirm</span>' : ''}
        </div>`).join('') || '<p style="padding:12px;color:#8C8279;font-size:12px">No predefined scripts configured.</p>';
    } catch {
      document.getElementById('scripts-list').innerHTML = '<p style="padding:12px;color:#8C8279;font-size:12px">Could not load scripts.</p>';
    }

    App.openModal('script-modal');
  }

  // Script tab switching
  document.querySelectorAll('#script-modal .stab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#script-modal .stab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.stab === 'predefined') {
        App.show('script-stab-predefined'); App.hide('script-stab-custom');
        document.getElementById('run-script-btn').disabled = !selectedScriptId;
      } else {
        App.hide('script-stab-predefined'); App.show('script-stab-custom');
        const checked = document.getElementById('custom-script-confirm').checked;
        const hasContent = !!document.getElementById('custom-script-input').value.trim();
        document.getElementById('run-script-btn').disabled = !(checked && hasContent);
      }
    });
  });

  // Predefined script selection
  document.getElementById('scripts-list').addEventListener('click', e => {
    const item = e.target.closest('.script-item');
    if (!item) return;
    document.querySelectorAll('.script-item').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');
    selectedScriptId = item.dataset.scriptId;
    document.getElementById('run-script-btn').disabled = false;
  });

  // Custom script enable
  document.getElementById('custom-script-confirm').addEventListener('change', function() {
    const hasContent = !!document.getElementById('custom-script-input').value.trim();
    document.getElementById('run-script-btn').disabled = !(this.checked && hasContent);
  });
  document.getElementById('custom-script-input').addEventListener('input', function() {
    const checked = document.getElementById('custom-script-confirm').checked;
    document.getElementById('run-script-btn').disabled = !(checked && !!this.value.trim());
  });

  // Run script button
  document.getElementById('run-script-btn').addEventListener('click', async () => {
    if (!currentServer) return;
    const isCustom   = document.querySelector('#script-modal .stab.active')?.dataset.stab === 'custom';
    const scriptBody = isCustom ? document.getElementById('custom-script-input').value.trim() : null;
    const scriptId   = !isCustom ? selectedScriptId : null;
    if (!scriptId && !scriptBody) return;

    const group = App.state.nav.group || '';

    // Admin auth
    let verified;
    try { verified = await App.showAdminModal('Run Script', currentServer.name || currentServer.id, group); }
    catch { return; }

    App.closeModal('script-modal');

    // Create ticket
    let ticket = null;
    try {
      const ticketRes = await App.api('/api/v2/tickets', {
        method: 'POST',
        body: {
          ticketType:   verified.ticketType,
          shortDescription: `Script execution on ${currentServer.name}`,
          description:  verified.ticketDesc,
          serverName:   currentServer.name,
          hyperscaler:  currentServer.provider || 'VMC',
          subnet:       group,
          actionType:   'script',
          scriptContent: scriptBody || `Predefined script: ${scriptId}`
        }
      });
      if (ticketRes.ticket) {
        ticket = ticketRes.ticket;
        App.toast(`Ticket ${ticket.number} created`, 'success', { label: `View ${ticket.number}`, url: ticket.url });
      }
    } catch (err) {
      App.toast(`Ticket creation failed — script aborted: ${err.message}`, 'error');
      return;
    }

    App.addActionLog(`Script execution started`);
    document.getElementById('run-script-label').textContent = 'Running…';
    document.getElementById('run-script-spinner').classList.remove('hidden');

    try {
      const body = { ticketType: verified.ticketType, ticketSysId: ticket?.sysId };
      if (scriptId) body.scriptId = scriptId; else body.script = scriptBody;

      const res = await App.api(`/api/v2/actions/${encodeURIComponent(currentServer.id)}/script`, { method: 'POST', body });

      // Show output modal
      document.getElementById('output-content').textContent =
        [res.stdout, res.stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)';
      const badge = document.getElementById('output-exit-badge');
      badge.textContent = `Exit: ${res.exitCode}`;
      badge.className   = `exit-code-badge ${res.exitCode === 0 ? 'ok' : 'fail'}`;
      App.openModal('output-modal');
      App.addActionLog(`Script completed with exit code ${res.exitCode}`);
    } catch (err) {
      App.toast(`Script failed: ${err.message}`, 'error');
      App.addActionLog(`Script failed: ${err.message}`, 'error');
    } finally {
      document.getElementById('run-script-label').textContent = 'Run with Admin Auth';
      document.getElementById('run-script-spinner').classList.add('hidden');
    }
  });

  return { load };
})();
