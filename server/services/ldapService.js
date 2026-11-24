'use strict';

const ldap = require('ldapjs');
const path = require('path');

function resolveEnvRefs(cfg) {
  return Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => [
      k,
      typeof v === 'string' ? v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '') : v
    ])
  );
}

function loadConfig() {
  try {
    return resolveEnvRefs(require('../config/ldap.json'));
  } catch {
    return null;
  }
}

function createClient(url) {
  return ldap.createClient({
    url,
    timeout:        5000,
    connectTimeout: 5000,
    tlsOptions:     { rejectUnauthorized: false }
  });
}

function bindAsync(client, dn, password) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function unbindAsync(client) {
  return new Promise(resolve => {
    client.unbind(() => resolve());
  });
}

function searchAsync(client, base, opts) {
  return new Promise((resolve, reject) => {
    client.search(base, opts, (err, res) => {
      if (err) return reject(err);
      const entries = [];
      res.on('searchEntry', e => entries.push(e.object));
      res.on('error', reject);
      res.on('end', () => resolve(entries));
    });
  });
}

async function tryServer(serverUrl, cfg, username, password) {
  const client = createClient(serverUrl);

  try {
    // Bind with service account first to find the user's DN
    await bindAsync(client, cfg.serviceAccount, cfg.servicePassword);

    // Search for the user
    const sAMAccountName = username.includes('@') ? username.split('@')[0] : username;
    const entries = await searchAsync(client, cfg.baseDN, {
      scope:  'sub',
      filter: `(sAMAccountName=${sAMAccountName})`,
      attributes: ['dn', 'displayName', 'mail']
    });

    if (!entries.length) {
      await unbindAsync(client);
      return { valid: false, error: `User "${sAMAccountName}" not found in Active Directory` };
    }

    const userDN = entries[0].dn;
    await unbindAsync(client);

    // Bind as the user to verify their password
    const verifyClient = createClient(serverUrl);
    try {
      await bindAsync(verifyClient, userDN, password);
      await unbindAsync(verifyClient);
      return { valid: true, displayName: entries[0].displayName || sAMAccountName };
    } catch {
      await unbindAsync(verifyClient).catch(() => {});
      return { valid: false, error: 'Invalid password' };
    }
  } catch (err) {
    client.destroy();
    throw err;
  }
}

async function verifyAdminPassword(username, password) {
  const cfg = loadConfig();
  if (!cfg || !cfg.servicePassword) {
    return { valid: false, error: 'LDAP not configured — set LDAP_SERVICE_PASSWORD in .env and update serviceAccount in server/config/ldap.json' };
  }

  const primary  = `ldap://${cfg.primaryServer}:${cfg.port || 389}`;
  const fallback = cfg.fallbackServer ? `ldap://${cfg.fallbackServer}:${cfg.port || 389}` : null;

  try {
    return await tryServer(primary, cfg, username, password);
  } catch (primaryErr) {
    if (!fallback) return { valid: false, error: primaryErr.message };
    try {
      return await tryServer(fallback, cfg, username, password);
    } catch (fallbackErr) {
      return { valid: false, error: `AD unreachable: ${fallbackErr.message}` };
    }
  }
}

module.exports = { verifyAdminPassword };
