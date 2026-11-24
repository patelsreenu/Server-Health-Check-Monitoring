'use strict';

/**
 * incidentDraft.js
 * ────────────────
 * Builds the pre-filled text for the "Raise incident" button.  Pure read:
 * never calls the AI and never touches ServiceNow.  If an AI analysis was
 * already run for the server (button on the detail page) it is included.
 *
 * Raising the ticket is a separate, explicit user action — see POST /ai/raise.
 */

const store = require('./historyStore');
const ai = require('./aiService');
const { forecastLines, aiLines, currentIncidents } = require('./ticketWatcher');
const { loadServers, loadPos } = require('./excelConfig');

const FOOTER = 'Draft prepared by Health Monitor AI from monitoring history. Verify before acting.';

function cfgOf(id) { return [...loadServers(), ...loadPos()].find(s => s.id === id) || null; }

function serverDraft(serverId) {
  const forecast = ai.analyzeServer(serverId);
  if (!forecast) return null;
  const s = cfgOf(serverId) || { id: serverId, name: serverId };
  const name = s.name || s.id;
  const bad = store.currentlyBad().find(b => b.serverId === serverId);
  const analysis = ai.cachedAnalysis(serverId);
  const findings = forecastLines(forecast);

  const headline = bad
    ? `${name} has been ${bad.status.toUpperCase()} for ${Math.round((Date.now() - bad.since) / 60000)} minutes (since ${new Date(bad.since).toISOString()}).`
    : `${name} is currently ${forecast.status}; risk score ${forecast.risk.score}/100 (${forecast.risk.reasons.join('; ') || 'no risk factors'}).`;

  const body = [
    headline, '',
    ...(analysis ? [...aiLines(analysis), ''] : ['(No AI diagnosis attached — use "Analyze with AI" first if you want one included.)', '']),
    ...(findings.length ? ['Trend findings:', ...findings.map(l => `  - ${l}`), ''] : []),
    FOOTER
  ].join('\n');

  const critical = bad?.status === 'critical' || forecast.status === 'critical';
  return {
    key: `server:${serverId}`,
    title: bad ? `${name} ${bad.status}` : `${name} — ${forecast.risk.reasons[0] || 'attention needed'}`,
    description: body,
    urgency: critical ? 2 : 3,
    impact: 3,
    serverName: name, provider: s.provider || null, group: s.group || null,
    aiIncluded: !!analysis
  };
}

function incidentDraft(key) {
  const inc = currentIncidents().find(i => i.key === key);
  if (!inc) return null;
  const body = [
    `${inc.servers.length} of ${inc.total} ${inc.provider} ${inc.group} servers (${inc.share}%) began failing within ${inc.spanMinutes} minutes of each other, starting ${inc.startedAt}.`,
    '',
    `Best guess (rule of thumb, not confirmed): ${inc.hint}`,
    '',
    'Affected servers:',
    ...inc.servers.map(m => `  - ${m.name} [${m.status}] since ${new Date(m.since).toISOString()}`),
    '',
    FOOTER
  ].join('\n');
  return {
    key: inc.key,
    title: `${inc.servers.length} servers failing in ${inc.provider} ${inc.group}`,
    description: body,
    urgency: inc.severity === 'major' ? 1 : 2,
    impact: inc.severity === 'major' ? 1 : 2,
    serverName: `${inc.servers.length} servers (${inc.group})`, provider: inc.provider, group: inc.group,
    aiIncluded: false
  };
}

/** A ticket raised from this key in the last 24 h, if any (duplicate warning). */
function recentlyRaised(key) {
  const last = store.lastAutoTicket(key);
  if (!last || last.mode !== 'manual') return null;
  if (Date.now() - last.opened_ts > 24 * 3600 * 1000) return null;
  return { number: last.number, url: last.url, raisedAt: new Date(last.opened_ts).toISOString() };
}

module.exports = { serverDraft, incidentDraft, recentlyRaised };
