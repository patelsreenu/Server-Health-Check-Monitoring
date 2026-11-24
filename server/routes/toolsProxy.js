'use strict';

/**
 * toolsProxy.js
 * ─────────────
 * Serves the original NetOps NOC pages and the original PAN-OS Traffic Portal, unchanged, inside the
 * Health Monitor's Network Monitoring and Firewall Monitoring tabs:
 *
 *   /tools/network/...   → NETOPS_URL        (unset = tab hidden)
 *   /tools/firewall/...  → PANOS_PORTAL_URL  (unset = tab hidden)
 *
 * Going through the Health Monitor (instead of pointing an iframe at the tools' own ports) means the
 * pages load from the same address and certificate as the dashboard, sit behind its sign-in, and are
 * not blocked by the tools' own frame or certificate settings.  Everything the tools can do in their
 * own window still works here, including traffic search, CSV export and the NetOps admin pages.
 *
 * The only changes made on the way through:
 *   • the tools' pages call their API at "/api/..."; that is pointed at "/tools/<tool>/api/..." so it
 *     does not hit the Health Monitor's own /api;
 *   • frame-blocking headers from the tools are dropped (the dashboard sends its own, same-origin only).
 *
 * Sign-in: an iframe cannot send the dashboard's Bearer token, so the page first calls
 * POST /api/v2/network/frame-session, which puts the same token in an HttpOnly cookie limited to /tools.
 */

const http  = require('http');
const https = require('https');
const sessions = require('../sessions');

const TOOLS = {
  network:  { url: (process.env.NETOPS_URL || '').replace(/\/+$/, ''),
              rewrite: s => s
                .replace(/NOC\.API\s*=\s*window\.location\.origin\s*;/g, "NOC.API=window.location.origin+'/tools/network';")
                .replace(/(fetch\(\s*['"`])\/api\//g, '$1/tools/network/api/')
                .replace(/(href=["'])\/api\//g, '$1/tools/network/api/') },
  firewall: { url: (process.env.PANOS_PORTAL_URL || '').replace(/\/+$/, ''),
              rewrite: s => s
                .replace(/(['"`])\/api\//g, '$1/tools/firewall/api/')
                .replace(/(['"`])\/login(['"`])/g, '$1/tools/firewall/login$2') }
};

const COOKIE = 'hm_tools';

function insecureFor(base) {
  if (process.env.NETWORK_INSECURE_TLS != null) return /^(1|true|yes|on)$/i.test(process.env.NETWORK_INSECURE_TLS);
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(base).hostname); } catch { return false; }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function validSession(token) {
  const s = token && sessions.get(token);
  if (!s) return false;
  if (s.credentials?.expiration && new Date(s.credentials.expiration).getTime() < Date.now()) return false;
  return true;
}

// Pages from the tools use inline scripts and inline event handlers, which the dashboard's own policy
// blocks; this policy allows those but still keeps everything on this origin.
const TOOL_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const DROP_RESPONSE = new Set(['x-frame-options', 'content-security-policy', 'strict-transport-security',
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  'cross-origin-resource-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']);

function proxy(req, res) {
  const m = req.url.match(/^\/(network|firewall)(\/.*)?$/);
  const tool = m && TOOLS[m[1]];
  if (!tool || !tool.url) return res.status(404).send('Not configured');

  if (!validSession(readCookie(req, COOKIE))) {
    res.status(401).type('html').send('<p style="font:14px Arial;padding:20px">Your Health Monitor session has ended. Sign in again and reopen this tab.</p>');
    return;
  }
  if (!m[2]) return res.redirect(302, `/tools/${m[1]}/`);

  const target = new URL(tool.url + m[2]);
  const mod = target.protocol === 'https:' ? https : http;

  const headers = { ...req.headers };
  delete headers.host; delete headers.connection; delete headers['accept-encoding'];
  delete headers.origin; delete headers.referer;
  // Pass the tool's own cookies (e.g. NetOps admin), never the dashboard's.
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c && !c.startsWith(COOKIE + '='));
  if (cookies.length) headers.cookie = cookies.join('; '); else delete headers.cookie;
  headers['x-forwarded-for'] = req.ip;
  headers['x-forwarded-prefix'] = `/tools/${m[1]}`;

  const up = mod.request(target, {
    method: req.method, headers, timeout: 60000,
    rejectUnauthorized: !insecureFor(tool.url)
  }, upRes => {
    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_RESPONSE.has(k)) out[k] = v;
    if (out.location) {
      const loc = String(out.location);
      if (loc.startsWith(tool.url)) out.location = `/tools/${m[1]}` + loc.slice(tool.url.length);
      else if (loc.startsWith('/')) out.location = `/tools/${m[1]}` + loc;
    }
    out['content-security-policy'] = TOOL_CSP;
    out['x-frame-options'] = 'SAMEORIGIN';

    const type = String(upRes.headers['content-type'] || '');
    if (/text\/html|javascript/.test(type)) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.from(tool.rewrite(Buffer.concat(chunks).toString('utf8')), 'utf8');
        out['content-length'] = body.length;
        res.writeHead(upRes.statusCode, out);
        res.end(body);
      });
    } else {
      res.writeHead(upRes.statusCode, out);
      upRes.pipe(res);
    }
  });
  up.on('timeout', () => up.destroy(new Error('timed out')));
  up.on('error', err => {
    if (res.headersSent) return res.end();
    const name = m[1] === 'network' ? 'NetOps' : 'the PAN-OS portal';
    res.status(502).type('html').send(`<p style="font:14px Arial;padding:20px"><strong>Could not reach ${name}</strong> (${tool.url}): ${String(err.message).replace(/[<>&]/g, '')}.<br>Check that it is running on the jump box.</p>`);
  });
  req.pipe(up);
}

// POST /api/v2/network/frame-session (behind requireAuth): copy the session token into a cookie for /tools.
function frameSession(req, res) {
  const token = (req.headers.authorization || '').slice(7);
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/tools; HttpOnly; Secure; SameSite=Strict`);
  res.json({ ok: true, network: !!TOOLS.network.url, firewall: !!TOOLS.firewall.url });
}

module.exports = { proxy, frameSession };
