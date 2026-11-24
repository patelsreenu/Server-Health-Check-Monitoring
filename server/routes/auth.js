'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const {
  SSOOIDCClient, RegisterClientCommand,
  StartDeviceAuthorizationCommand, CreateTokenCommand
} = require('@aws-sdk/client-sso-oidc');
const {
  SSOClient, ListAccountsCommand,
  ListAccountRolesCommand, GetRoleCredentialsCommand
} = require('@aws-sdk/client-sso');
const { v4: uuidv4 }        = require('uuid');
const sessions               = require('../sessions');
const { verifyAdminPassword } = require('../services/ldapService');

const router = Router();
const pendingAuths = new Map();
const CLOUDS_PATH = path.resolve(__dirname, '../config/clouds.json');

function loadClouds() {
  return JSON.parse(fs.readFileSync(CLOUDS_PATH, 'utf8').replace(/^﻿/, ''));
}

// ── AWS SSO ───────────────────────────────────────────────────────────────────
router.post('/sso-start', async (req, res) => {
  try {
    const clouds = loadClouds();
    const rawUrl = process.env.AWS_SSO_START_URL || clouds.aws.ssoStartUrl || '';
    const ssoStartUrl = rawUrl.replace(/#.*$/, '').replace(/\/+$/, '');

    if (!ssoStartUrl || ssoStartUrl.includes('your-org')) {
      return res.status(400).json({ error: 'AWS SSO start URL not configured in clouds.json' });
    }

    const region = process.env.AWS_REGION || clouds.aws.region || 'us-east-1';
    const oidc   = new SSOOIDCClient({ region });

    const reg  = await oidc.send(new RegisterClientCommand({ clientName: 'health-monitor-v2', clientType: 'public' }));
    const auth = await oidc.send(new StartDeviceAuthorizationCommand({
      clientId: reg.clientId, clientSecret: reg.clientSecret, startUrl: ssoStartUrl
    }));

    const authId = uuidv4();
    pendingAuths.set(authId, {
      clientId: reg.clientId, clientSecret: reg.clientSecret,
      deviceCode: auth.deviceCode, region,
      expiresAt: Date.now() + auth.expiresIn * 1000,
      interval:  (auth.interval || 5) * 1000
    });
    setTimeout(() => pendingAuths.delete(authId), auth.expiresIn * 1000);

    res.json({
      authId,
      verificationUri:         auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      userCode:   auth.userCode,
      expiresIn:  auth.expiresIn,
      pollInterval: auth.interval || 5
    });
  } catch (err) {
    res.status(500).json({ error: err.cause?.message || err.message });
  }
});

router.get('/sso-poll/:authId', async (req, res) => {
  const pending = pendingAuths.get(req.params.authId);
  if (!pending) return res.status(404).json({ error: 'Authorization not found or expired' });
  if (Date.now() > pending.expiresAt) {
    pendingAuths.delete(req.params.authId);
    return res.status(400).json({ error: 'Authorization expired — please start again' });
  }
  const oidc = new SSOOIDCClient({ region: pending.region });
  try {
    const tokenResult = await oidc.send(new CreateTokenCommand({
      clientId: pending.clientId, clientSecret: pending.clientSecret,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      deviceCode: pending.deviceCode
    }));
    const sso = new SSOClient({ region: pending.region });
    const accounts = await sso.send(new ListAccountsCommand({ accessToken: tokenResult.accessToken }));
    if (!accounts.accountList?.length) return res.status(403).json({ error: 'No AWS accounts accessible' });

    const clouds    = loadClouds();
    const targetId  = process.env.AWS_ACCOUNT_ID || clouds.aws.accountId;
    const account   = (targetId && accounts.accountList.find(a => a.accountId === targetId)) || accounts.accountList[0];
    const roles     = await sso.send(new ListAccountRolesCommand({ accessToken: tokenResult.accessToken, accountId: account.accountId }));
    if (!roles.roleList?.length) return res.status(403).json({ error: 'No roles available' });

    const targetRole = clouds.aws.roleName;
    const role = (targetRole && roles.roleList.find(r => r.roleName === targetRole)) || roles.roleList[0];

    const credsResult = await sso.send(new GetRoleCredentialsCommand({
      accessToken: tokenResult.accessToken, accountId: account.accountId, roleName: role.roleName
    }));

    const sessionId = uuidv4();
    sessions.set(sessionId, {
      ssoAccessToken: tokenResult.accessToken,
      credentials: {
        accessKeyId:     credsResult.roleCredentials.accessKeyId,
        secretAccessKey: credsResult.roleCredentials.secretAccessKey,
        sessionToken:    credsResult.roleCredentials.sessionToken,
        expiration:      new Date(credsResult.roleCredentials.expiration * 1000).toISOString()
      },
      region:      pending.region,
      accountId:   account.accountId,
      accountName: account.accountName || account.accountId,
      roleName:    role.roleName,
      createdAt:   Date.now()
    });

    pendingAuths.delete(req.params.authId);
    res.json({
      status:      'authorized',
      token:       sessionId,
      accountName: account.accountName || account.accountId,
      roleName:    role.roleName,
      expiresAt:   new Date(credsResult.roleCredentials.expiration * 1000).toISOString()
    });
  } catch (err) {
    if (err.name === 'AuthorizationPendingException' || err.name === 'SlowDownException') return res.json({ status: 'pending' });
    if (err.name === 'ExpiredTokenException') { pendingAuths.delete(req.params.authId); return res.status(400).json({ error: 'Authorization expired' }); }
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) sessions.delete(auth.slice(7));
  res.json({ success: true });
});

router.get('/whoami', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const session = sessions.get(auth.slice(7));
  if (!session) return res.status(401).json({ error: 'Session not found' });
  res.json({ accountName: session.accountName, roleName: session.roleName, accountId: session.accountId, expiresAt: session.credentials?.expiration });
});

// ── Admin password verify (LDAP) ──────────────────────────────────────────────
router.post('/verify-admin', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const session = sessions.get(auth.slice(7));
  if (!session) return res.status(401).json({ error: 'Session not found' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  try {
    // Use the SSO username (strip domain if present) as the AD username
    const username = session.accountName || '';
    const result = await verifyAdminPassword(username, password);
    if (result.valid) {
      res.json({ valid: true, displayName: result.displayName });
    } else {
      res.status(401).json({ valid: false, error: result.error || 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

module.exports = router;
