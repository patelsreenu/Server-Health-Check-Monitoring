'use strict';

/**
 * hostName.js
 * ───────────
 * The host name an administrator connects to, shown next to server names in the dashboard and the
 * alert emails.  Servers share one DNS domain, so the display form is just the first part
 * (APPSRV01); IP addresses and names in any other domain are left whole.  The full address is
 * kept for tooltips.  ALERT_STRIP_DOMAIN overrides the domain ("" shows full names everywhere).
 */

const STRIP_DOMAIN = (process.env.ALERT_STRIP_DOMAIN ?? '').toLowerCase().replace(/^\./, '');

function shortHost(host) {
  if (!host || !STRIP_DOMAIN) return host;
  const h = String(host);
  return h.toLowerCase().endsWith('.' + STRIP_DOMAIN) ? h.slice(0, -(STRIP_DOMAIN.length + 1)) : h;
}

/** Full address from the server list: the SSH host for Linux, otherwise the WinRM host, then `host`. */
function fqdnOf(cfg) {
  if (!cfg) return null;
  return (cfg.os === 'linux' ? cfg.ssh?.host : cfg.winrm?.host) || cfg.host || null;
}

const hostOf = cfg => shortHost(fqdnOf(cfg));

/** Host, how to connect, and where it lives — used by the alert emails. */
function describeServer(cfg) {
  if (!cfg) return {};
  const linux = cfg.os === 'linux';
  return { host: hostOf(cfg), fqdn: fqdnOf(cfg), connect: linux ? 'SSH' : 'RDP', os: linux ? 'Linux' : 'Windows', place: [cfg.provider, cfg.group].filter(Boolean).join(' · ') };
}

const osOf = cfg => (cfg?.os === 'linux' ? 'linux' : 'windows');

module.exports = { osOf, shortHost, fqdnOf, hostOf, describeServer };
