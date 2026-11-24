'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const TOKEN_KEY = 'hmv2_token';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  token:   null,
  session: null,
  page:    'fleet',    // 'fleet' | 'subnet' | 'detail'
  nav: {
    provider:  null,   // 'vmc' | 'aws' | 'azure' | 'oci'
    group:     null,   // e.g. 'Prod'
    serverId:  null,
    os:        null    // 'windows' | 'linux' | null (no filter)
  },
  cache: {
    fleet:   new Map(),   // key: provider → { data, fetchedAt }
    subnets: new Map()    // key: "provider:group" → { servers, databases, fetchedAt }
  },
  hostServerId: null,    // loaded from backend
  actionLog: [],
  pendingAction: null    // { resolve, reject }
};

const SUBNET_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');

// ── Fetch wrapper ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) { handleAuthExpiry(); }
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Connect to a host ─────────────────────────────────────────────────────────
// Windows: downloads a .rdp file that Windows opens in Remote Desktop (the user signs in there).
// Linux: copies the ssh command, since browsers cannot open an SSH session.
async function connectHost(serverId, os, fqdn) {
  if (os === 'linux') {
    const cmd = 'ssh ' + fqdn;
    try { await navigator.clipboard.writeText(cmd); toast('Copied "' + cmd + '" — paste it into a terminal to connect.'); }
    catch { toast('Connect with: ' + cmd, 'warning', null, 9000); }
    return;
  }
  try {
    const res = await fetch('/api/v2/server/' + encodeURIComponent(serverId) + '/rdp', { headers: { Authorization: 'Bearer ' + state.token } });
    if (res.status === 401) { handleAuthExpiry(); return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
    const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || (serverId + '.rdp');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Remote Desktop file downloaded — open "' + name + '" from your browser downloads to connect.', 'success', null, 7000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(message, type = 'success', link = null, duration = 4000) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✗', warning: '⚠' };
  el.innerHTML = `
    <span class="toast-icon">${icons[type] || '•'}</span>
    <div class="toast-text">
      ${esc(message)}
      ${link ? `<a class="toast-link" href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.label)}</a>` : ''}
    </div>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function init() {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) {
    state.token = stored;
    try {
      const r = await fetch('/api/v2/auth/whoami', { headers: { Authorization: `Bearer ${stored}` } });
      if (r.ok) {
        state.session = await r.json();
        await showApp();
        return;
      }
    } catch {}
    localStorage.removeItem(TOKEN_KEY);
  }
  showLogin();
}

function showLogin() {
  hide('app');
  show('login-overlay');
  hide('sso-step-auth');
  hide('sso-step-success');
  show('sso-step-start');
}

async function showApp() {
  hide('login-overlay');
  show('app');
  $('nav-account').textContent = state.session?.accountName || '';

  // Load host server ID
  try {
    const r = await api('/api/v2/actions/host-server');
    state.hostServerId = r.hostServerId;
  } catch {}

  // Hide the Network / Firewall tabs when those tools are not configured on the server.
  try {
    const on = await api('/api/v2/network/enabled');
    document.querySelectorAll('#nav-tabs [data-tab="network"]').forEach(b => b.classList.toggle('hidden', !on.network));
    document.querySelectorAll('#nav-tabs [data-tab="firewall"]').forEach(b => b.classList.toggle('hidden', !on.firewall));
    if (!on.network && !on.firewall) hide('nav-tabs');
  } catch {}

  const start = parseHash();
  navigateTo(start.page, start.nav, { replace: true });
}

function handleAuthExpiry() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  toast('Session expired — please sign in again', 'error', null, 6000);
  setTimeout(showLogin, 1500);
}

// ── SSO ───────────────────────────────────────────────────────────────────────
$('sso-login-btn').addEventListener('click', startSSO);

async function startSSO() {
  $('sso-login-btn').disabled = true;
  $('sso-login-btn').textContent = 'Starting…';
  hide('sso-error-msg');
  try {
    const res = await fetch('/api/v2/auth/sso-start', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const data = await res.json();

    // Auto-open the AWS portal — user just needs to confirm the code
    window.open(data.verificationUriComplete || data.verificationUri, '_blank', 'noopener');

    hide('sso-step-start'); show('sso-step-auth');
    $('sso-user-code').textContent = data.userCode;
    $('sso-portal-link').href = data.verificationUriComplete || data.verificationUri;

    let secondsLeft = data.expiresIn;
    const tick = setInterval(() => {
      secondsLeft--;
      const m = Math.floor(secondsLeft / 60), s = secondsLeft % 60;
      $('sso-expiry-countdown').textContent = `${m}:${s.toString().padStart(2,'0')}`;
      if (secondsLeft <= 0) clearInterval(tick);
    }, 1000);

    pollSSO(data.authId, (data.pollInterval || 5) * 1000, tick);
  } catch (err) {
    $('sso-login-btn').disabled = false;
    $('sso-login-btn').textContent = 'Sign in with AWS IAM Identity Center';
    const el = $('sso-error-msg');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
}

async function pollSSO(authId, intervalMs, countdownTimer) {
  const poll = async () => {
    try {
      const res = await fetch(`/api/v2/auth/sso-poll/${authId}`);
      if (!res.ok) {
        const e = await res.json();
        clearInterval(timer); clearInterval(countdownTimer);
        showSSOError(e.error || 'Authorization failed');
        return;
      }
      const data = await res.json();
      if (data.status === 'authorized') {
        clearInterval(timer); clearInterval(countdownTimer);
        state.token = data.token;
        state.session = { accountName: data.accountName, roleName: data.roleName, expiresAt: data.expiresAt };
        localStorage.setItem(TOKEN_KEY, data.token);
        hide('sso-step-auth'); show('sso-step-success');
        $('sso-account-info').textContent = `${data.accountName} / ${data.roleName}`;
        setTimeout(showApp, 1200);
      }
    } catch (err) {
      $('poll-status-text').textContent = `Error: ${err.message}`;
    }
  };
  const timer = setInterval(poll, intervalMs);
  poll();
}

function showSSOError(msg) {
  hide('sso-step-auth'); show('sso-step-start');
  $('sso-login-btn').disabled = false;
  $('sso-login-btn').textContent = 'Sign in with AWS IAM Identity Center';
  const el = $('sso-error-msg');
  el.textContent = msg; el.classList.remove('hidden');
}

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/v2/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

// ── Router ────────────────────────────────────────────────────────────────────
// ── Browser history ───────────────────────────────────────────────────────────
// Every page change is recorded so the Back and Forward buttons move between pages inside the app instead
// of leaving the site.  The address also carries the page (#/fleet, #/subnet/aws/Prod, #/server/<id>),
// so a refresh or a bookmark returns to the same place.
const enc = encodeURIComponent;
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

function routeHash(page, nav) {
  if (page === 'subnet') return `#/subnet/${enc(nav.provider || '')}/${enc(nav.group || '')}${nav.os ? '/' + enc(nav.os) : ''}`;
  if (page === 'detail') return `#/server/${enc(nav.serverId || '')}/${enc(nav.provider || '')}/${enc(nav.group || '')}`;
  if (page === 'network' || page === 'firewall') return '#/' + page;
  return '#/fleet';
}

