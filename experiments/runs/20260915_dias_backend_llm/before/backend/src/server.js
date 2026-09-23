'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { PORT, CORS_ORIGIN } = require('./config');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const caseRoutes = require('./routes/cases');
const recordRoutes = require('./routes/records');
const accessRoutes = require('./routes/access');
const auditRoutes = require('./routes/audit');
const explainRoutes = require('./routes/explain');
const { accessLogger } = require('./middleware/accessLogger');

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
app.use('/api/explain', explainRoutes);

// Serve the dashboard from the same origin as the API (no CORS, no build step).
app.use(express.static(path.resolve(__dirname, '..', '..', 'frontend')));

app.use('/api', (req, res) =>
  res.status(404).json({ success: false, data: null, error: 'not found' }));
app.use((req, res) => res.status(404).send('not found'));

function startServer(port = PORT) {
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`crime-records backend listening on http://localhost:${port}`);
  });
}

if (require.main === module) startServer();

module.exports = { app, startServer, isAllowedOrigin };
