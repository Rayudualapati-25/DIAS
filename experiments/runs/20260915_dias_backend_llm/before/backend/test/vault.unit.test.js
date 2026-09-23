'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const BACKEND_DIR = path.resolve(__dirname, '..');

function runVaultScript(script, vaultDir) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'vault-test-secret',
      AGENCY_VAULT_DIR: vaultDir,
    },
  });
}

describe('off-chain PDF vault', () => {
  let vaultDir;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crn-pdf-vault-'));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('stores PDF bytes, reads them back, and returns a stable SHA-256 commitment', () => {
    const result = runVaultScript(`
      const vault = require('./src/storage/vault');
      const bytes = Buffer.from('%PDF-1.4\\nprototype');
      const saved = vault.saveDocument('police', 'REQ-1', bytes);
      const read = vault.readDocument(saved.offChainReference);
      process.stdout.write(JSON.stringify({ saved, readHash: read.currentHash,
        same: read.bytes.equals(bytes) }));
    `, vaultDir);
    expect(result.status, result.stderr).to.equal(0);
    const output = JSON.parse(result.stdout);
    expect(output.same).to.equal(true);
    expect(output.saved.contentHash).to.match(/^[0-9a-f]{64}$/);
    expect(output.readHash).to.equal(output.saved.contentHash);
    expect(output.saved.offChainReference).to.equal('vault-pdf://police/REQ-1');
  });

  it('rejects empty, non-PDF, oversized, and duplicate uploads', () => {
    const result = runVaultScript(`
      const vault = require('./src/storage/vault');
      const errors = [];
      for (const bytes of [Buffer.alloc(0), Buffer.from('not a pdf'),
        Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(vault.MAX_PDF_BYTES)])]) {
        try { vault.validatePdf(bytes); } catch (error) { errors.push(error.message); }
      }
      vault.saveDocument('police', 'REQ-1', Buffer.from('%PDF-1.4\\nfirst'));
      try {
        vault.saveDocument('police', 'REQ-1', Buffer.from('%PDF-1.4\\nsecond'));
      } catch (error) { errors.push(error.message); }
      process.stdout.write(JSON.stringify(errors));
    `, vaultDir);
    expect(result.status, result.stderr).to.equal(0);
    const errors = JSON.parse(result.stdout);
    expect(errors).to.have.length(4);
    expect(errors[0]).to.match(/empty/);
    expect(errors[1]).to.match(/not a PDF/);
    expect(errors[2]).to.match(/5 MiB/);
    expect(errors[3]).to.match(/already exists/);
  });
});