function parseHash(hash = location.hash) {
  const p = (hash || '').replace(/^#\/?/, '').split('/').map(dec);
  if (p[0] === 'subnet' && p[1]) return { page: 'subnet', nav: { provider: p[1], group: p[2] || '', os: p[3] || null, serverId: null } };
  if (p[0] === 'server' && p[1]) return { page: 'detail', nav: { serverId: p[1], provider: p[2] || null, group: p[3] || null } };
  if (p[0] === 'network' || p[0] === 'firewall') return { page: p[0], nav: {} };
  return { page: 'fleet', nav: {} };
}

function recordHistory(page, replace) {
  const hash = routeHash(page, state.nav);
  const snapshot = { page, nav: { provider: state.nav.provider, group: state.nav.group, serverId: state.nav.serverId, os: state.nav.os } };
  if (replace) history.replaceState(snapshot, '', hash);
  else if (location.hash !== hash) history.pushState(snapshot, '', hash);   // same page again (e.g. Refresh): no new entry
  else history.replaceState(snapshot, '', hash);
}

window.addEventListener('popstate', e => {
  if (!state.token || $('app').classList.contains('hidden')) return;   // not signed in: nothing to show
  const to = e.state && e.state.page ? e.state : parseHash();
  navigateTo(to.page, to.nav || {}, { fromHistory: true });
});

async function navigateTo(page, params = {}, opts = {}) {
  state.page = page;
  Object.assign(state.nav, params);
  if (!opts.fromHistory) recordHistory(page, !!opts.replace);

  ['page-fleet','page-subnet','page-detail','page-network','page-firewall'].forEach(id => hide(id));

  updateBreadcrumb();
  updateNavTabs();

  if (page === 'fleet') {
    show('page-fleet');
    NetStrip.load().catch(() => {});
    await FleetPage.load();
  } else if (page === 'subnet') {
    show('page-subnet');
    await SubnetPage.load(state.nav.provider, state.nav.group, state.nav.os);
  } else if (page === 'detail') {
    show('page-detail');
    await DetailPage.load(state.nav.serverId);
  } else if (page === 'network') {
    show('page-network');
    await NetworkPage.load();
  } else if (page === 'firewall') {
    show('page-firewall');
    await FirewallPage.load();
  }
}

// Top tabs: Servers Monitoring (fleet, subnet and server pages), Network Monitoring, Firewall Monitoring.
function updateNavTabs() {
  const tab = state.page === 'network' || state.page === 'firewall' ? state.page : 'fleet';
  document.querySelectorAll('#nav-tabs .nav-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
$('nav-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) navigateTo(b.dataset.tab);
});

function updateBreadcrumb() {
  const crumbs = [];
  if (state.page === 'network' || state.page === 'firewall') { $('breadcrumb').innerHTML = ''; return; }
  crumbs.push(`<span class="bc-item ${state.page === 'fleet' ? 'current' : ''}" data-bc="fleet">Fleet</span>`);

  if (state.page === 'subnet' || state.page === 'detail') {
    const provLabel = (state.nav.provider || '').toUpperCase();
    crumbs.push(`<span class="bc-sep">›</span>`);
    crumbs.push(`<span class="bc-item ${state.page === 'subnet' ? 'current' : ''}" data-bc="subnet">${esc(provLabel)} › ${esc(state.nav.group || '')}</span>`);
  }

  if (state.page === 'detail') {
    crumbs.push(`<span class="bc-sep">›</span>`);
    crumbs.push(`<span class="bc-item current">${esc(state.nav.serverId || '')}</span>`);
  }

  $('breadcrumb').innerHTML = crumbs.join('');
}

// Clicking the product name always returns to the main (fleet) page.
const goHome = () => navigateTo('fleet');
$('nav-brand').addEventListener('click', goHome);
$('nav-brand').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

$('breadcrumb').addEventListener('click', e => {
  const item = e.target.closest('[data-bc]');
  if (!item) return;
  const bc = item.dataset.bc;
  if (bc === 'fleet')  navigateTo('fleet');
  if (bc === 'subnet') navigateTo('subnet', { provider: state.nav.provider, group: state.nav.group });
});

$('refresh-btn').addEventListener('click', () => {
  if (state.page === 'fleet') {
    state.cache.fleet.clear();
    navigateTo('fleet');
  } else if (state.page === 'subnet') {
    navigateTo('subnet', state.nav);
  } else if (state.page === 'detail') {
    DetailPage.load(state.nav.serverId);
  } else if (state.page === 'network') {
    NetworkPage.data = null; NetworkPage.load();
  } else if (state.page === 'firewall') {
    FirewallPage.load();
  }
});

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id)  { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => closeModal(el.dataset.close));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['admin-modal','script-modal','logs-modal','output-modal','host-warn-modal','raise-modal'].forEach(id => {
      if (!$(id).classList.contains('hidden')) closeModal(id);
    });
  }
});

