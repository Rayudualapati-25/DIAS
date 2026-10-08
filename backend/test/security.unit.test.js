'use strict';

/** Security configuration tests that do not require a running Fabric network. */

const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const { CORS_ORIGIN } = require('../src/config');
const { app, isAllowedOrigin } = require('../src/server');
const { generateEnrollmentSecret } = require('../src/fabric/ca');

const BACKEND_DIR = path.resolve(__dirname, '..');

function loadConfig(overrides, expression = "process.stdout.write('loaded')") {
  return spawnSync(process.execPath, ['-e', `require('./src/config');${expression}`], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'subprocess-test-jwt-secret',
      PORT: '',
      CORS_ORIGIN: '',
      ...overrides,
    },
  });
}

describe('security configuration', () => {
  it('fails fast when production has no JWT secret', () => {
    const result = loadConfig({ NODE_ENV: 'production', JWT_SECRET: '' });
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('JWT_SECRET is required when NODE_ENV=production');
  });

  it('retains a loudly warned fallback for local development only', () => {
    const result = loadConfig({ NODE_ENV: 'development', JWT_SECRET: '' });
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal('loaded');
    expect(result.stderr).to.contain('using a dev-only default');
  });

  it('defaults CORS to the local API origin and accepts an explicit origin', () => {
    const defaultResult = loadConfig(
      { PORT: '4111' },
      "process.stdout.write(require('./src/config').CORS_ORIGIN)"
    );
    const configuredResult = loadConfig(
      { CORS_ORIGIN: 'https://dashboard.example' },
      "process.stdout.write(require('./src/config').CORS_ORIGIN)"
    );

    expect(defaultResult.status).to.equal(0);
    expect(defaultResult.stdout).to.equal('http://localhost:4111');
    expect(configuredResult.status).to.equal(0);
    expect(configuredResult.stdout).to.equal('https://dashboard.example');
  });

  it('rejects a wildcard CORS configuration', () => {
    const result = loadConfig({ CORS_ORIGIN: '*' });
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('not "*"');
  });

  it('allows only mutually exclusive LLM and legacy policy modes', () => {
    const llm = loadConfig(
      { ACCESS_POLICY_MODE: 'llm-only' },
      "process.stdout.write(require('./src/config').ACCESS_POLICY_MODE)"
    );
    const legacy = loadConfig(
      { ACCESS_POLICY_MODE: 'legacy-baseline' },
      "process.stdout.write(require('./src/config').ACCESS_POLICY_MODE)"
    );
    const invalid = loadConfig({ ACCESS_POLICY_MODE: 'dual' });
    expect(llm.status).to.equal(0);
    expect(llm.stdout).to.equal('llm-only');
    expect(legacy.status).to.equal(0);
    expect(legacy.stdout).to.equal('legacy-baseline');
    expect(invalid.status).to.not.equal(0);
    expect(invalid.stderr).to.contain('ACCESS_POLICY_MODE');
  });

  it('resolves a relative agency vault path from the repository root', () => {
    const result = loadConfig(
      { AGENCY_VAULT_DIR: 'backend/data/agency-vault' },
      "process.stdout.write(require('./src/config').VAULT_DIR)"
    );

    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal(path.join(BACKEND_DIR, 'data', 'agency-vault'));
  });

  it('allows same-origin or originless requests and rejects other origins', () => {
    expect(isAllowedOrigin(undefined)).to.equal(true);
    expect(isAllowedOrigin(CORS_ORIGIN)).to.equal(true);
    expect(isAllowedOrigin('https://untrusted.example')).to.equal(false);
  });

  it('emits CORS headers only for the configured browser origin', async () => {
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    try {
      const { port } = server.address();
      const allowed = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Origin: CORS_ORIGIN },
      });
      const rejected = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Origin: 'https://untrusted.example' },
      });

      expect(allowed.headers.get('access-control-allow-origin')).to.equal(CORS_ORIGIN);
      expect(rejected.headers.get('access-control-allow-origin')).to.equal(null);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('Fabric CA enrolment secrets', () => {
  it('generates distinct URL-safe 256-bit secrets', () => {
    const first = generateEnrollmentSecret();
    const second = generateEnrollmentSecret();

    expect(first).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(second).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(second).to.not.equal(first);
  });
});
