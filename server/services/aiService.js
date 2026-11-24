'use strict';

/**
 * aiService.js
 * ────────────
 * Turns stored history + forecasts into (a) a ranked fleet view and (b) a
 * an AI-written diagnosis for a single server.
 *
 * The AI only *suggests*.  Recommended actions must reference IDs from
 * scripts.json; nothing here executes anything.
 *
 * Env
 *   AI_API_URL               the AI service's endpoint                    } all three needed for
 *   AI_API_KEY               its API key                                  } /analyze and Explain;
 *   AI_MODEL                 the model name the service expects           } forecasts work without
 *   AI_API_FORMAT            "chat" (default: chat-completions style, used by most services
 *                            and gateways) or "messages" (messages style)
 *   AI_API_KEY_HEADER        header that carries the key; default "Authorization: Bearer"
 *                            for chat and "x-api-key" for messages (e.g. "api-key")
 *   AI_API_HEADERS           any extra headers the service needs, as JSON
 *   AI_CACHE_MINUTES         reuse an analysis for an unchanged situation (15)
 *   AI_HOURLY_BUDGET         max AI calls per hour (30)
 *   AI_REDACT_HOSTNAMES      "true" → send server-N instead of real names
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const store = require('./historyStore');
const { analyze } = require('./forecast');
const vmcService = require('./vmcService');
const { hostOf, fqdnOf, osOf } = require('./hostName');
const { loadServers, loadPos } = require('./excelConfig');

const API_URL   = process.env.AI_API_URL || '';
const MODEL     = process.env.AI_MODEL || '';
const API_FORMAT = (process.env.AI_API_FORMAT || 'chat').toLowerCase() === 'messages' ? 'messages' : 'chat';
const apiKey    = () => process.env.AI_API_KEY || '';
const CACHE_MS  = parseInt(process.env.AI_CACHE_MINUTES || '15', 10) * 60 * 1000;
const BUDGET    = parseInt(process.env.AI_HOURLY_BUDGET || '30', 10);
const REDACT_HOSTS = process.env.AI_REDACT_HOSTNAMES === 'true';
const SCRIPTS_PATH = path.resolve(__dirname, '../config/scripts.json');


function isConfigured() { return !!(apiKey() && API_URL && MODEL); }

const NOT_CONFIGURED = 'AI is not configured (set AI_API_URL, AI_API_KEY and AI_MODEL)';

function extraHeaders() {
  if (!process.env.AI_API_HEADERS) return {};
  try { return JSON.parse(process.env.AI_API_HEADERS); } catch { return {}; }
}

/** One request to the configured AI service; returns its reply text.  Suggest-only callers. */
async function callAI({ system, user, maxTokens }) {
  const keyHeader = process.env.AI_API_KEY_HEADER;
  const headers = { 'content-type': 'application/json', ...extraHeaders() };
  let body;
  if (API_FORMAT === 'messages') {
    headers[keyHeader || 'x-api-key'] = apiKey();
    body = { model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  } else {
    if (keyHeader) headers[keyHeader] = apiKey(); else headers.authorization = `Bearer ${apiKey()}`;
    body = { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  }
  let resp;
  try {
    resp = await axios.post(API_URL, body, { headers, timeout: 60000 });
  } catch (err) {
    const d = err.response?.data;
    const e = new Error(`AI service error: ${d?.error?.message || d?.message || err.message}`); e.status = 502; throw e;
  }
  const d = resp.data || {};
  if (API_FORMAT === 'messages') return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return d.choices?.[0]?.message?.content || '';
}

function loadScripts() {
  try { return JSON.parse(fs.readFileSync(SCRIPTS_PATH, 'utf8').replace(/^﻿/, '')); }
  catch { return []; }
}

function findServer(id) {
  return loadServers().find(s => s.id === id) || loadPos().find(s => s.id === id) || null;
}

// ── Per-server analysis (statistical) ──────────────────────────────────────────
function analyzeServer(serverId) {
  const latest = store.recentSamples(serverId, 1)[0];
  if (!latest) return null;
  return {
    serverId,
    lastSampleAt: new Date(latest.ts).toISOString(),
    ...analyze({
      status:      latest.status,
      hourly:      store.hourlySeries(serverId, 28),   // 4 weeks → enough same-hour-of-week samples for the baseline
      diskByDrive: store.hourlyDiskSeries(serverId, 14),
      events:      store.events(serverId, 7, 200)
    })
  };
}

// ── Fleet view (cached, computed in the background) ────────────────────────────
// Analysing every server reads weeks of history (~0.3 s each, a minute for the fleet).  Doing that in
// one synchronous pass froze the whole app, so it is done a server at a time with a pause between,
// and callers get the last finished result (or a "computing" placeholder the first time).
const FLEET_REFRESH_MS = 15 * 60 * 1000;
let _fleet = { at: 0, data: null, computing: false };

const EMPTY_FLEET = () => ({
  generatedAt: null, computing: true, serversAnalyzed: 0, diskRisks: [], memoryRisks: [], cpuRisks: [], servers: [],
  summary: { highRisk: 0, mediumRisk: 0, diskBreach30d: 0, memoryLeaks: 0, memoryPressure: 0, cpuPressure: 0, anomalies: 0, flapping: 0 }
});

async function refreshFleet() {
  if (_fleet.computing) return;
  _fleet.computing = true;
  try {
    const names = new Map([...loadServers(), ...loadPos()].map(s => [s.id, s]));
    const items = [];
    for (const id of store.knownServerIds(2)) {
      const a = analyzeServer(id);
      if (a) {
        const cfg = names.get(id);
        items.push({ ...a, name: cfg?.name || id, host: hostOf(cfg), fqdn: fqdnOf(cfg), os: osOf(cfg), provider: cfg?.provider || null, group: cfg?.group || null });
      }
      await new Promise(r => setImmediate(r));   // let requests, health checks and alert timers run
    }
    items.sort((x, y) => y.risk.score - x.risk.score);

    const diskRisks = items.flatMap(i => i.disks
      .filter(d => d.daysTo95 != null && d.daysTo95 <= 30 && d.confidence !== 'low')
      .map(d => ({ serverId: i.serverId, name: i.name, host: i.host, fqdn: i.fqdn, os: i.os, provider: i.provider, group: i.group, ...d })))
      .sort((x, y) => x.daysTo95 - y.daysTo95);

    // One row per server with something to say about memory / CPU, most serious first.
    const SEV = { high: 0, medium: 1, low: 2 };
    const loadRows = (insightKey, loadKey, etaKey) => items
      .filter(i => i[insightKey] && i[loadKey])
      .map(i => ({
        serverId: i.serverId, name: i.name, host: i.host, fqdn: i.fqdn, os: i.os, provider: i.provider, group: i.group,
        kind: i[insightKey].kind, severity: i[insightKey].severity, text: i[insightKey].text,
        daysTo: i[insightKey][etaKey] ?? null,
        current: i[loadKey].current, avg24h: i[loadKey].avg24h, avg7d: i[loadKey].avg7d,
        peak24h: i[loadKey].peak24h, hoursHot24: i[loadKey].hoursHot24
      }))
      .sort((x, y) => SEV[x.severity] - SEV[y.severity] || y.hoursHot24 - x.hoursHot24 || y.avg24h - x.avg24h);
    const memoryRisks = loadRows('memInsight', 'memLoad', 'daysTo95');
    const cpuRisks = loadRows('cpuInsight', 'cpuLoad', 'daysTo90');

    _fleet = {
      at: Date.now(), computing: false,
      data: {
        generatedAt: new Date().toISOString(),
        computing: false,
        serversAnalyzed: items.length,
        summary: {
          highRisk:   items.filter(i => i.risk.score >= 50).length,
          mediumRisk: items.filter(i => i.risk.score >= 20 && i.risk.score < 50).length,
          diskBreach30d: diskRisks.length,
          memoryLeaks: items.filter(i => i.memory?.leakSuspected).length,
          memoryPressure: memoryRisks.length,
          cpuPressure: cpuRisks.length,
          anomalies: items.filter(i => i.anomalies.some(a => a.anomalous)).length,
          flapping: items.filter(i => i.flapping.flapping).length
        },
        diskRisks,
        memoryRisks,
        cpuRisks,
        servers: items
      }
    };
  } catch (err) {
    console.error(`[ai] fleet analysis failed: ${err.message}`);
    _fleet.computing = false;
  }
}

/** Last finished fleet analysis; starts a background refresh when it is stale (or `force`). Never blocks. */
function fleetInsights({ force = false } = {}) {
  const stale = !_fleet.data || Date.now() - _fleet.at > FLEET_REFRESH_MS;
  if ((stale || force) && !_fleet.computing) refreshFleet();
  return _fleet.data ? { ..._fleet.data, computing: _fleet.computing } : EMPTY_FLEET();
}

setTimeout(() => { if (store.init()) refreshFleet(); }, 20 * 1000).unref();   // warm it shortly after startup

// ── Redaction ──────────────────────────────────────────────────────────────────
function redact(text) {
  return String(text ?? '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(pass(?:word)?|pwd|secret|token|key)\s*[=:]\s*\S+/gi, '$1=[redacted]');
}

// ── AI call ──────────────────────────────────────────────────────────────────
const _cache = new Map();     // fingerprint → { at, result }
let _calls = [];              // timestamps of recent AI calls

/** Most recent still-valid analysis for a server, or null.  Never calls the AI. */
function cachedAnalysis(serverId) {
  let best = null;
  for (const [fp, v] of _cache) {
    if (fp.startsWith(serverId + '::') && Date.now() - v.at < 6 * 3600 * 1000 && (!best || v.at > best.at)) best = v;
  }
  return best ? best.result : null;
}

function budgetLeft() {
  const cutoff = Date.now() - 3600 * 1000;
  _calls = _calls.filter(t => t > cutoff);
  return BUDGET - _calls.length;
}

const SYSTEM_PROMPT = `You are a senior infrastructure reliability engineer helping an operations team triage monitoring alerts for an organisation's server estate (Windows and Linux; VMware, AWS, Azure, OCI; POS terminals).

You receive structured JSON: the current status, hourly metric history, statistical forecasts, recent status changes and (optionally) recent event-log errors.

Rules:
- Ground every statement in the supplied data. If the data does not support a conclusion, say so and lower confidence. Never invent metrics, hostnames or log lines.
- Distinguish symptom from cause. Prefer the simplest explanation that fits all the evidence.
- "recommendedActions" may only reference scriptId values from allowedScripts (or null for manual steps). You cannot run anything; a human will decide.
- Mark an action risk "high" if it restarts something or changes state.
- Set "escalate" true only if the evidence suggests customer-facing impact, data loss risk, or a breach within 48 hours.
- Be concise. Operators read this during an incident.

Reply with a single JSON object and nothing else:
{
  "summary": "1-2 sentences, plain language",
  "likelyCause": "string",
  "confidence": "high" | "medium" | "low",
  "evidence": ["short bullet citing a specific number or log line"],
  "prediction": "what happens next if nothing is done, with timeframe, or null",
  "recommendedActions": [{ "title": "string", "detail": "string", "scriptId": "string or null", "risk": "low" | "medium" | "high" }],
  "escalate": true | false
}`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchLogs(server) {
  if (server.os === 'linux' || server.provider === 'POS') return null;
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('log timeout')), 25000));
    const r = await Promise.race([vmcService.getLogs(server, 30), timeout]);
    return r.lines.slice(0, 30).map(l => ({ t: l.timestamp, m: redact(l.message).slice(0, 300) }));
  } catch { return null; }
}

