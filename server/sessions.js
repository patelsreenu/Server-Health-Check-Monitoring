'use strict';

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const expiry = session.credentials?.expiration
      ? new Date(session.credentials.expiration).getTime()
      : session.createdAt + 8 * 60 * 60 * 1000;
    if (now > expiry) sessions.delete(id);
  }
}, 5 * 60 * 1000);

module.exports = sessions;
