#!/usr/bin/env node
'use strict';

// An additional loopback API for mobile development. It shares the existing Fabric configuration, but does
// not start worker replay or the expiry sweeper.
const { app } = require('../backend/src/server');
const port = Number(process.env.MOBILE_HOST_PORT || 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid MOBILE_HOST_PORT');
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Mobile development API: http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
