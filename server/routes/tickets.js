'use strict';

const { Router } = require('express');
const snService  = require('../services/servicenowService');

const router = Router();

// POST /api/v2/tickets — create a ticket
router.post('/', async (req, res) => {
  const {
    ticketType, shortDescription, description,
    serverName, hyperscaler, subnet, actionType,
    scriptContent, urgency, impact
  } = req.body;

  const requestedBy = req.sessionData?.accountName || 'unknown';

  try {
    const ticket = await snService.createTicket({
      ticketType: ticketType || 'incident',
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
    });

    if (!ticket) {
      return res.json({
        skipped: true,
        message: 'ServiceNow not configured — action will proceed without a ticket'
      });
    }

    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v2/tickets/:sysId — update ticket status after action completes
router.patch('/:sysId', async (req, res) => {
  const { ticketType, outcome, errorDetail } = req.body;
  try {
    await snService.updateTicket(ticketType || 'incident', req.params.sysId, outcome, errorDetail);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
