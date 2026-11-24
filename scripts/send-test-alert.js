'use strict';
// Sends one test email through the alert SMTP settings in .env:  node scripts/send-test-alert.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('../server/services/alertService').sendTest()
  .then(() => console.log(`Test email sent to ${process.env.ALERT_TO || '(ALERT_TO not set)'}`))
  .catch(err => { console.error(`Failed: ${err.message}`); process.exit(1); });
