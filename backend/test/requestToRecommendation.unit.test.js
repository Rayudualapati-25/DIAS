'use strict';

/**
 * From a committed request to the auditor's recommendation, inside the backend
 * (author's decision, 2026-10-08: there is no separate recommendation service).
 *
 * The contract settles a request that has a reusable authorization by itself.
 * For every other request the backend saves the off-chain review and asks the LLM
 * at once, in its own process, then signs the answer and commits it for the
 * auditor. These tests run the real composition root against a stand-in model
 * endpoint and a recording ledger.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const accessRouter = require('../src/routes/access');
const config = require('../src/config');
const { createDiasRuntime } = require('../src/dias/runtime');
const { validOutput } = require('./fixtures/diasFixtures');
const { input, verifies } = require('./fixtures/signedRecommendationFixtures');

const silent = Object.freeze({ log() {}, error() {} });
const JUSTIFICATION = input().justification;

/** The ledger's answer for a request it has just committed. */
function committedRequest(requestId, processingPath) {
  const { justification, ...facts } = input({ requestId });
  return {
    ...facts, recordId: 'FIR-1', requester: { username: 'insp.test' }, processingPath,
  };
}

/** A stand-in for the model server: answers every chat completion with `output`. */
function startModel(output) {
  const calls = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      }));
    });
  });
  const close = () => new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      calls, close, url: `http://127.0.0.1:${server.address().port}/v1`,
    }));
  });
}

function recordingLedger() {
  const submitted = [];
  return {
    submitted,
    submit: async (org, user, contract, fn, requestId, json) => {
      submitted.push([contract, fn, requestId]);
      return { commitmentId: `KAPPA-${requestId}`, txId: `tx-${requestId}`, ...JSON.parse(json) };
    },
    evaluate: async () => null,
  };
}

describe('from a request to the auditor recommendation, inside the backend', () => {
  let dir;
  let model;
  let ledger;
  let keyFile;

  const runtimeFor = (modelUrl, name) => createDiasRuntime({
    settings: {
      ...config,
      CHANNEL: 'diaschannel',
      DIAS_MODEL_URL: modelUrl,
      DIAS_REVIEW_STORE_DIR: path.join(dir, name),
      DIAS_RECOMMENDER_SIGNING_KEY_FILE: keyFile,
    },
    ledger,
    log: silent,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-request-'));
    keyFile = path.join(dir, 'signing.pem');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    model = await startModel(validOutput());
    ledger = recordingLedger();
  });

  afterEach(async () => {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks the LLM at once when no reusable authorization matched, then signs and commits its answer', async () => {
    const runtime = runtimeFor(model.url, 'reviews');
    const answer = accessRouter.answerCommittedRequest({
      request: committedRequest('REQ-21', 'auditor-review'),
      justification: JUSTIFICATION,
      runtime: () => runtime,
      log: silent,
    });
    expect(answer.status).to.equal(202);
    expect(answer.data).to.include({
      requestId: 'REQ-21', processingState: 'awaiting-auditor', automatic: false, recommendationState: 'pending',
    });

    // Nothing else starts the model call: no second request, no service, no token.
    await runtime.worker.idle();
    expect(model.calls.map((call) => `${call.method} ${call.url}`)).to.deep.equal(['POST /v1/chat/completions']);
    expect(model.calls[0].headers).to.not.have.property('authorization');
    expect(ledger.submitted).to.deep.equal([['AccessContract', 'CommitRecommendation', 'REQ-21']]);
    const entry = runtime.store.read('REQ-21');
    expect(entry).to.include({ recommendationState: 'committed', commitmentId: 'KAPPA-REQ-21' });
    expect(entry.recommendation).to.include({ generationStatus: 'OK', recommendation: 'ALLOW' });
    expect(verifies(runtime.signedRecommender, 'REQ-21', entry.commitment)).to.equal(true);
  });

  it('never asks the LLM when a reusable authorization granted the request', async () => {
    const runtime = runtimeFor(model.url, 'reviews');
    let runtimeReads = 0;
    const answer = accessRouter.answerCommittedRequest({
      request: committedRequest('REQ-22', 'dynamic-authorization'),
      justification: JUSTIFICATION,
      // The real runtime, so that touching it would reach the model and the ledger.
      runtime: () => { runtimeReads += 1; return runtime; },
      log: silent,
    });
    expect(answer.status).to.equal(201);
    expect(answer.data).to.include({ requestId: 'REQ-22', processingState: 'decided', automatic: true });
    expect(runtimeReads).to.equal(0);
    await runtime.worker.idle();
    expect(model.calls).to.deep.equal([]);
    expect(ledger.submitted).to.deep.equal([]);
    expect(runtime.store.read('REQ-22')).to.equal(null);
  });

  it('commits "no recommendation" for the auditor when the model server is not running', async () => {
    const stopped = await startModel(validOutput());
    await stopped.close();
    const runtime = runtimeFor(stopped.url, 'offline');
    const answer = accessRouter.answerCommittedRequest({
      request: committedRequest('REQ-23', 'auditor-review'),
      justification: JUSTIFICATION,
      runtime: () => runtime,
      log: silent,
    });
    expect(answer.status).to.equal(202);
    await runtime.worker.idle();
    const entry = runtime.store.read('REQ-23');
    expect(entry.recommendationState).to.equal('committed');
    expect(entry.recommendation).to.include({
      generationStatus: 'UNAVAILABLE', recommendation: null, errorCode: 'server_unreachable',
    });
    expect(ledger.submitted).to.deep.equal([['AccessContract', 'CommitRecommendation', 'REQ-23']]);
  });
});
