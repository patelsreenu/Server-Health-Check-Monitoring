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

  // ── Network and Firewall tabs: the original tools, shown as they are ───────
  // The NetOps NOC pages and the PAN-OS Traffic Portal are served through the Health Monitor at
  // /tools/network/ and /tools/firewall/ (see server/routes/toolsProxy.js), with all their own features.
  let frameCookie = 0;
  async function ensureFrameSession() {
    if (Date.now() - frameCookie < 10 * 60 * 1000) return;
    await App.api('/api/v2/network/frame-session', { method: 'POST' });
    frameCookie = Date.now();
  }

  function toolPage(frameId, src) {
    return {
      async load(opts = {}) {
        const f = document.getElementById(frameId);
        try { await ensureFrameSession(); }
        catch (err) { App.toast('Could not open this tab: ' + err.message, 'error'); return; }
        if (opts.reload || !f.getAttribute('src')) f.setAttribute('src', src);
      },
      reload() { frameCookie = 0; return this.load({ reload: true }); }
    };
  }

  const NetworkPage = toolPage('network-frame', '/tools/network/noc-dashboard.html');
  const FirewallPage = toolPage('firewall-frame', '/tools/firewall/');

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