// ── Action Log ────────────────────────────────────────────────────────────────
function addActionLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  state.actionLog.push({ time, message, type });
  const log = $('action-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'action-log-entry';
  entry.innerHTML = `<span class="action-log-time">${time}</span>${esc(message)}`;
  log.prepend(entry);
}

// ── Admin Credential Modal ────────────────────────────────────────────────────
function showAdminModal(actionLabel, serverName, group, serverId, opts = {}) {
  return new Promise((resolve, reject) => {
    state.pendingAction = { resolve, reject, serverId };
    // Service restart: no ServiceNow ticket, and the description becomes the reason that is logged.
    const noTicket = opts.ticket === false;
    $('ticket-type-select').closest('.form-field').classList.toggle('hidden', noTicket);
    $('ticket-description').closest('.form-field').querySelector('.field-label').firstChild.textContent = noTicket ? 'Reason ' : 'Ticket Description ';

    $('confirm-action').textContent = actionLabel.toUpperCase();
    $('confirm-server').textContent = serverName;
    $('confirm-group').textContent  = group || '';
    $('confirm-user').textContent   = state.session?.accountName || 'unknown';
    $('confirm-time').textContent   = new Date().toLocaleString();
    $('admin-username').value       = '';
    $('admin-password').value       = '';
    $('ticket-description').value   = '';
    $('admin-error').classList.add('hidden');
    $('admin-verify-label').textContent = 'Verify & Proceed';
    $('admin-spinner').classList.add('hidden');
    $('admin-verify-btn').disabled = false;

    openModal('admin-modal');
  });
}

