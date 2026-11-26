'use strict';

require('dotenv').config();

const https      = require('https');
const http       = require('http');
const path       = require('path');
const os         = require('os');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const selfsigned = require('selfsigned');

const { requireAuth } = require('./middleware/auth');
const authRoute        = require('./routes/auth');
const fleetRoute       = require('./routes/fleet');
const subnetRoute      = require('./routes/subnet');
const serverDetailRoute = require('./routes/serverDetail');
const actionsRoute     = require('./routes/actions');
const aiRoute          = require('./routes/ai');
const toolsProxy = require('./routes/toolsProxy');
require('./services/historyStore').init();
require('./services/ticketWatcher').start();
require('./services/alertService').start();
require('./services/endpointMonitor').start();   // no-op unless AI_AUTO_TICKETS=dry-run|on

const app = express();

// ── Self-signed TLS cert ──────────────────────────────────────────────────────
const localIPs = Object.values(os.networkInterfaces())
  .flat().filter(i => i?.family === 'IPv4').map(i => i.address);
const hostname = os.hostname();

const pems = selfsigned.generate(
  [{ name: 'commonName', value: hostname }],
  {
    days: 365, keySize: 2048,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: hostname },
        { type: 7, ip: '127.0.0.1' },
        ...localIPs.map(ip => ({ type: 7, ip }))
      ]
    }]
  }
);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
// Original NetOps and PAN-OS portal pages, shown inside the Network / Firewall tabs.  Mounted before the
// JSON body parser so request bodies pass through to the tools untouched.
app.use('/tools', toolsProxy.proxy);
app.use(express.json({ limit: '1mb' }));

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../src')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v2/auth',    authRoute);
app.use('/api/v2/fleet',   requireAuth, fleetRoute);
app.use('/api/v2/subnet',  requireAuth, subnetRoute);
app.use('/api/v2/server',  requireAuth, serverDetailRoute);
app.use('/api/v2/actions', requireAuth, actionsRoute);
// /api/v2/tickets removed: actions no longer raise ServiceNow tickets. Incidents are raised only by a person
// clicking "Raise incident" (POST /api/v2/ai/raise), never automatically.
app.use('/api/v2/ai',      requireAuth, aiRoute);
app.post('/api/v2/network/frame-session', requireAuth, toolsProxy.frameSession);
app.get('/api/v2/network/enabled', requireAuth, toolsProxy.enabled);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '../src/index.html'));
  }
});

// ── HTTP → HTTPS redirect ─────────────────────────────────────────────────────
const HTTP_PORT  = process.env.HTTP_PORT  || 3180;
const HTTPS_PORT = process.env.PORT       || 3001;

http.createServer((req, res) => {
  const host = req.headers.host?.replace(`:${HTTP_PORT}`, `:${HTTPS_PORT}`);
  res.writeHead(301, { Location: `https://${host}${req.url}` });
  res.end();
}).listen(HTTP_PORT, () => console.log(`HTTP redirect  → :${HTTP_PORT}`));

// Certificate, in order of preference: a .pfx (TLS_PFX_PATH + TLS_PFX_PASSPHRASE, as exported from
// the Windows certificate store), a PEM pair (TLS_CERT_PATH + TLS_KEY_PATH), else the self-signed one.
const tlsFromFiles = process.env.TLS_PFX_PATH || process.env.TLS_CERT_PATH;
const tlsOptions = process.env.TLS_PFX_PATH
  ? { pfx: require('fs').readFileSync(process.env.TLS_PFX_PATH), passphrase: process.env.TLS_PFX_PASSPHRASE || undefined }
  : process.env.TLS_CERT_PATH
    ? { cert: require('fs').readFileSync(process.env.TLS_CERT_PATH), key: require('fs').readFileSync(process.env.TLS_KEY_PATH) }
    : { key: pems.private, cert: pems.cert };

https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
  console.log(`\nHealth Monitor running at https://${tlsFromFiles ? (process.env.PUBLIC_HOSTNAME || hostname) : 'localhost'}:${HTTPS_PORT}`);
  if (!tlsFromFiles) console.log('Using self-signed certificate — accept the browser warning.');
  console.log('\nBefore first use, fill in:');
  console.log('  .env                          — credentials, SMTP, AI (copy .env.example)');
  console.log('  server/config/clouds.json     — AWS SSO URL');
  console.log('  server/config/servers.json    — the servers to monitor');
  console.log('  server/config/ldap.json       — AD server + service account');
  console.log('  server/config/servicenow.json — ServiceNow instance URL + credentials\n');
});
