'use strict';

const sessions = require('../sessions');

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = auth.slice(7);
  const session = sessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
  if (session.credentials?.expiration) {
    const msLeft = new Date(session.credentials.expiration).getTime() - Date.now();
    if (msLeft < 0) {
      sessions.delete(token);
      return res.status(401).json({ error: 'AWS credentials expired — please sign in again' });
    }
    if (msLeft < 5 * 60 * 1000) res.setHeader('X-Credentials-Expiring', 'true');
  }
  req.sessionData = session;
  next();
}

module.exports = { requireAuth };