$('admin-verify-btn').addEventListener('click', async () => {
  const username = $('admin-username').value.trim();
  const password = $('admin-password').value;
  if (!username) { showAdminError('Username is required'); return; }
  if (!password) { showAdminError('Password is required'); return; }

  const serverId = state.pendingAction?.serverId;
  if (!serverId) { showAdminError('No server context — please try again'); return; }

  $('admin-verify-btn').disabled = true;
  $('admin-verify-label').textContent = 'Verifying access…';
  $('admin-spinner').classList.remove('hidden');
  $('admin-error').classList.add('hidden');

  try {
    const verifyRes = await api(`/api/v2/actions/${encodeURIComponent(serverId)}/verify-access`, {
      method: 'POST', body: { username, password }
    });
    if (!verifyRes.authorized) { showAdminError(verifyRes.error || 'Access denied'); return; }

    const ticketType = $('ticket-type-select').value;
    const ticketDesc = $('ticket-description').value.trim();

    closeModal('admin-modal');

    if (state.pendingAction) {
      state.pendingAction.resolve({ verified: true, ticketType, ticketDesc, username, password });
      state.pendingAction = null;
    }
  } catch (err) {
    showAdminError(err.message);
  } finally {
    $('admin-verify-btn').disabled = false;
    $('admin-verify-label').textContent = 'Verify & Proceed';
    $('admin-spinner').classList.add('hidden');
  }
});