/**
 * @returns {Promise<object>} { analysis, forecast, model, cached, generatedAt }
 */
async function analyzeWithAI(serverId, { includeLogs = true, force = false } = {}) {
  if (!isConfigured()) {
    const err = new Error(`${NOT_CONFIGURED}; forecasts still work`);
    err.status = 503; throw err;
  }
  const server = findServer(serverId);
  if (!server) { const e = new Error('Server not found'); e.status = 404; throw e; }

  const forecast = analyzeServer(serverId);
  if (!forecast) { const e = new Error('No history recorded for this server yet'); e.status = 404; throw e; }

  const fingerprint = [serverId, forecast.status, forecast.risk.reasons.join('|'), includeLogs].join('::');
  const hit = _cache.get(fingerprint);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };

  if (budgetLeft() <= 0) {
    const e = new Error(`AI hourly budget (${BUDGET} calls) reached — try again later`); e.status = 429; throw e;
  }

  const os = server.os === 'linux' ? 'linux' : 'windows';
  const allowedScripts = loadScripts()
    .filter(s => !s.os || s.os === os || s.os === 'any')
    .map(s => ({ scriptId: s.id, name: s.name, description: s.description, requiresConfirmation: !!s.requiresConfirmation }));

  const logs = includeLogs ? await fetchLogs(server) : null;
  const hourly = store.hourlySeries(serverId, 2).map(r => ({
    t: new Date(r.ts).toISOString().slice(0, 13) + 'Z',
    cpu: r.cpu != null ? Math.round(r.cpu) : null,
    mem: r.mem != null ? Math.round(r.mem) : null,
    disk: r.disk != null ? Math.round(r.disk) : null
  }));

  const label = REDACT_HOSTS ? 'server-1' : (server.name || server.id);
  const context = {
    server: { name: label, os, provider: server.provider, group: server.group, role: server.process ? 'POS terminal' : undefined },
    now: new Date().toISOString(),
    currentStatus: forecast.status,
    riskScore: forecast.risk,
    latestSamples: store.recentSamples(serverId, 5).map(s => ({
      t: new Date(s.ts).toISOString(), status: s.status, cpu: s.cpu, mem: s.mem_pct, disk: s.max_disk_pct, error: s.error ? redact(s.error) : null
    })),
    hourlyLast48h: hourly,
    forecasts: { disks: forecast.disks, memory: forecast.memory, anomalies: forecast.anomalies, flapping: forecast.flapping },
    statusChangesLast7d: store.events(serverId, 7, 20).map(e => ({
      t: new Date(e.ts).toISOString(), from: e.from_status, to: e.to_status, detail: e.detail ? redact(e.detail) : null
    })),
    recentEventLogErrors: logs,
    allowedScripts
  };

  _calls.push(Date.now());
  const text = await callAI({ system: SYSTEM_PROMPT, user: JSON.stringify(context), maxTokens: 1500 });
  const parsed = extractJson(text);

  // Enforce the safety rule: only known script IDs survive.
  const ok = new Set(allowedScripts.map(s => s.scriptId));
  parsed.recommendedActions = (Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions : [])
    .map(a => ({ ...a, scriptId: a.scriptId && ok.has(a.scriptId) ? a.scriptId : null }));

  const result = {
    serverId, model: MODEL, generatedAt: new Date().toISOString(), cached: false,
    logsIncluded: !!logs,
    usage: resp.data?.usage || null,
    analysis: parsed,
    forecast
  };
  _cache.set(fingerprint, { at: Date.now(), result });
  return result;
}

