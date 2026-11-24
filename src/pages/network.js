/* Network and Firewall tabs.
 * Read-only views of the NetOps NOC platform and the PAN-OS firewall portal, fetched through the
 * Health Monitor's own API (/api/v2/network, /api/v2/firewall) so they sit behind the same sign-in. */

(function () {
  const esc = s => App.esc(s == null ? '' : String(s));
  const num = n => (n == null || n === '' ? '—' : Number(n).toLocaleString());
  const pill = (status) => {
    const s = String(status || 'unknown').toLowerCase();
    const cls = s === 'up' || s === 'ok' || s === 'active' ? 'healthy'
      : s === 'down' || s === 'unreachable' || s === 'critical' ? 'critical'
      : s === 'warn' || s === 'warning' || s === 'degraded' ? 'warning' : 'unknown';
    return `<span class="status-pill ${cls}">${esc(s)}</span>`;
  };
  const tile = (n, label, cls = '') => `<div class="ai-tile ${cls}"><div class="ai-tile-n">${n}</div><div class="ai-tile-l">${esc(label)}</div></div>`;
  const errorBox = (tool, err) => `<div class="net-error"><strong>${esc(tool)} could not be reached.</strong> ${esc(err.message || err)}<br><span class="ai-muted">The Health Monitor reads this view from ${esc(tool)}; check that it is running on the jump box.</span></div>`;
  const loading = text => `<div class="fleet-loading"><div class="spinner"></div>${esc(text)}</div>`;
  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function table(cols, rows, empty = 'Nothing to show') {
    if (!rows.length) return `<p class="ai-muted net-empty">${esc(empty)}</p>`;
    return `<table class="data-table net-table"><thead><tr>${cols.map(c => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td${c.num ? ' class="num"' : ''}>${c.html ? c.html(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function tabs(id, list, active) {
    return `<div class="ai-tabs" id="${id}">${list.map(t =>
      `<button class="ai-tab ${t.key === active ? 'active' : ''}" data-ntab="${t.key}">${esc(t.label)}${t.n != null ? `<span class="ai-tab-n ${t.n ? '' : 'zero'}">${num(t.n)}</span>` : ''}</button>`).join('')}</div>`;
  }

  // ── Network ────────────────────────────────────────────────────────────────
  const NetworkPage = {
    tab: 'down',
    data: null,

    async load() {
      const el = document.getElementById('network-body');
      document.getElementById('network-meta').textContent = 'From the NetOps NOC platform · loading…';
      el.innerHTML = loading('Loading network health…');
      try {
        const [summary, down, alerts] = await Promise.all([
          App.api('/api/v2/network/summary'),
          App.api('/api/v2/network/devices?status=down'),
          App.api('/api/v2/network/alerts')
        ]);
        this.data = { summary, down, alerts, interfaces: null, search: null };
        document.getElementById('network-meta').textContent = `From the NetOps NOC platform · devices polled every 30 s · loaded ${stamp()}`;
        this.render();
      } catch (err) {
        document.getElementById('network-meta').textContent = 'From the NetOps NOC platform';
        el.innerHTML = errorBox('NetOps', err);
      }
    },

    render() {
      const { summary, down, alerts } = this.data;
      const s = summary.stats || {};
      const el = document.getElementById('network-body');
      el.innerHTML = `
        <div class="ai-tiles net-tiles">
          ${tile(num(s.total), 'Devices')}
          ${tile(num(s.up), 'Up', 'healthy')}
          ${tile(num(s.down), 'Down', s.down ? 'critical' : 'healthy')}
          ${tile(num(s.alerts), 'Open alerts', s.alerts ? 'warning' : 'healthy')}
          ${tile(`${num(s.sites_down)}<span class="net-of"> / ${num(s.sites_total)}</span>`, 'Sites with a device down', s.sites_down ? 'warning' : 'healthy')}
          ${tile(`${s.health_score ?? '—'}%`, 'Devices up', s.health_score >= 99 ? 'healthy' : s.health_score >= 95 ? 'warning' : 'critical')}
        </div>
        ${tabs('network-tabs', [
          { key: 'down', label: 'Down devices', n: down.length },
          { key: 'sites', label: 'Sites affected', n: summary.sitesDown.length },
          { key: 'alerts', label: 'Open alerts', n: alerts.length },
          { key: 'types', label: 'By device type', n: summary.types.length },
          { key: 'interfaces', label: 'Busiest interfaces' },
          { key: 'search', label: 'Find a device' }
        ], this.tab)}
        <div id="network-tab-body"></div>`;
      el.querySelector('#network-tabs').addEventListener('click', e => {
        const b = e.target.closest('[data-ntab]'); if (!b) return;
        this.tab = b.dataset.ntab;
        el.querySelectorAll('#network-tabs .ai-tab').forEach(x => x.classList.toggle('active', x === b));
        this.renderTab();
      });
      this.renderTab();
    },

    async renderTab() {
      const box = document.getElementById('network-tab-body');
      const { summary, down, alerts } = this.data;
      const deviceCols = [
        { label: 'Device', html: r => `<strong>${esc(r.hostname)}</strong><div class="ai-host">${esc(r.ip_address)}</div>` },
        { label: 'Type', key: 'device_type' },
        { label: 'Site', key: 'site' },
        { label: 'Status', html: r => pill(r.status) },
        { label: 'Last seen (UTC)', key: 'last_seen' }
      ];
      if (this.tab === 'down') {
        box.innerHTML = table(deviceCols, down, 'No network devices are down.');
      } else if (this.tab === 'sites') {
        box.innerHTML = table([
          { label: 'Site', key: 'site' },
          { label: 'Devices', key: 'total', num: true },
          { label: 'Down', html: r => `<span class="net-bad">${num(r.down)}</span>`, num: true },
          { label: 'Up', key: 'up', num: true },
          { label: 'Open alerts', key: 'alerts', num: true },
          { label: '', html: r => `<button class="btn btn-ghost btn-xs" data-site="${esc(r.site)}">Show devices</button>` }
        ], summary.sitesDown, 'Every site has all its devices up.');
        box.onclick = e => {
          const b = e.target.closest('[data-site]'); if (!b) return;
          this.tab = 'search';
          document.querySelectorAll('#network-tabs .ai-tab').forEach(x => x.classList.toggle('active', x.dataset.ntab === 'search'));
          this.renderSearch(box, { site: b.dataset.site });
        };
      } else if (this.tab === 'alerts') {
        box.onclick = null;
        box.innerHTML = table([
          { label: 'Severity', html: r => pill(r.severity) },
          { label: 'Device', html: r => `<strong>${esc(r.hostname)}</strong><div class="ai-host">${esc(r.ip_address)}</div>` },
          { label: 'Site', key: 'site' },
          { label: 'Alert', key: 'message' },
          { label: 'Status', key: 'status' },
          { label: 'Raised (UTC)', key: 'triggered_at' }
        ], alerts, 'No open network alerts.');
      } else if (this.tab === 'types') {
        box.onclick = null;
        box.innerHTML = table([
          { label: 'Device type', key: 'type' },
          { label: 'Total', key: 'total', num: true },
          { label: 'Up', key: 'up', num: true },
          { label: 'Down', html: r => r.down ? `<span class="net-bad">${num(r.down)}</span>` : '0', num: true },
          { label: 'Up %', html: r => r.total ? (100 * r.up / r.total).toFixed(1) + '%' : '—', num: true }
        ], summary.types);
      } else if (this.tab === 'interfaces') {
        box.onclick = null;
        box.innerHTML = loading('Loading interfaces…');
        try {
          if (!this.data.interfaces) this.data.interfaces = await App.api('/api/v2/network/interfaces?limit=50');
          const newest = this.data.interfaces.map(i => i.updated_at).filter(Boolean).sort().pop();
          const ageH = newest ? (Date.now() - Date.parse(newest.replace(' ', 'T') + 'Z')) / 3600000 : null;
          const stale = ageH != null && ageH > 1
            ? `<div class="stale-banner">These figures are ${ageH >= 48 ? Math.floor(ageH / 24) + ' days' : Math.round(ageH) + ' hours'} old: NetOps last updated interface counters at ${esc(newest)} UTC. Its SNMP polling needs attention before they can be trusted.</div>`
            : '';
          box.innerHTML = stale + `<p class="ai-muted net-note">The 50 most utilised interfaces, as last polled by NetOps.</p>` + table([
            { label: 'Device', html: r => `<strong>${esc(r.hostname)}</strong><div class="ai-host">${esc(r.site)}</div>` },
            { label: 'Interface', key: 'if_name' },
            { label: 'Speed', html: r => r.speed_mbps >= 1000 ? (r.speed_mbps / 1000) + ' Gb/s' : num(r.speed_mbps) + ' Mb/s', num: true },
            { label: 'In / out Mb/s', html: r => `${num(r.in_mbps)} / ${num(r.out_mbps)}`, num: true },
            { label: 'Utilisation', html: r => `<span class="${r.util_pct >= 90 ? 'net-bad' : r.util_pct >= 75 ? 'net-warn' : ''}">${num(r.util_pct)}%</span>`, num: true },
            { label: 'Errors/s', key: 'errors_ps', num: true },
            { label: 'Updated (UTC)', key: 'updated_at' }
          ], this.data.interfaces);
        } catch (err) { box.innerHTML = errorBox('NetOps', err); }
      } else if (this.tab === 'search') {
        box.onclick = null;
        this.renderSearch(box, {});
      }
    },

    renderSearch(box, preset) {
      box.innerHTML = `<div class="net-search">
          <input type="text" id="net-q" class="server-search-input" placeholder="Host name or IP" value="${esc(preset.q || '')}">
          <input type="text" id="net-site" class="server-search-input" placeholder="Site (exact)" value="${esc(preset.site || '')}">
          <select id="net-status" class="select-sm"><option value="">Any status</option><option value="up">Up</option><option value="down">Down</option><option value="warn">Warning</option></select>
          <button class="btn btn-primary btn-sm" id="net-go">Search</button>
        </div><div id="net-results"></div>`;
      const go = async () => {
        const q = document.getElementById('net-q').value.trim();
        const site = document.getElementById('net-site').value.trim();
        const status = document.getElementById('net-status').value;
        const out = document.getElementById('net-results');
        if (!q && !site && !status) { out.innerHTML = '<p class="ai-muted net-empty">Type part of a host name or IP, or a site.</p>'; return; }
        out.innerHTML = loading('Searching…');
        try {
          const qs = new URLSearchParams(Object.entries({ q, site, status }).filter(([, v]) => v)).toString();
          const rows = await App.api('/api/v2/network/devices?' + qs);
          out.innerHTML = `<p class="ai-muted net-note">${num(rows.length)} device${rows.length === 1 ? '' : 's'}${rows.length > 300 ? ' (first 300 shown)' : ''}</p>` + table([
            { label: 'Device', html: r => `<strong>${esc(r.hostname)}</strong><div class="ai-host">${esc(r.ip_address)}</div>` },
            { label: 'Type', key: 'device_type' },
            { label: 'Vendor', key: 'vendor' },
            { label: 'Site', key: 'site' },
            { label: 'Status', html: r => pill(r.status) },
            { label: 'Checked by', key: 'metric_source' },
            { label: 'Last seen (UTC)', key: 'last_seen' }
          ], rows.slice(0, 300), 'No devices match.');
        } catch (err) { out.innerHTML = errorBox('NetOps', err); }
      };
      box.querySelector('#net-go').addEventListener('click', go);
      box.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
      if (preset.site || preset.q) go();
    }
  };

  // ── Firewall ───────────────────────────────────────────────────────────────
  const FirewallPage = {
    async load() {
      const el = document.getElementById('firewall-body');
      document.getElementById('firewall-meta').textContent = 'From the PAN-OS firewall portal · loading…';
      el.innerHTML = loading('Asking the firewall…');
      const [health, devices, traffic] = await Promise.allSettled([
        App.api('/api/v2/firewall/health'),
        App.api('/api/v2/firewall/devices'),
        App.api('/api/v2/firewall/traffic')
      ]);
      document.getElementById('firewall-meta').textContent = `From the PAN-OS firewall portal (XML API) and NetOps reachability · loaded ${stamp()}`;
      el.innerHTML = `
        <div class="detail-section"><div class="section-title">Firewall health</div>${this.healthHtml(health, devices)}</div>
        <div class="detail-section"><div class="section-title">Traffic right now <span class="section-sub">— the latest sessions logged by the firewall</span></div>${this.trafficHtml(traffic)}</div>`;
    },

    healthHtml(health, devices) {
      let html = '';
      if (health.status === 'fulfilled') {
        const h = health.value, d = h.device || {};
        const ok = h.status === 'ok';
        const ha = String(d.haState || 'unknown').toLowerCase();
        html += `<div class="fw-card ${ok ? 'ok' : 'bad'}">
          <div class="fw-head"><strong>${esc(d.hostname || 'Firewall')}</strong> ${pill(ok ? 'ok' : h.status)}</div>
          ${ok ? `<div class="fw-grid">
            <div><span class="info-key-d">Model</span><div>${esc(d.model)}</div></div>
            <div><span class="info-key-d">PAN-OS</span><div>${esc(d.version)}</div></div>
            <div><span class="info-key-d">Uptime</span><div>${esc(d.uptime)}</div></div>
            <div><span class="info-key-d">High availability</span><div>${esc(ha)}${ha === 'standalone' ? ' <span class="ai-muted">(no HA pair configured on this unit)</span>' : ''}</div></div>
            <div><span class="info-key-d">Serial</span><div>${esc(d.serial)}</div></div>
          </div>` : `<p class="net-bad">${esc(h.error || 'The portal could not reach the firewall API.')}</p>`}
        </div>`;
      } else {
        html += errorBox('PAN-OS portal', health.reason);
      }
      if (devices.status === 'fulfilled' && devices.value.length) {
        html += `<p class="ai-muted net-note">Reachability of every firewall, as checked by NetOps:</p>` + table([
          { label: 'Firewall', html: r => `<strong>${esc(r.hostname)}</strong><div class="ai-host">${esc(r.ip_address)}</div>` },
          { label: 'Site', key: 'site' },
          { label: 'Status', html: r => pill(r.status) },
          { label: 'Checked by', key: 'metric_source' },
          { label: 'Last seen (UTC)', key: 'last_seen' }
        ], devices.value);
      }
      return html;
    },

    trafficHtml(traffic) {
      if (traffic.status !== 'fulfilled') return errorBox('PAN-OS portal', traffic.reason);
      const t = traffic.value;
      if (!t.sample) return '<p class="ai-muted net-empty">The firewall returned no traffic logs for the last hour.</p>';
      const a = t.actions || {};
      const blocked = t.sample - (a.allow || 0);
      const pct = n => t.sample ? Math.round(100 * n / t.sample) + '%' : '—';
      const small = (title, rows) => `<div class="fw-top"><div class="ai-sub">${esc(title)}</div>${table([
        { label: 'Value', key: 'value' }, { label: 'Sessions', key: 'count', num: true }], rows, 'None')}</div>`;
      return `
        <p class="ai-muted net-note">Based on the latest ${num(t.sample)} sessions (${esc(t.from || '')} to ${esc(t.to || '')}, firewall time). A busy firewall logs this many in seconds, so read it as a snapshot of the mix, not a daily total.</p>
        <div class="ai-tiles net-tiles">
          ${tile(pct(a.allow || 0), 'Allowed', 'healthy')}
          ${tile(pct(a.deny || 0), 'Denied', 'warning')}
          ${tile(pct(a.drop || 0), 'Dropped', 'warning')}
          ${tile(pct(blocked), 'Not allowed (all)', blocked / t.sample > 0.5 ? 'critical' : 'muted')}
          ${tile(num(t.sample), 'Sessions sampled', 'muted')}
        </div>
        <div class="fw-tops">
          ${small('Rules blocking the most', t.topBlockedRules)}
          ${small('Denied sources', t.topDeniedSources)}
          ${small('Denied destinations', t.topDeniedDestinations)}
          ${small('Denied ports', t.topDeniedPorts)}
          ${small('Top applications', t.topApps)}
        </div>
        <div class="ai-sub" style="margin-top:14px">Latest blocked sessions</div>
        ${table([
          { label: 'Time', key: 'time' },
          { label: 'Source', html: r => `${esc(r.src)}<div class="ai-host">${esc(r.srcZone)}</div>` },
          { label: 'Destination', html: r => `${esc(r.dst)}:${esc(r.dport)}<div class="ai-host">${esc(r.dstZone)}</div>` },
          { label: 'App', key: 'app' },
          { label: 'Rule', key: 'rule' },
          { label: 'Action', html: r => `<span class="status-pill ${r.action === 'allow' ? 'healthy' : r.action === 'drop' ? 'critical' : 'warning'}">${esc(r.action)}</span>` }
        ], t.recentBlocked, 'No blocked sessions in the sample.')}`;
    }
  };

  // ── Summary strip on the Servers overview ──────────────────────────────────
  async function loadStrip() {
    const el = document.getElementById('net-strip');
    if (!el) return;
    const tabOn = t => { const b = document.querySelector(`#nav-tabs [data-tab="${t}"]`); return b && !b.classList.contains('hidden') && !document.getElementById('nav-tabs').classList.contains('hidden'); };
    if (!tabOn('network') && !tabOn('firewall')) { el.classList.add('hidden'); return; }
    const [net, fw] = await Promise.allSettled([App.api('/api/v2/network/summary'), App.api('/api/v2/firewall/health')]);
    const parts = [];
    if (net.status === 'fulfilled') {
      const s = net.value.stats || {};
      parts.push(`<button class="net-strip-item ${s.down ? 'bad' : 'ok'}" data-goto="network"><span class="ai-sub">Network</span>
        <strong>${num(s.up)} of ${num(s.total)}</strong> devices up${s.down ? ` · <span class="net-bad">${num(s.down)} down at ${num(s.sites_down)} site${s.sites_down === 1 ? '' : 's'}</span>` : ''}</button>`);
    }
    if (fw.status === 'fulfilled') {
      const d = fw.value.device || {};
      const ok = fw.value.status === 'ok';
      parts.push(`<button class="net-strip-item ${ok ? 'ok' : 'bad'}" data-goto="firewall"><span class="ai-sub">Firewall</span>
        <strong>${esc(d.hostname || 'PAN-OS')}</strong> ${ok ? `answering · PAN-OS ${esc(d.version || '')}` : '<span class="net-bad">not answering</span>'}</button>`);
    }
    el.innerHTML = parts.join('');
    el.classList.toggle('hidden', !parts.length);
    el.onclick = e => { const b = e.target.closest('[data-goto]'); if (b) App.navigateTo(b.dataset.goto); };
  }

  window.NetworkPage = NetworkPage;
  window.FirewallPage = FirewallPage;
  window.NetStrip = { load: loadStrip };
})();
