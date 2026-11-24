'use strict';

const { Router } = require('express');
const ai    = require('../services/aiService');
const store = require('../services/historyStore');
const watcher = require('../services/ticketWatcher');
const draft = require('../services/incidentDraft');
const snService = require('../services/servicenowService');

const router = Router();

// GET /api/v2/ai/status
router.get('/status', (req, res) => {
  res.json({ aiConfigured: ai.isConfigured(), model: 'AI', callsRemainingThisHour: ai.budgetLeft() });
});

// GET /api/v2/ai/overview — fleet state counts, recent failures, and servers the monitor can't read
router.get('/overview', (req, res) => {
  try { res.json(require('../services/overview').build()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v2/ai/endpoints — web endpoint checks (config/endpoints.json): up/down, status code, response time
router.get('/endpoints', (req, res) => {
  try { res.json({ endpoints: require('../services/endpointMonitor').status() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v2/ai/overview/servers?status=monitored|healthy|warning|critical|unreachable — the servers behind a dashboard tile
router.get('/overview/servers', (req, res) => {
  try { res.json(require('../services/overview').listServers(String(req.query.status || 'monitored'))); }
  catch (err) { res.status(/Unknown/.test(err.message) ? 400 : 500).json({ error: err.message }); }
});

// GET /api/v2/ai/alerts — email-alert rules, delivery config and the alerts active right now
router.get('/alerts', (req, res) => res.json(require('../services/alertService').status()));

// GET /api/v2/ai/insights?limit=25&minRisk=0&refresh=1
// Fleet-wide ranked forecasts.  Statistical only — no AI call, no cost.
router.get('/insights', (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit || '25', 10), 500);
    const minRisk = parseInt(req.query.minRisk || '0', 10);
    const data = ai.fleetInsights({ force: req.query.refresh === '1' });
    res.json({
      ...data,
      servers: data.servers.filter(s => s.risk.score >= minRisk).slice(0, limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v2/ai/incidents — failures that started together, collapsed into one incident per group
router.get('/incidents', (req, res) => {
  try {
    res.json({ generatedAt: new Date().toISOString(), incidents: watcher.currentIncidents() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v2/ai/auto-tickets — what the watcher has created (or would create in dry-run)
router.get('/auto-tickets', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json({
    mode: watcher.mode,
    tickets: store.listAutoTickets(limit).map(t => ({
      ...t, opened: new Date(t.opened_ts).toISOString(), closed: t.closed_ts ? new Date(t.closed_ts).toISOString() : null
    }))
  });
});

// GET /api/v2/ai/draft/server/:id         prefilled incident text for one server
// GET /api/v2/ai/draft/incident?key=...   prefilled incident text for a correlated incident
// Read-only: builds text, never calls the AI, never contacts ServiceNow.
router.get('/draft/server/:id', (req, res) => {
  const d = draft.serverDraft(req.params.id);
  if (!d) return res.status(404).json({ error: 'No history recorded for this server yet' });
  res.json({ ...d, alreadyRaised: draft.recentlyRaised(d.key) });
});
router.get('/draft/incident', (req, res) => {
  const d = draft.incidentDraft(String(req.query.key || ''));
  if (!d) return res.status(404).json({ error: 'That incident is no longer active' });
  res.json({ ...d, alreadyRaised: draft.recentlyRaised(d.key) });
});

// POST /api/v2/ai/raise — the ONLY place this feature creates a ServiceNow incident.
// Called when a person clicks "Raise incident" in the dialog; nothing calls it automatically.
// body: { key, title, description, urgency, impact, serverName, provider, group, force? }
router.post('/raise', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  if (!b.key || !title || !description) return res.status(400).json({ error: 'key, title and description are required' });
  if (title.length > 160 || description.length > 8000) return res.status(400).json({ error: 'Title (160) or description (8000) too long' });

  const dup = draft.recentlyRaised(String(b.key));
  if (dup && !b.force) {
    return res.status(409).json({ error: `An incident was already raised for this in the last 24h (${dup.number || 'unknown'})`, alreadyRaised: dup });
  }

  const clamp = v => [1, 2, 3].includes(parseInt(v, 10)) ? parseInt(v, 10) : 3;
  const requestedBy = req.sessionData?.accountName || 'unknown';
  try {
    const ticket = await snService.createTicket({
      ticketType: 'incident',
      shortDescription: title,
      description,
      serverName: b.serverName, hyperscaler: b.provider, subnet: b.group,
      actionType: 'ai-assisted',
      requestedBy,
      urgency: clamp(b.urgency), impact: clamp(b.impact)
    });
    if (!ticket) return res.status(503).json({ error: 'ServiceNow is not configured — no incident was raised' });
    store.saveAutoTicket({ key: String(b.key), mode: 'manual', number: ticket.number, sysId: ticket.sysId, url: ticket.url, title, body: description });
    console.log(`[ai] incident ${ticket.number} raised by ${requestedBy} for ${b.key}`);
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(502).json({ error: `ServiceNow error: ${err.message}` });
  }
});

// GET /api/v2/ai/server/:id — forecasts + history for charts (statistical only)
router.get('/server/:id', (req, res) => {
  try {
    const a = ai.analyzeServer(req.params.id);
    if (!a) return res.status(404).json({ error: 'No history recorded for this server yet' });
    const days = Math.min(parseInt(req.query.days || '7', 10), 30);
    res.json({
      ...a,
      history: store.hourlySeries(req.params.id, days),
      diskHistory: store.hourlyDiskSeries(req.params.id, days),
      events: store.events(req.params.id, days, 100)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v2/ai/logs/:id/explain   body: { groups, headline } — the grouped findings the log viewer shows
router.post('/logs/:id/explain', async (req, res) => {
  try { res.json(await ai.explainLogs(req.params.id, req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /api/v2/ai/analyze/:id   body: { includeLogs?: boolean, force?: boolean }
// AI diagnosis for one server.  Suggests only — never executes.
router.post('/analyze/:id', async (req, res) => {
  try {
    const { includeLogs = true, force = false } = req.body || {};
    res.json(await ai.analyzeWithAI(req.params.id, { includeLogs, force }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
