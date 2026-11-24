'use strict';

const vmcService      = require('./vmcService');
const linuxService    = require('./linuxService');
const { probeServer } = require('./tcpProbe');
const historyStore    = require('./historyStore');

const _cache    = new Map();   // serverId → { health, probe, fetchedAt }
const _inFlight = new Map();   // serverId → Promise  (deduplicates concurrent requests)

const CACHE_TTL_MS     = 3 * 60 * 1000;   // 3 min
const POS_CACHE_TTL_MS = 30 * 1000;       // 30 s  — POS process status near-realtime

// ── Global concurrency semaphore ──────────────────────────────────────────────
// Caps total concurrent PowerShell processes across ALL providers/fleets.
// Fleet health calls are staggered 20 s apart per provider (fleet.js browser-side)
// so each provider's background cycle starts independently.
const MAX_CONCURRENT = 10;
let   _running = 0;
const _waitQueue = [];

function _semAcquire() {
  if (_running < MAX_CONCURRENT) { _running++; return Promise.resolve(); }
  return new Promise(res => _waitQueue.push(res));
}

function _semRelease() {
  if (_waitQueue.length > 0) { _waitQueue.shift()(); }
  else                        { _running--; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isFresh(serverId) {
  const c = _cache.get(serverId);
  if (c == null) return false;
  const ttl = c.health?.provider === 'POS' ? POS_CACHE_TTL_MS : CACHE_TTL_MS;
  return (Date.now() - c.fetchedAt) < ttl;
}

async function withRetry(fn, retries = 2, delayMs = 5000) {
  try { return await fn(); }
  catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// ── Core refresh (semaphore-guarded) ─────────────────────────────────────────
async function _doRefresh(server) {
  await _semAcquire();
  try {
    const service = server.os === 'linux' ? linuxService : vmcService;
    const [healthRes, probeRes] = await Promise.allSettled([
      withRetry(() => service.getServerHealth(server)),
      probeServer(server)
    ]);
    const health = healthRes.status === 'fulfilled'
      ? healthRes.value
      : { ...server, status: 'error', state: 'unknown', error: healthRes.reason?.message };
    const probe = probeRes.status === 'fulfilled'
      ? probeRes.value
      : { winrm: 'down', rdp: 'down' };
    _cache.set(server.id, { health, probe, fetchedAt: Date.now() });
    historyStore.record(server, health, probe);   // never throws
  } finally {
    _semRelease();
  }
}

function refreshOne(server) {
  if (_inFlight.has(server.id)) return _inFlight.get(server.id);
  const p = _doRefresh(server).finally(() => _inFlight.delete(server.id));
  _inFlight.set(server.id, p);
  return p;
}

// ── Background refresh ────────────────────────────────────────────────────────
// Each provider (vmc, onprem, azure, pos) runs its own continuous refresh
// cycle, independent of API calls.  The cycle refreshes all stale servers
// for that provider, then waits (TTL - 30 s) before running again.
// Both fleet and subnet API handlers simply read from _cache — they always
// see the same snapshot and are therefore always consistent with each other.

const _bgStarted   = new Set();   // providers whose cycle is already running
const _bgServers   = new Map();   // provider → server list (updated on each API call)
const _bgRunning   = new Set();   // providers with a cycle currently in progress

async function _runCycle(provider) {
  if (_bgRunning.has(provider)) return;       // prevent concurrent cycles
  _bgRunning.add(provider);
  try {
    const servers = _bgServers.get(provider) || [];
    const stale   = servers.filter(s => !isFresh(s.id));

    if (stale.length > 0) {
      const list = stale.slice().sort(() => Math.random() - 0.5);
      let next = 0;
      async function worker() {
        while (next < list.length) await refreshOne(list[next++]);
      }
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, list.length) }, worker));
    }
  } finally {
    _bgRunning.delete(provider);
  }
  // Schedule the next cycle just before TTL expires so data is always fresh.
  setTimeout(() => _runCycle(provider), CACHE_TTL_MS - 30_000);
}

// Called by fleet health routes on every request so the server list stays
// current.  Starts the background cycle the first time it is called for a
// given provider; subsequent calls only update the server list.
function startBackgroundRefresh(provider, servers) {
  _bgServers.set(provider, servers);          // keep server list current
  if (_bgStarted.has(provider)) return;       // cycle already running
  _bgStarted.add(provider);
  // First cycle fires after initial TTL — by then ensure() has already
  // populated the cache from cold-start, so the first cycle only refreshes
  // servers whose entries have aged past TTL.
  setTimeout(() => _runCycle(provider), CACHE_TTL_MS);
}

// Trigger an immediate background refresh cycle for a provider (non-blocking).
// If a cycle is already running it is a no-op — the running cycle will finish
// naturally.  Used by the fleet manual refresh button.
function triggerRefresh(provider) {
  _runCycle(provider);
}

// Force-clear cache for a specific set of servers and re-fetch them
// synchronously.  Used by the subnet manual refresh button where the server
// set is small (one group, typically 10–30 servers) so the wait is short.
async function forceRefreshServers(servers, limit = 10) {
  for (const s of servers) _cache.delete(s.id);
  return ensure(servers, limit);
}

// ── Public API ────────────────────────────────────────────────────────────────

// Used by fleet health endpoints on cold-start: waits for servers that have
// never been seen (no cache entry), returns current cache for everything else.
// Stale servers are handled exclusively by the background refresh cycle so
// that API responses are always fast and fleet + subnet always read the same
// cache snapshot.
async function ensure(servers, limit = 10) {
  const missing = servers.filter(s => !_cache.has(s.id));

  if (missing.length > 0) {
    // Shuffle so no server is consistently last in the queue.
    const list = missing.slice().sort(() => Math.random() - 0.5);
    let next = 0;
    async function worker() {
      while (next < list.length) await refreshOne(list[next++]);
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  }

  return servers.map(s => _cache.get(s.id) ?? null);
}

// Used by subnet detail endpoints.  Same behaviour as ensure() — reads cache,
// fetches only servers that have never been seen.
async function read(servers, limit = 10) {
  const neverSeen = servers.filter(s => !_cache.has(s.id) && !_inFlight.has(s.id));
  if (neverSeen.length > 0) {
    let next = 0;
    const list = neverSeen;
    async function worker() {
      while (next < list.length) await refreshOne(list[next++]);
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  }
  return servers.map(s => _cache.get(s.id) ?? null);
}

// Returns cached result for one server, or null if stale/missing.
function get(serverId) {
  return isFresh(serverId) ? (_cache.get(serverId) ?? null) : null;
}

module.exports = { ensure, read, get, startBackgroundRefresh, triggerRefresh, forceRefreshServers };