// ── Event-log explanation ──────────────────────────────────────────────────────
const LOG_PROMPT = `You are a senior Windows/VMware infrastructure engineer explaining event-log findings to an operations team so they do not have to read the raw log.
You receive JSON: a server name and OS, and grouped log findings (title, level, count, first/last time, one sample message, and a rule-based explanation where one exists).
Rules:
- Use only the supplied data. Never invent events, counts, hostnames or causes. If a message is cut off or unfamiliar, say so and lower your confidence.
- Say plainly whether the findings can be ignored, should be watched, or need action, and why.
- Prefer one underlying cause when several findings plausibly share it.
- Suggest concrete, low-risk checks first. You cannot run anything.
- Be brief: one or two sentences per field.
Reply with a single JSON object and nothing else:
{
  "headline": "1-2 sentences for someone who will not read the log",
  "assessment": "ignore" | "monitor" | "act",
  "confidence": "high" | "medium" | "low",
  "findings": [{ "title": "string", "severity": "low" | "medium" | "high", "meaning": "string", "suggestedAction": "string" }],
  "commonCause": "string or null"
}`;

const clip = (v, n) => redact(String(v ?? '')).slice(0, n);

/** The AI's plain-language read of the grouped log findings the log viewer already shows. Suggests only. */
async function explainLogs(serverId, { groups, headline } = {}) {
  if (!isConfigured()) { const e = new Error(NOT_CONFIGURED); e.status = 503; throw e; }
  const server = findServer(serverId);
  if (!server) { const e = new Error('Server not found'); e.status = 404; throw e; }
  if (!Array.isArray(groups) || !groups.length) { const e = new Error('No log findings to explain'); e.status = 400; throw e; }

  const findings = groups.slice(0, 12).map(g => ({
    title: clip(g.title, 120), level: clip(g.level, 12), source: clip(g.source, 80), count: Math.max(0, parseInt(g.count, 10) || 0),
    first: clip(g.first, 30), last: clip(g.last, 30), sampleMessage: clip(g.sample, 300),
    ruleBasedExplanation: g.known ? clip(g.meaning, 300) : null
  }));
  const fingerprint = ['logs', serverId, findings.map(f => `${f.title}:${f.count}`).join('|')].join('::');
  const hit = _cache.get(fingerprint);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };
  if (budgetLeft() <= 0) { const e = new Error(`AI hourly budget (${BUDGET} calls) reached — try again later`); e.status = 429; throw e; }

  _calls.push(Date.now());
  const text = await callAI({ system: LOG_PROMPT, maxTokens: 1000, user: JSON.stringify({ server: { name: REDACT_HOSTS ? 'server-1' : (server.name || server.id), os: server.os === 'linux' ? 'linux' : 'windows' }, now: new Date().toISOString(), summaryLine: clip(headline, 300), findings }) });
  const parsed = extractJson(text);
  const result = { serverId, model: MODEL, generatedAt: new Date().toISOString(), cached: false, explanation: parsed };
  _cache.set(fingerprint, { at: Date.now(), result });
  return result;
}

module.exports = { explainLogs, cachedAnalysis, isConfigured, analyzeServer, fleetInsights, analyzeWithAI, redact, MODEL, budgetLeft };
