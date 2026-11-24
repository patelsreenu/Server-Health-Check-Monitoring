'use strict';

// Host-name prefix → environment, used only when a server has no "group" set.
// Override with server/config/hostGroups.json: [{ "prefix": "PRD", "env": "Prod" }, ...]
const DEFAULT_PREFIX_MAP = [
  { prefix: 'PRD', env: 'Prod'  },
  { prefix: 'DEV', env: 'Dev'   },
  { prefix: 'TST', env: 'Test'  },
  { prefix: 'UAT', env: 'UAT'   },
  { prefix: 'INF', env: 'Infra' }
];
const PREFIX_MAP = (() => {
  try {
    const list = require('../config/hostGroups.json');
    return Array.isArray(list) ? list.map(e => ({ ...e, prefix: String(e.prefix || '').toUpperCase() })).filter(e => e.prefix) : DEFAULT_PREFIX_MAP;
  } catch { return DEFAULT_PREFIX_MAP; }
})();

// Consolidated environment groups — all Prod-prefixes → "Prod", all Test-prefixes → "Test"
const ENV_CONSOLIDATION = {
  'Prod':  { group: 'Prod',  env: 'Prod'  },
  'Dev':   { group: 'Dev',   env: 'Dev'   },
  'Infra': { group: 'Infra', env: 'Infra' },
  'Test':  { group: 'Test',  env: 'Test'  },
  'UAT':   { group: 'UAT',   env: 'UAT'   }
};

function getEnvGroup(hostname) {
  if (!hostname) return { group: 'Prod', env: 'Prod' };
  const h = hostname.toUpperCase();

  // Priority 1: prefix match
  for (const entry of PREFIX_MAP) {
    if (h.startsWith(entry.prefix)) {
      return ENV_CONSOLIDATION[entry.env] || { group: entry.env, env: entry.env };
    }
  }

  // Priority 2: keyword match
  if (h.includes('DEV'))  return { group: 'Dev',  env: 'Dev'  };
  if (h.includes('UAT'))  return { group: 'UAT',  env: 'UAT'  };
  if (h.includes('PRD'))  return { group: 'Prod', env: 'Prod' };

  // Priority 3: default
  return { group: 'Prod', env: 'Prod' };
}

function groupServersByEnv(servers) {
  const map = new Map();
  for (const server of servers) {
    let group, env;
    if (server.group) {
      group = server.group;
      env   = server.group;
    } else {
      const hostname = (server.host || server.id || '').split('.')[0].toUpperCase();
      ({ group, env } = getEnvGroup(hostname));
    }
    if (!map.has(group)) map.set(group, { group, env, account: server.account || '', servers: [] });
    map.get(group).servers.push(server);
  }
  const ORDER = ['Prod', 'Non-Prod', 'Test', 'Dev', 'UAT', 'Infra'];
  const result = [];
  for (const g of ORDER) {
    if (map.has(g)) result.push(map.get(g));
  }
  for (const [g, val] of map) {
    if (!ORDER.includes(g)) result.push(val);
  }
  return result;
}

module.exports = { getEnvGroup, groupServersByEnv };
