/* Network and Firewall tabs: the original NetOps NOC pages and PAN-OS Traffic Portal, served through
 * the Health Monitor at /tools/network/ and /tools/firewall/ (server/routes/toolsProxy.js). */

(function () {
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

  window.NetworkPage = NetworkPage;
  window.FirewallPage = FirewallPage;
})();
