'use strict';

const axios = require('axios');

const TABLE_MAP = {
  incident:          '/api/now/v2/table/incident',
  service_request:   '/api/now/v2/table/sc_request',
  change_request:    '/api/now/v2/table/change_request'
};

function loadConfig() {
  try {
    const cfg = require('../config/servicenow.json');
    if (!cfg.instanceUrl || !cfg.username) return null;
    return cfg;
  } catch { return null; }
}

async function createTicket(params) {
  const cfg = loadConfig();
  if (!cfg) return null; // ServiceNow not configured — caller handles gracefully

  const {
    ticketType = 'incident',
    shortDescription,
    description,
    serverName,
    hyperscaler,
    subnet,
    actionType,
    scriptContent,
    requestedBy,
    urgency,
    impact
  } = params;

  const table = TABLE_MAP[ticketType] || TABLE_MAP.incident;
  const now   = new Date().toISOString();

  const descBody = [
    description || '',
    '',
    `Server:      ${serverName || 'N/A'}`,
    `Hyperscaler: ${hyperscaler || 'N/A'}`,
    `Subnet/Group: ${subnet || 'N/A'}`,
    `Action:      ${actionType || 'N/A'}`,
    `Initiated by: ${requestedBy || 'unknown'}`,
    `Timestamp:   ${now}`,
    scriptContent ? `\nScript content:\n${scriptContent}` : ''
  ].join('\n').trim();

  const payload = {
    short_description: shortDescription || `[${(actionType || 'action').toUpperCase()}] ${serverName}`,
    description:       descBody,
    caller_id:         requestedBy || cfg.username,
    assignment_group:  cfg.defaultAssignmentGroup || 'IT-Ops',
    category:          cfg.defaultCategory        || 'Infrastructure',
    urgency:           urgency || (actionType === 'stop' ? 1 : cfg.defaultUrgency || 3),
    impact:            impact  || cfg.defaultImpact || 3,
    state:             '2' // In Progress
  };

  const url = `${cfg.instanceUrl}${table}`;
  const r = await axios.post(url, payload, {
    auth: { username: cfg.username, password: cfg.password },
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 10000
  });

  const result = r.data?.result;
  const sysId  = result?.sys_id;
  const tableSlug = ticketType === 'incident' ? 'incident' : ticketType === 'service_request' ? 'sc_request' : 'change_request';

  return {
    number: result?.number,
    sysId,
    ticketType,
    url: `${cfg.instanceUrl}/nav_to.do?uri=${tableSlug}.do?sys_id=${sysId}`
  };
}

async function updateTicket(ticketType, sysId, outcome, errorDetail) {
  const cfg = loadConfig();
  if (!cfg || !sysId) return;

  const table = TABLE_MAP[ticketType] || TABLE_MAP.incident;
  const payload = {
    state:       outcome === 'Resolved' ? '6' : '8',
    close_notes: outcome === 'Resolved'
      ? `Action completed successfully at ${new Date().toISOString()}`
      : `Action failed: ${errorDetail || 'Unknown error'}`
  };

  await axios.patch(`${cfg.instanceUrl}${table}/${sysId}`, payload, {
    auth: { username: cfg.username, password: cfg.password },
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 10000
  });
}

module.exports = { createTicket, updateTicket };
