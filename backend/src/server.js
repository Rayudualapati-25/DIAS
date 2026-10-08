'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  PORT, CORS_ORIGIN, AUTH_ORG, AUTH_USER, DIAS_EXPIRY_SWEEP_SECONDS,
} = require('./config');
const fabric = require('./fabric/gateway');
const { createExpirySweeper } = require('./dias/expirySweeper');
const { reconcileStagedNotes } = require('./dias/auditorNotes');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const caseRoutes = require('./routes/cases');
const recordRoutes = require('./routes/records');
const accessRoutes = require('./routes/access');
const auditRoutes = require('./routes/audit');
const { accessLogger } = require('./middleware/accessLogger');
const { getDiasRuntime } = require('./dias/runtime');
const trace = require('./util/trace');

const app = express();

function isAllowedOrigin(origin) {
  // Non-browser clients and same-origin requests may omit Origin entirely.
  return !origin || origin === CORS_ORIGIN;
}

app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
}));
// A full-document upload is base64 JSON. The route still enforces a 5 MiB PDF
// limit; this slightly larger parser limit accounts for base64 expansion.
app.use(express.json({ limit: '8mb' }));

// Experiment timing only: one trace line per API call when DIAS_TRACE_FILE is set.
app.use('/api', (req, res, next) => {
  if (!trace.enabled()) return next();
  const startedAt = trace.now();
  res.on('finish', () => trace.emit('http', {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status: res.statusCode,
    startedAt,
    ms: trace.now() - startedAt,
  }));
  return next();
});

// Records authenticated API calls as Fabric transactions. Mounted before the
// routes so it sees every request; it submits after the response is sent.
app.use('/api', accessLogger);

app.get('/api/health', (req, res) => res.json({ success: true, data: 'ok', error: null }));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/records', recordRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/audit', auditRoutes);

// Serve the dashboard from the same origin as the API (no CORS, no build step).
app.use(express.static(path.resolve(__dirname, '..', '..', 'frontend')));

app.use('/api', (req, res) =>
  res.status(404).json({ success: false, data: null, error: 'not found' }));
app.use((req, res) => res.status(404).send('not found'));

function startServer(port = PORT) {
  // Recommendations a previous process left unfinished are answered again, so an
  // auditor is never left waiting for one that will not arrive.
  // Every stored review is brought under the current key first (design §10), so
  // that what the worker resumes is readable: older reviews in the clear are
  // encrypted, and reviews of an earlier key are re-sealed.
  const sealed = getDiasRuntime().store.sealWithCurrentKey();
  if (sealed.unreadable > 0) {
    // eslint-disable-next-line no-console
    console.error(`[dias] ${sealed.unreadable} stored review(s) cannot be opened with the configured keys`);
  }
  const resumed = getDiasRuntime().worker.resumePending();
  // Auditor notes a previous process staged before an unconfirmed decision are
  // settled against the ledger (design §11). It runs in the background: a ledger
  // that is not reachable yet leaves the notes staged and is logged.
  reconcileStagedNotes({
    store: getDiasRuntime().store,
    ledger: fabric,
    identity: { org: AUTH_ORG, fabricUser: AUTH_USER },
  }).then((summary) => {
    // eslint-disable-next-line no-console
    console.log(`[dias] staged auditor notes settled: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[dias] staged auditor notes could not be settled: ${error.message}`);
  });
  // Requests past their review deadline are closed on the ledger (design §8).
  createExpirySweeper({
    ledger: fabric,
    identity: { org: AUTH_ORG, fabricUser: AUTH_USER },
    intervalMs: DIAS_EXPIRY_SWEEP_SECONDS * 1000,
  }).start();
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`DIAS backend listening on http://localhost:${port}`
      + ` (LLM recommendations resumed: ${resumed}; reviews encrypted: ${sealed.encrypted},`
      + ` re-sealed: ${sealed.resealed}, unreadable: ${sealed.unreadable})`);
  });
}

if (require.main === module) startServer();

module.exports = { app, startServer, isAllowedOrigin };