function showAdminError(msg) {
  const el = $('admin-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('admin-verify-btn').disabled = false;
  $('admin-verify-label').textContent = 'Verify & Proceed';
  $('admin-spinner').classList.add('hidden');
}

// Cancel admin modal rejects the pending action
document.querySelector('[data-close="admin-modal"]').addEventListener('click', () => {
  if (state.pendingAction) { state.pendingAction.reject(new Error('cancelled')); state.pendingAction = null; }
});

// ── Action Confirm Modal ──────────────────────────────────────────────────────
function showActionConfirm(action, serverName) {
  const messages = {
    restart: `You are about to <strong>restart</strong> server <strong>${esc(serverName)}</strong>.<br><br>Are you sure you want to restart?`,
    stop:    `You are about to <strong>stop</strong> server <strong>${esc(serverName)}</strong>.<br><br>Are you sure you want to stop?`,
    start:   `You are about to <strong>start</strong> server <strong>${esc(serverName)}</strong>.<br><br>Are you sure you want to start?`
  };
  const titles = { restart: '&#9888; Confirm Restart', stop: '&#9888; Confirm Stop', start: '&#9888; Confirm Start' };
  return new Promise((resolve, reject) => {
    $('action-confirm-title').innerHTML = titles[action] || '&#9888; Confirm Action';
    $('action-confirm-msg').innerHTML   = messages[action] || `Are you sure you want to ${esc(action)} ${esc(serverName)}?`;
    openModal('action-confirm-modal');
    $('action-confirm-cancel').onclick  = () => { closeModal('action-confirm-modal'); reject(new Error('cancelled')); };
    $('action-confirm-proceed').onclick = () => { closeModal('action-confirm-modal'); resolve(); };
  });
}

// ── Service restart: warning, then (after admin check) type-the-name final confirmation ───────────
function showServiceWarning({ serverName, display, name, status, critical }) {
  const verb = status === 'Running' ? 'restart' : 'start';
  return new Promise((resolve, reject) => {
    $('action-confirm-title').innerHTML = `&#9888; Confirm service ${verb}`;
    $('action-confirm-msg').innerHTML =
      `You are about to <strong>${verb}</strong> the service <strong>${esc(display || name)}</strong> (${esc(name)}) on server <strong>${esc(serverName)}</strong>.<br><br>` +
      `<span style="display:block;margin-bottom:4px">&bull; Anything using this service will be interrupted while it restarts.</span>` +
      `<span style="display:block;margin-bottom:4px">&bull; Services that depend on it will be restarted too.</span>` +
      (critical ? `<span style="display:block;margin-bottom:4px;color:#b71c1c;font-weight:700">&bull; This is marked as a key service for this server.</span>` : '') +
      `<span style="display:block;margin-top:8px">You will be asked for your admin credentials for this server, then to confirm once more.</span>`;
    $('action-confirm-proceed').disabled = false;
    openModal('action-confirm-modal');
    $('action-confirm-cancel').onclick  = () => { closeModal('action-confirm-modal'); reject(new Error('cancelled')); };
    $('action-confirm-proceed').onclick = () => { closeModal('action-confirm-modal'); resolve(); };
  });
}

function showTypedConfirm({ serverName, name, verb }) {
  return new Promise((resolve, reject) => {
    const btn = $('action-confirm-proceed');
    $('action-confirm-title').innerHTML = '&#9888; Final confirmation';
    $('action-confirm-msg').innerHTML =
      `Admin access confirmed. To ${esc(verb)} <strong>${esc(name)}</strong> on <strong>${esc(serverName)}</strong> now, type the service name below.` +
      `<input type="text" id="svc-typed-confirm" class="input-full" style="margin-top:12px" autocomplete="off" placeholder="${esc(name)}">`;
    btn.disabled = true;
    openModal('action-confirm-modal');
    const input = $('svc-typed-confirm');
    input.addEventListener('input', () => { btn.disabled = input.value.trim() !== name; });
    setTimeout(() => input.focus(), 50);
    const done = ok => { btn.disabled = false; closeModal('action-confirm-modal'); ok ? resolve(input.value.trim()) : reject(new Error('cancelled')); };
    $('action-confirm-cancel').onclick = () => done(false);
    btn.onclick = () => { if (input.value.trim() === name) done(true); };
  });
}

// ── Host Server Warning Modal ─────────────────────────────────────────────────
function showHostWarning() {
  return new Promise((resolve, reject) => {
    openModal('host-warn-modal');
    $('host-warn-cancel').onclick  = () => { closeModal('host-warn-modal'); reject(new Error('cancelled')); };
    $('host-warn-proceed').onclick = () => { closeModal('host-warn-modal'); resolve(); };
  });
}

// ── Auto-refresh every 15 minutes ────────────────────────────────────────────
setInterval(() => {
  if (state.page === 'fleet') {
    state.cache.fleet.clear();
    FleetPage.load();
  } else if (state.page === 'subnet') {
    const { provider, group } = state.nav;
    state.cache.subnets.delete(`${provider}:${group}`);
    SubnetPage.load(provider, group);
  }
}, 15 * 60 * 1000);

// ── Boot ──────────────────────────────────────────────────────────────────────
window.App = { connectHost, navigateTo, toast, api, state, showAdminModal, showHostWarning, showActionConfirm, showServiceWarning, showTypedConfirm, addActionLog, openModal, closeModal, esc, show, hide };
init();
