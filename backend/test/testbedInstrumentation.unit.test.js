'use strict';

/**
 * Multi-machine testbed support: peer addresses from settings, and the
 * experiment timing trace. Both are off by default; these tests pin that the
 * defaults are unchanged and that the traced path behaves like the library's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const trace = require('../src/util/trace');
const config = require('../src/config');
const gateway = require('../src/fabric/gateway');

describe('testbed instrumentation', () => {
  describe('peer addresses', () => {
    it('keeps every localhost peer address when FABRIC_PEER_ENDPOINTS is unset', () => {
      expect(config.ORG_CONFIG.police.peerEndpoint).to.equal('localhost:7051');
      expect(config.ORG_CONFIG.audit.peerEndpoint).to.equal('localhost:11051');
      expect(Object.keys(config.ORG_CONFIG)).to.deep.equal(
        ['police', 'forensics', 'prosecution', 'court', 'audit']
      );
    });

    it('accepts host:port overrides for known organizations only', () => {
      const orgs = { police: {}, audit: {} };
      expect(config.parsePeerEndpoints('', orgs)).to.deep.equal({});
      expect(config.parsePeerEndpoints('{"police":"peer0.police.example.com:7051"}', orgs))
        .to.deep.equal({ police: 'peer0.police.example.com:7051' });
      expect(() => config.parsePeerEndpoints('{"ai":"x:1"}', orgs)).to.throw(/unknown organization/);
      expect(() => config.parsePeerEndpoints('{"police":"no-port"}', orgs)).to.throw(/host:port/);
      expect(() => config.parsePeerEndpoints('[1]', orgs)).to.throw(/JSON object/);
      expect(() => config.parsePeerEndpoints('not json', orgs)).to.throw(/JSON object/);
    });
  });

  describe('trace', () => {
    let dir;
    let file;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-trace-'));
      file = path.join(dir, 'trace.jsonl');
    });

    afterEach(async () => {
      await trace.close();
      trace.configure('');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes nothing while it is off', async () => {
      trace.configure('');
      trace.emit('ignored', { a: 1 });
      await trace.close();
      expect(fs.existsSync(file)).to.equal(false);
    });

    it('appends one JSON line per event with rounded durations', async () => {
      trace.configure(file);
      trace.emit('step', { ms: 1.23456789, requestId: 'REQ-1' });
      trace.emit('step', { ms: 2 });
      await trace.close();
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).to.have.length(2);
      expect(lines[0]).to.include({ event: 'step', ms: 1.235, requestId: 'REQ-1' });
      expect(lines[0].at).to.be.a('number');
      expect(lines[1].ms).to.equal(2);
    });
  });

  describe('staged submit', () => {
    let dir;
    let file;

    function fakeContract(status) {
      const calls = [];
      return {
        calls,
        newProposal(fn, options) {
          calls.push(['newProposal', fn, options]);
          return {
            async endorse() {
              calls.push(['endorse']);
              return {
                async submit() {
                  calls.push(['submit']);
                  return {
                    async getStatus() { calls.push(['getStatus']); return status; },
                    getResult() { return Buffer.from('{"ok":true}'); },
                  };
                },
              };
            },
          };
        },
      };
    }

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-staged-'));
      file = path.join(dir, 'trace.jsonl');
      trace.configure(file);
    });

    afterEach(async () => {
      await trace.close();
      trace.configure('');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('endorses, submits and waits for the commit, then returns the result', async () => {
      const contract = fakeContract({
        transactionId: 'abc123', blockNumber: 7n, code: 0, successful: true,
      });
      const result = await gateway.submitStaged(contract, 'AccessContract', 'CreateAccessRequest', {
        arguments: ['REC-1', '{}'],
      });
      expect(Buffer.from(result).toString()).to.equal('{"ok":true}');
      expect(contract.calls.map((call) => call[0]))
        .to.deep.equal(['newProposal', 'endorse', 'submit', 'getStatus']);
      await trace.close();
      const [line] = fs.readFileSync(file, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
      expect(line).to.include({
        event: 'fabric.submit', fn: 'CreateAccessRequest', arg0: 'REC-1', txId: 'abc123',
        blockNumber: '7', successful: true,
      });
      for (const key of ['endorseMs', 'ordererSubmitMs', 'commitWaitMs', 'totalMs']) {
        expect(line[key]).to.be.a('number').and.to.be.at.least(0);
      }
    });

    it('throws the library CommitError on an unsuccessful commit status', async () => {
      const contract = fakeContract({
        transactionId: 'def456', blockNumber: 8n, code: 11, successful: false,
      });
      try {
        await gateway.submitStaged(contract, 'AccessContract', 'SubmitAuditorDecision', {
          arguments: ['REQ-1', 'FORCE_ALLOW', 'ALLOW', ''],
        });
        expect.fail('expected a CommitError');
      } catch (error) {
        expect(error.name).to.equal('CommitError');
        expect(error.code).to.equal(11);
        expect(error.transactionId).to.equal('def456');
      }
    });
  });
});
