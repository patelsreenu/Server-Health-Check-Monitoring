'use strict';

/**
 * AiPanels — the two AI surfaces in the UI.
 *   loadFleet()          panel above the fleet grid: correlated incidents,
 *                        disks nearing full, highest-risk servers
 *   loadInsight(id)      card on the server detail page: forecasts, 7-day
 *                        sparklines and an on-demand AI diagnosis
 *
 * Everything shown here comes from /api/v2/ai/*.  Forecasts are statistical;
 * only the "Analyze with AI" button calls the AI.
 */
const AiPanels = (() => {
  const esc = s => App.esc(String(s ?? ''));
  const REFRESH_MS = 60 * 1000;
  let _timer = null;
  let _aiConfigured = null;

  async function aiConfigured() {
    if (_aiConfigured !== null) return _aiConfigured;
    try { _aiConfigured = (await App.api('/api/v2/ai/status')).aiConfigured; }
    catch { _aiConfigured = false; }
    return _aiConfigured;
  }

  const ago = ts => {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  function goTo(serverId, provider, group) {
    App.navigateTo('detail', { serverId, provider: (provider || '').toLowerCase(), group: group || '' });
  }

  // ── Raise incident (manual) ────────────────────────────────────────────────
  // Opens a prefilled, editable draft.  The only call that creates a ServiceNow
  // incident is the POST below, made when the user clicks the submit button.
  let _draft = null;
  const $r = id => document.getElementById(id);

  async function openRaise(draftUrl) {
    try {
      _draft = await App.api(draftUrl);
    } catch (err) {
      App.toast(err.message, 'error');
      return;
    }
    $r('raise-title').value   = _draft.title;
    $r('raise-desc').value    = _draft.description;
    $r('raise-urgency').value = String(_draft.urgency);
    $r('raise-impact').value  = String(_draft.impact);
    $r('raise-ai-note').textContent = _draft.aiIncluded ? '(includes AI diagnosis)' : '(forecast data only)';
    $r('raise-force').checked = false;
    App.hide('raise-error');

    const dup = _draft.alreadyRaised;
    $r('raise-dup').textContent = dup ? `An incident (${dup.number || 'unknown'}) was already raised for this at ${new Date(dup.raisedAt).toLocaleString()}.` : '';
    $r('raise-dup').classList.toggle('hidden', !dup);
    $r('raise-force-row').classList.toggle('hidden', !dup);
    $r('raise-submit').disabled = false;
    $r('raise-submit-label').textContent = 'Raise incident';
    App.openModal('raise-modal');
  }

  $r('raise-submit')?.addEventListener('click', async () => {
    if (!_draft) return;
    const btn = $r('raise-submit');
    btn.disabled = true;
    $r('raise-submit-label').textContent = 'Raising…';
    App.hide('raise-error');
    try {
      const res = await App.api('/api/v2/ai/raise', { method: 'POST', body: {
        key: _draft.key,
        title: $r('raise-title').value.trim(),
        description: $r('raise-desc').value.trim(),
        urgency: $r('raise-urgency').value, impact: $r('raise-impact').value,
        serverName: _draft.serverName, provider: _draft.provider, group: _draft.group,
        force: $r('raise-force').checked
      } });
      App.closeModal('raise-modal');
      App.toast(`Incident ${res.ticket.number} raised`, 'success', { label: `View ${res.ticket.number}`, url: res.ticket.url }, 8000);
      _draft = null;
    } catch (err) {
      $r('raise-error').textContent = err.message;
      App.show('raise-error');
      btn.disabled = false;
      $r('raise-submit-label').textContent = 'Raise incident';
    }
  });

  // ── Fleet panel ────────────────────────────────────────────────────────────
  function riskClass(score) { return score >= 50 ? 'critical' : score >= 20 ? 'warning' : 'healthy'; }

  const BEST_GUESS = '<em class="ai-guess" title="A rule of thumb, not a confirmed diagnosis: the monitor noticed several servers in the same group failing within minutes of each other and suggests a shared cause. Check before acting.">(best guess ⓘ)</em>';

  // Short host name under the server name (the full address on hover), so an administrator knows where to connect.
  const hostTip = m => [m.fqdn || m.host, m.error].filter(Boolean).join(' — ');
  // Clicking a host name connects: Remote Desktop for Windows (downloads a .rdp file), the ssh command for Linux.
  const connectAttrs = m => `data-connect="${esc(m.serverId || m.id)}" data-os="${esc(m.os || 'windows')}" data-fqdn="${esc(m.fqdn || m.host)}"`;
  const connectTip = m => m.os === 'linux' ? `Copy the ssh command for ${m.fqdn || m.host}` : `Open Remote Desktop to ${m.fqdn || m.host}`;
  const hostLine = m => m.host ? `<div><button type="button" class="ai-host ai-host-link" ${connectAttrs(m)} title="${esc(connectTip(m))}">${esc(m.host)}</button></div>` : '';
  const nameCell = m => `<strong title="${esc(m.fqdn || m.host || '')}">${esc(m.name)}</strong>${m.provider ? ` <span class="ai-muted">${esc(m.provider)}${m.group ? ' · ' + esc(m.group) : ''}</span>` : ''}${hostLine(m)}`;

  const chip = (m, status) => `<button class="ai-chip ${esc(status || m.status)}" data-server="${esc(m.serverId || m.id)}" data-provider="${esc(m.provider || '')}" data-group="${esc(m.group || '')}" title="${esc(hostTip(m))}">${esc(m.name)}</button>`;

  function renderTiles(c, excluded) {
    const left = excluded && excluded.length ? ` (${excluded.length} powered-off servers are left out — see server/config/exclusions.json)` : '';
    const t = (cat, n, label, cls) => `<button type="button" class="ai-tile ${cls}${_drill === cat ? ' active' : ''}" data-drill="${cat}" title="Show the ${esc(n)} servers${cat === 'monitored' ? esc(left) : ''}"><div class="ai-tile-n">${esc(n)}</div><div class="ai-tile-l">${esc(label)}</div></button>`;
    return `<div class="ai-tiles">
      ${t('monitored', c.monitored, 'Monitored', '')}${t('healthy', c.healthy, 'Healthy', 'healthy')}${t('warning', c.warning, 'Warning', c.warning ? 'warning' : '')}
      ${t('critical', c.critical, 'Critical', c.critical ? 'critical' : '')}${t('unreachable', c.unreachable, 'Not reachable', c.unreachable ? 'muted' : '')}
    </div>
    <div id="ai-drill"></div>`;
  }

  // ── Drill-down: the servers behind one tile ────────────────────────────────
  let _drill = null, _drillData = null, _drillQ = '', _sort = { key: 'status', dir: 1 };
  const DRILL_TITLE = { monitored: 'All monitored servers', healthy: 'Healthy servers', warning: 'Servers with a warning', critical: 'Critical servers', unreachable: 'Servers that could not be checked' };
  const DRILL_HELP = {
    monitored: 'Every server the monitor has reported on in the last 24 hours.',
    healthy: 'Readings are within limits.',
    warning: 'A reading is above its warning limit (CPU 85%, memory 90%, disk 90%) or a monitored service needs a look.',
    critical: 'A reading is above its critical limit (CPU 90%, memory 95%, disk 95%) or a critical service is stopped. The server is reachable.',
    unreachable: 'The monitor got no reading, so these servers may be fine — the check itself failed.'
  };
  const lvl = (v, warn, crit) => v == null ? '' : v >= crit ? 'val-critical' : v >= warn ? 'val-warn' : '';
  const pct = (v, warn, crit) => v == null ? '<span class="ai-muted">—</span>' : `<span class="${lvl(v, warn, crit)}">${esc(v)}%</span>`;
  const SORTERS = {
    status: (a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9),
    name: (a, b) => a.name.localeCompare(b.name),
    cpu: (a, b) => (a.cpu ?? -1) - (b.cpu ?? -1), mem: (a, b) => (a.mem ?? -1) - (b.mem ?? -1), disk: (a, b) => (a.disk ?? -1) - (b.disk ?? -1),
    since: (a, b) => (new Date(b.since || 0)) - (new Date(a.since || 0))
  };
  const ORDER = { critical: 0, error: 1, warning: 2, healthy: 3 };

  /** Make the tile numbers match the snapshot the open list came from (status changes minute to minute). */
  function syncTiles(counts) {
    if (!counts) return;
    document.querySelectorAll('#ai-panel [data-drill]').forEach(t => {
      const n = t.querySelector('.ai-tile-n');
      if (n && counts[t.dataset.drill] != null) n.textContent = counts[t.dataset.drill];
    });
  }

  function paintDrillTable() {
    const box = document.getElementById('ai-drill-table');
    if (!box || !_drillData) return;
    const q = _drillQ.trim().toLowerCase();
    let rows = _drillData.servers.filter(r => !q || `${r.name} ${r.provider || ''} ${r.group || ''} ${r.problem || ''}`.toLowerCase().includes(q));
    const sorter = SORTERS[_sort.key] || SORTERS.status;
    rows = [...rows].sort((a, b) => sorter(a, b) * _sort.dir || a.name.localeCompare(b.name));
    const th = (key, label) => `<th class="ai-sortable" data-sort="${key}">${label}${_sort.key === key ? (_sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const unreachable = _drill === 'unreachable';
    box.innerHTML = rows.length ? `
      <table class="data-table ai-table">
        <thead><tr>${th('status', 'Status')}${th('name', 'Server')}<th>${unreachable ? 'What happened' : 'What is wrong'}</th>${th('cpu', 'CPU')}${th('mem', 'Memory')}${th('disk', 'Worst disk')}${th('since', unreachable ? 'Failing for' : 'In this state for')}${unreachable ? '<th>Last good reading</th>' : ''}</tr></thead>
        <tbody>${rows.map(r => `<tr class="ai-row" data-server="${esc(r.serverId)}" data-provider="${esc(r.provider || '')}" data-group="${esc(r.group || '')}">
          <td><span class="status-pill ${esc(r.status === 'error' ? 'muted' : r.status)}">${esc(r.status === 'error' ? 'not reachable' : r.status)}</span></td>
          <td>${nameCell(r)}</td>
          <td>${esc(r.status === 'error' ? (r.problem || 'Health check failed') : r.problem) || '<span class="ai-muted">—</span>'}</td>
          <td>${pct(r.cpu, 85, 90)}</td><td>${pct(r.mem, 90, 95)}</td><td>${pct(r.disk, 90, 95)}</td>
          <td class="ai-muted">${r.since ? esc(ago(r.since)) : '—'}</td>
          ${unreachable ? `<td class="ai-muted">${r.neverRead ? 'never' : r.lastHealthy ? esc(ago(r.lastHealthy)) + ' ago' : '—'}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table>` : `<p class="ai-muted">${q ? 'No servers match your search.' : 'No servers are in this state right now.'}</p>`;
    const n = document.getElementById('ai-drill-count');
    const at = new Date(_drillData.generatedAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (n) n.textContent = `${rows.length === _drillData.servers.length ? rows.length + ' servers' : rows.length + ' of ' + _drillData.servers.length} · as of ${at}`;
  }

  function paintDrill() {
    const box = document.getElementById('ai-drill');
    if (!box) return;
    if (!_drill) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="ai-card ai-drill">
        <h3 class="section-title">${esc(DRILL_TITLE[_drill])} <span class="section-sub" id="ai-drill-count"></span>
          <button type="button" class="btn btn-ghost btn-sm ai-drill-close" data-drill-close>Close ✕</button></h3>
        <p class="ai-muted">${esc(DRILL_HELP[_drill])} Click a column heading to sort, or a row to open that server.</p>
        <input type="search" id="ai-drill-q" class="ai-drill-q" placeholder="Search name, provider, group or problem…" value="${esc(_drillQ)}">
        <div id="ai-drill-table">${_drillData ? '' : '<p class="ai-muted">Loading…</p>'}</div>
      </div>`;
    paintDrillTable();
  }

  async function openDrill(cat) {
    if (_drill === cat) { _drill = null; _drillData = null; _redraw?.(); return; }   // click the active tile again to close
    _drill = cat; _drillData = null; _drillQ = ''; _sort = { key: cat === 'healthy' || cat === 'monitored' ? 'name' : 'status', dir: 1 };
    document.querySelectorAll('#ai-panel [data-drill]').forEach(t => t.classList.toggle('active', t.dataset.drill === cat));
    paintDrill();
    document.getElementById('ai-drill')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try { _drillData = await App.api(`/api/v2/ai/overview/servers?status=${encodeURIComponent(cat)}`); }
    catch (err) { const t = document.getElementById('ai-drill-table'); if (t) t.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`; return; }
    if (_drill === cat) { syncTiles(_drillData.counts); paintDrill(); }
  }

  function closeDrill() { _drill = null; _drillData = null; document.querySelectorAll('#ai-panel [data-drill]').forEach(t => t.classList.remove('active')); paintDrill(); }

  function renderNever(n) {
    if (!n.total) return '';
    return `
      <details class="ai-card ai-gap">
        <summary><strong>${esc(n.total)} servers the monitor has never been able to read</strong>
          <span class="ai-muted"> — these are setup problems, not outages. Grouped by likely cause (taken from the error text).</span></summary>
        ${n.groups.map(g => `
          <div class="ai-gap-group">
            <div><strong>${esc(g.cause)}</strong> <span class="ai-muted">· ${esc(g.servers.length)} servers</span></div>
            <div class="ai-muted">${esc(g.fix)}</div>
            <div class="ai-chips">${g.servers.map(m => chip(m, 'muted')).join('')}</div>
          </div>`).join('')}
      </details>`;
  }

  function renderIncidents(incidents) {
    if (!incidents.length) return '';
    return incidents.map(i => `
      <div class="ai-incident ${i.severity}">
        <div class="ai-incident-head">
          <strong>${esc(i.servers.length)} of ${esc(i.total)} ${esc(i.provider)} ${esc(i.group)} servers failing together</strong>
          <span class="ai-muted">started ${esc(ago(i.startedAt))} ago · within ${esc(i.spanMinutes)} min · ${esc(i.share)}% of group</span>
          <button class="btn btn-secondary btn-sm" data-raise-incident="${esc(i.key)}">Raise incident</button>
        </div>
        <div class="ai-incident-hint">${esc(i.hint)} ${BEST_GUESS}</div>
        <div class="ai-chips">
          ${i.servers.map(m => `<button class="ai-chip ${esc(m.status)}" data-server="${esc(m.id)}" data-provider="${esc(i.provider)}" data-group="${esc(i.group)}" title="${esc(hostTip(m))}">${esc(m.name)}</button>`).join('')}
        </div>
      </div>`).join('');
  }

  const LIMIT = 8;

  // Column definitions: get(row) → value; text columns sort A→Z first, number columns largest first
  // (dir: 1 = ascending).  Sorting happens on the full list before it is cut to LIMIT rows.
  const RANK = { high: 0, medium: 1, low: 2 };
  const nameOf = r => (r.name || '').toLowerCase();
  const COLS = {
    disks: {
      server: { get: nameOf, text: true }, drive: { get: r => r.drive, text: true }, now: { get: r => r.currentPct },
      growth: { get: r => r.growthGBPerDay ?? r.growthPctPerDay }, in95: { get: r => r.daysTo95, dir: 1 },
      confidence: { get: r => ({ high: 0, medium: 1, low: 2 })[r.confidence] ?? 3, dir: 1 }
    },
    load: {
      finding: { get: r => RANK[r.severity] ?? 3, dir: 1 }, server: { get: nameOf, text: true },
      now: { get: r => r.current }, avg24: { get: r => r.avg24h }, avg7: { get: r => r.avg7d },
      says: { get: r => (r.text || '').toLowerCase(), text: true }
    },
    risk: {
      score: { get: r => r.risk.score }, server: { get: nameOf, text: true },
      why: { get: r => (r.risk.reasons[0] || '').toLowerCase(), text: true }
    }
  };
  const _tsort = {};   // table → { col, dir }; empty = the list's natural order
  const colsFor = t => COLS[t === 'memory' || t === 'cpu' ? 'load' : t];

  function sortRows(rows, table) {
    const st = _tsort[table], def = st && colsFor(table)[st.col];
    if (!def) return rows;
    const empty = v => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));
    return [...rows].sort((a, b) => {
      const va = def.get(a), vb = def.get(b);
      if (empty(va) || empty(vb)) return empty(va) && empty(vb) ? 0 : empty(va) ? 1 : -1;   // blanks last either way
      const c = def.text ? String(va).localeCompare(String(vb), undefined, { numeric: true }) : va - vb;
      return c * st.dir;
    });
  }
  function sth(table, col, label) {
    const st = _tsort[table], on = st && st.col === col;
    return `<th class="ai-sortable" data-tsort="${table}:${col}" title="Click to sort">${label}${on ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  }
  function toggleSort(table, col) {
    const def = colsFor(table)[col]; if (!def) return;
    const st = _tsort[table];
    _tsort[table] = st && st.col === col ? { col, dir: -st.dir } : { col, dir: def.dir ?? (def.text ? 1 : -1) };
  }
  const _expanded = { disks: false, risk: false, memory: false, cpu: false };
  let _tab = 'disks', _lastIns = null;
  const moreLink = (key, shown, total) => total <= LIMIT ? '' :
    `<button class="btn btn-ghost btn-sm ai-more" data-more="${key}">${_expanded[key] ? 'Show fewer' : `Show all ${total}`}</button>`;

  function renderDiskRisks(risks) {
    if (!risks.length) return '<p class="ai-muted">No disks forecast to reach 95% within 30 days.</p>';
    return `
      <table class="data-table ai-table">
        <thead><tr>${sth('disks', 'server', 'Server')}${sth('disks', 'drive', 'Drive')}${sth('disks', 'now', 'Now')}${sth('disks', 'growth', 'Growth')}${sth('disks', 'in95', '95% in')}${sth('disks', 'confidence', 'Confidence')}</tr></thead>
        <tbody>${(_expanded.disks ? sortRows(risks, 'disks') : sortRows(risks, 'disks').slice(0, LIMIT)).map(d => `
          <tr class="ai-row" data-server="${esc(d.serverId)}">
            <td>${nameCell(d)}</td><td>${esc(d.drive)}</td><td>${esc(d.currentPct)}%</td>
            <td>${esc(d.growthGBPerDay != null ? d.growthGBPerDay + ' GB/day' : d.growthPctPerDay + '%/day')}</td>
            <td><strong class="${d.daysTo95 <= 7 ? 'val-critical' : d.daysTo95 <= 14 ? 'val-warn' : ''}">${esc(d.daysTo95)} d</strong></td>
            <td>${esc(d.confidence)}</td>
          </tr>`).join('')}</tbody>
      </table>${moreLink('disks', LIMIT, risks.length)}`;
  }

  const SEV_PILL = { high: 'critical', medium: 'warning', low: 'healthy' };
  const KIND_LABEL = { leak: 'Growing', sustained: 'Running hot', rising: 'Rising', unusual: 'Unusual' };

  function renderLoadRisks(rows, key, emptyText) {
    if (!rows.length) return `<p class="ai-muted">${esc(emptyText)}</p>`;
    const hot = key === 'memory' ? [90, 95] : [85, 90];
    const sorted = sortRows(rows, key);
    const shown = _expanded[key] ? sorted : sorted.slice(0, LIMIT);
    return `
      <table class="data-table ai-table">
        <thead><tr>${sth(key, 'finding', 'Finding')}${sth(key, 'server', 'Server')}${sth(key, 'now', 'Now')}${sth(key, 'avg24', '24 h avg')}${sth(key, 'avg7', '7 d avg')}${sth(key, 'says', 'What the data says')}</tr></thead>
        <tbody>${shown.map(r => `
          <tr class="ai-row" data-server="${esc(r.serverId)}" data-provider="${esc(r.provider || '')}" data-group="${esc(r.group || '')}">
            <td><span class="status-pill ${SEV_PILL[r.severity] || 'healthy'}">${esc(KIND_LABEL[r.kind] || r.kind)}</span></td>
            <td>${nameCell(r)}</td>
            <td>${pct(r.current, hot[0], hot[1])}</td><td>${pct(r.avg24h, hot[0], hot[1])}</td><td>${pct(r.avg7d, hot[0], hot[1])}</td>
            <td class="ai-finding">${esc(r.text)}</td>
          </tr>`).join('')}</tbody>
      </table>${moreLink(key, LIMIT, rows.length)}`;
  }

  const TAB_HELP = {
    disks: 'Drives forecast to reach 95% full within 30 days, from how fast they have been filling.',
    memory: 'Servers that are leaking memory (growing steadily since the last reboot), running at 90% or more all day, or unusual for this time of week. Database servers such as SQL Server hold memory on purpose, so a steady high figure there is not always a fault — the growth and "unusual" findings matter more.',
    cpu: 'Servers averaging 85% or more for hours, with CPU climbing steadily over two weeks, or far above their own normal for this time of week. Short spikes are ignored.',
    risk: 'Every server scored 0–100 from its status, disk and memory forecasts, repeated failures and unusual load. Hover or open a server for the reasons.'
  };

  function renderInsightsBody(ins) {
    const sm = ins.summary;
    const tab = (id, label, n) => `<button type="button" class="ai-tab${_tab === id ? ' active' : ''}" data-tab="${id}">${label}<span class="ai-tab-n${n ? '' : ' zero'}">${esc(n)}</span></button>`;
    const risky = ins.servers.filter(x => x.risk.score >= 20).length;
    const body = _tab === 'disks' ? renderDiskRisks(ins.diskRisks)
      : _tab === 'memory' ? renderLoadRisks(ins.memoryRisks || [], 'memory', 'No memory problems found: nothing is leaking, running hot all day, or unusual.')
      : _tab === 'cpu' ? renderLoadRisks(ins.cpuRisks || [], 'cpu', 'No CPU problems found: nothing has averaged 85% or more for hours, is climbing steadily, or is unusual for this time of week.')
      : renderRisky(ins.servers);
    return `
      <div class="ai-tabs">${tab('disks', 'Disks nearing full', ins.diskRisks.length)}${tab('memory', 'Memory', (ins.memoryRisks || []).length)}${tab('cpu', 'CPU', (ins.cpuRisks || []).length)}${tab('risk', 'Highest risk servers', risky)}</div>
      <p class="ai-muted ai-tab-help">${esc(TAB_HELP[_tab])} <span title="Calculated from the history this monitor has recorded, not by a language model. Open a server and press Analyze with AI for a written diagnosis.">Statistical forecast ⓘ</span></p>
      <div id="ai-insights-pane">${body}</div>`;
  }

  function renderRisky(servers) {
    const all = sortRows(servers.filter(x => x.risk.score >= 20), 'risk');
    const risky = _expanded.risk ? all : all.slice(0, LIMIT);
    if (!risky.length) return '<p class="ai-muted">No servers currently scoring as elevated risk.</p>';
    return `<table class="data-table ai-table">
      <thead><tr>${sth('risk', 'score', 'Score')}${sth('risk', 'server', 'Server')}${sth('risk', 'why', 'Why')}</tr></thead>
      <tbody>${risky.map(x => `
        <tr class="ai-row" data-server="${esc(x.serverId)}" data-provider="${esc(x.provider || '')}" data-group="${esc(x.group || '')}">
          <td><span class="status-pill ${riskClass(x.risk.score)}">${esc(x.risk.score)}</span></td>
          <td>${nameCell(x)}</td>
          <td class="ai-muted">${esc(x.risk.reasons.join(' · '))}</td>
        </tr>`).join('')}</tbody></table>` + moreLink('risk', LIMIT, all.length);
  }

  async function loadFleet() {
    const el = document.getElementById('ai-panel');
    if (!el) return;
    if (_timer) { clearInterval(_timer); _timer = null; }

    const draw = async () => {
      try {
        const [ins, inc, ov] = await Promise.all([
          App.api('/api/v2/ai/insights?limit=100'),
          App.api('/api/v2/ai/incidents'),
          App.api('/api/v2/ai/overview')
        ]);
        const sm = ins.summary;
        const calculating = ins.computing && !ins.serversAnalyzed;
        if (!ov.counts.monitored) {
          el.innerHTML = `<div class="ai-card"><h3 class="section-title">Fleet overview</h3>
            <p class="ai-muted">Collecting history — the overview, trends and forecasts appear once monitoring has recorded data (forecasts need roughly 12–24 hours).</p></div>`;
          return;
        }
        el.innerHTML = `
          ${renderTiles(ov.counts, ov.excluded)}
          ${renderIncidents(inc.incidents)}
          ${renderNever(ov.neverReachable)}
          <div class="ai-card">
            <h3 class="section-title">AI Insights
              <span class="section-sub">${calculating ? 'calculating…' : `${esc(ins.serversAnalyzed)} servers analysed ·
                ${esc(sm.highRisk)} high risk · ${esc(sm.diskBreach30d)} disks filling · ${esc(sm.memoryPressure ?? sm.memoryLeaks)} memory · ${esc(sm.cpuPressure ?? 0)} CPU`}</span>
            </h3>
            <div id="ai-insights-body">${calculating
              ? '<p class="ai-muted">Calculating forecasts for the whole fleet — this takes about a minute after the app starts. This section updates by itself.</p>'
              : renderInsightsBody(ins)}</div>
          </div>`;
        _lastIns = calculating ? null : ins;
        paintDrill();   // the panel was just rebuilt; put back an open drill-down
        if (calculating) setTimeout(() => { if (App.state.page === 'fleet') _redraw?.(); }, 20000);
      } catch (err) {
        el.innerHTML = `<div class="ai-card"><p class="ai-muted">AI insights unavailable: ${esc(err.message)}</p></div>`;
      }
    };

    _redraw = async () => { await draw(); if (_drill) { const cat = _drill; try { _drillData = await App.api(`/api/v2/ai/overview/servers?status=${encodeURIComponent(cat)}`); } catch { /* keep old */ } if (_drill === cat) { syncTiles(_drillData?.counts); paintDrill(); } } };
    await _redraw();
    _timer = setInterval(() => { if (App.state.page === 'fleet' && document.activeElement?.id !== 'ai-drill-q') _redraw(); }, REFRESH_MS);
  }

  let _redraw = null;
  document.getElementById('ai-panel')?.addEventListener('input', e => {
    if (e.target.id === 'ai-drill-q') { _drillQ = e.target.value; paintDrillTable(); }
  });
  document.getElementById('ai-panel')?.addEventListener('click', e => {
    const conn = e.target.closest('[data-connect]');
    if (conn) { e.stopPropagation(); App.connectHost(conn.dataset.connect, conn.dataset.os, conn.dataset.fqdn); return; }
    const tile = e.target.closest('[data-drill]');
    if (tile) { openDrill(tile.dataset.drill); return; }
    if (e.target.closest('[data-drill-close]')) { closeDrill(); return; }
    const sort = e.target.closest('[data-sort]');
    if (sort) { const k = sort.dataset.sort; _sort = { key: k, dir: _sort.key === k ? -_sort.dir : 1 }; paintDrillTable(); return; }
    const tsort = e.target.closest('[data-tsort]');
    if (tsort && _lastIns) {
      const [table, col] = tsort.dataset.tsort.split(':');
      toggleSort(table, col);
      document.getElementById('ai-insights-body').innerHTML = renderInsightsBody(_lastIns);
      return;
    }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn && _lastIns) { _tab = tabBtn.dataset.tab; document.getElementById('ai-insights-body').innerHTML = renderInsightsBody(_lastIns); return; }
    const more = e.target.closest('[data-more]');
    if (more) {
      _expanded[more.dataset.more] = !_expanded[more.dataset.more];
      if (_lastIns) document.getElementById('ai-insights-body').innerHTML = renderInsightsBody(_lastIns); else _redraw?.();
      return;
    }
    const r = e.target.closest('[data-raise-incident]');
    if (r) { openRaise(`/api/v2/ai/draft/incident?key=${encodeURIComponent(r.dataset.raiseIncident)}`); return; }
    const t = e.target.closest('[data-server]');
    if (t) goTo(t.dataset.server, t.dataset.provider, t.dataset.group);
  });

  // ── Server detail card ─────────────────────────────────────────────────────
  function sparkline(points, color) {
    const vals = points.filter(v => v != null);
    if (vals.length < 2) return '<span class="ai-muted">not enough data</span>';
    const W = 220, H = 38;
    const step = W / (points.length - 1);
    const path = points.map((v, i) => v == null ? null : `${(i * step).toFixed(1)},${(H - (Math.min(v, 100) / 100) * H).toFixed(1)}`)
                       .filter(Boolean).join(' ');
    return `<svg class="ai-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }

  function forecastItems(f) {
    const items = [];
    for (const d of f.disks) {
      if (d.daysTo95 != null) items.push({ lvl: d.daysTo95 <= 7 ? 'critical' : d.daysTo95 <= 14 ? 'warning' : 'info',
        text: `Drive ${d.drive} is ${d.currentPct}% full and growing ${d.growthGBPerDay != null ? d.growthGBPerDay + ' GB' : d.growthPctPerDay + '%'}/day — reaches 95% in about ${d.daysTo95} days (${d.confidence} confidence).` });
    }
    if (f.memory?.leakSuspected) items.push({ lvl: 'warning',
      text: `Memory has grown ${f.memory.growthPctPerDay}%/day since the last reboot (now ${f.memory.currentPct}%)${f.memory.daysTo95 != null ? ` — reaches 95% in about ${f.memory.daysTo95} days` : ''}.` });
    for (const a of f.anomalies) if (a.anomalous)
      items.push({ lvl: 'warning', text: `${a.metric.toUpperCase()} is ${a.current}% — usually about ${a.baseline}% at this time of week.` });
    if (f.flapping.flapping) items.push({ lvl: 'warning', text: `${f.flapping.count7d} failures in the last 7 days — recurring problem.` });
    return items;
  }

  function renderAnalysis(r) {
    const a = r.analysis;
    return `
      <div class="ai-result">
        <div class="ai-result-head">
          <span class="ai-badge">AI-generated</span>
          <span class="ai-muted">AI · ${esc(a.confidence)} confidence${r.cached ? ' · cached' : ''}${r.logsIncluded ? ' · event logs included' : ''}</span>
          ${a.escalate ? '<span class="status-pill critical">Escalate</span>' : ''}
        </div>
        <p class="ai-summary">${esc(a.summary)}</p>
        <p><strong>Likely cause:</strong> ${esc(a.likelyCause)}</p>
        ${a.evidence?.length ? `<ul class="ai-list">${a.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        ${a.prediction ? `<p><strong>If untreated:</strong> ${esc(a.prediction)}</p>` : ''}
        ${a.recommendedActions?.length ? `
          <h4 class="ai-sub">Suggested next steps</h4>
          ${a.recommendedActions.map(x => `
            <div class="ai-action">
              <span class="status-pill ${x.risk === 'high' ? 'critical' : x.risk === 'medium' ? 'warning' : 'healthy'}">${esc(x.risk)} risk</span>
              <div><strong>${esc(x.title)}</strong>${x.scriptId ? ` <span class="ai-chip-static">script: ${esc(x.scriptId)}</span>` : ''}
              <div class="ai-muted">${esc(x.detail || '')}</div></div>
            </div>`).join('')}
          <p class="ai-muted">Suggestions only — nothing runs until you choose it via Actions → Run script.</p>` : ''}
      </div>`;
  }

  async function runAnalysis(serverId, btn, out, force) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Analysing… (up to 60s)';
    out.innerHTML = '<div class="ai-muted"><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Reading metrics, forecasts and event logs…</div>';
    try {
      const r = await App.api(`/api/v2/ai/analyze/${encodeURIComponent(serverId)}`, { method: 'POST', body: { includeLogs: true, force } });
      out.innerHTML = renderAnalysis(r);
    } catch (err) {
      out.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  async function loadInsight(serverId) {
    const el = document.getElementById('detail-ai-body');
    const section = document.getElementById('detail-ai-section');
    if (!el || !section) return;
    section.classList.remove('hidden');
    el.innerHTML = '<p class="ai-muted">Loading forecasts…</p>';

    let data;
    try {
      data = await App.api(`/api/v2/ai/server/${encodeURIComponent(serverId)}?days=7`);
    } catch (err) {
      el.innerHTML = `<p class="ai-muted">${/No history/.test(err.message)
        ? 'No history yet for this server — forecasts appear once monitoring has collected data.'
        : esc(err.message)}</p>`;
      return;
    }

    const items = forecastItems(data);
    const cpu = data.history.map(h => h.cpu), mem = data.history.map(h => h.mem);
    const configured = await aiConfigured();

    el.innerHTML = `
      <div class="ai-detail-top">
        <span class="status-pill ${riskClass(data.risk.score)}">Risk ${esc(data.risk.score)}/100</span>
        <span class="ai-muted">${esc(data.risk.reasons.join(' · ') || 'no risk factors found')}</span>
      </div>
      <div class="ai-sparks">
        <div><div class="metric-lbl">CPU · 7 days</div>${sparkline(cpu, '#C4704A')}</div>
        <div><div class="metric-lbl">Memory · 7 days</div>${sparkline(mem, '#6B5C4E')}</div>
      </div>
      ${items.length
        ? `<ul class="ai-list">${items.map(i => `<li class="ai-${i.lvl}">${esc(i.text)}</li>`).join('')}</ul>`
        : '<p class="ai-muted">No concerning trends detected.</p>'}
      <div class="ai-actions-row">
        <button class="btn btn-secondary btn-sm" id="ai-analyze-btn" ${configured ? '' : 'disabled'}>Analyze with AI</button>
        <button class="btn btn-ghost btn-sm" id="ai-raise-btn">Raise incident</button>
        ${configured ? '' : '<span class="ai-muted">AI analysis is not configured on the server (AI_API_KEY).</span>'}
      </div>
      <div id="ai-analysis-out"></div>`;

    const btn = document.getElementById('ai-analyze-btn');
    const out = document.getElementById('ai-analysis-out');
    btn.addEventListener('click', () => runAnalysis(serverId, btn, out, false));
    document.getElementById('ai-raise-btn').addEventListener('click', () => openRaise(`/api/v2/ai/draft/server/${encodeURIComponent(serverId)}`));
  }

  return { loadFleet, loadInsight };
})();
