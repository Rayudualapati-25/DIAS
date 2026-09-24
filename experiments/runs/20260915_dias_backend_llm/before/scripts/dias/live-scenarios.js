#!/usr/bin/env node
'use strict';

/**
 * Live DIAS acceptance scenarios against a deployed Fabric chaincode.
 *
 * Nothing here is mocked. Every assertion is made against committed ledger state
 * read back through the gateway, and every transaction id and block-bearing
 * lifecycle record is saved, so a claim in the report can be traced to a
 * transaction on the chain.
 *
 * The model is a real model, so a scenario that needs a particular
 * recommendation cannot demand one. The harness probes candidate requests, reads
 * what the model actually recommended, and routes each scenario to a request the
 * model's own answer makes possible. Scenarios that no candidate enabled are
 * reported as NOT EXERCISED rather than quietly skipped.
 *
 *   CHAINCODE=diasrecords node scripts/dias/live-scenarios.js --out <dir>
 */

const fs = require('fs');
const path = require('path');
const fabric = require('../../backend/src/fabric/gateway');
const config = require('../../backend/src/config');

const ACCESS = 'AccessContract';
const AUDIT = 'AuditContract';
const AUDITOR = Object.freeze({ org: 'audit', user: 'sp.north' });
const OTHER_AUDITOR = Object.freeze({ org: 'audit', user: 'dj.north' });
const POLL_MS = 500;
const AWAIT_TIMEOUT_MS = 300000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Who answers a committed request.
 *
 * By default the harness waits for a separately running listener. The scenario
 * runner replaces this with an in-process answerer, because scenarios I-L drive
 * deliberately broken and duplicated deliveries and must be the only answerer
 * while they do. Injecting it keeps both modes on one code path rather than
 * duplicating the submit-and-wait logic.
 */
let answerRequest = null;

function setAnswerer(fn) {
  answerRequest = fn;
}

/** Submit a request as one requester and wait until the model has answered. */
async function submitAndAwait(requester, recordId, body, justification, { timeoutMs = AWAIT_TIMEOUT_MS } = {}) {
  const created = await fabric.submitWithTransient(
    requester.org, requester.user, ACCESS, 'CreateAccessRequest',
    [recordId, JSON.stringify(body)],
    { justification: Buffer.from(justification, 'utf8') },
    fabric.ACCESS_QUERY_ENDORSERS
  );
  if (created.processingPath === 'dynamic-authorization') return created;
  if (answerRequest) {
    await answerRequest(created.requestId);
    return fabric.evaluate(requester.org, requester.user, ACCESS, 'GetRequest', created.requestId);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await fabric.evaluate(
      requester.org, requester.user, ACCESS, 'GetRequest', created.requestId);
    if (stored.status !== 'awaiting-recommendation') return stored;
    if (Date.now() > deadline) {
      throw new Error(`request ${created.requestId} was never answered within ${timeoutMs} ms`);
    }
    await sleep(POLL_MS);
  }
}

const review = (requestId) =>
  fabric.evaluate(AUDITOR.org, AUDITOR.user, ACCESS, 'GetAuditorReview', requestId);
const trail = (requestId) =>
  fabric.evaluate(AUDITOR.org, AUDITOR.user, AUDIT, 'GetRequestAuditTrail', requestId);

const decide = (requestId, decision, reason, validUntilUtc = '', who = AUDITOR) =>
  fabric.submit(who.org, who.user, ACCESS, 'SubmitAuditorDecision',
    requestId, decision, reason, validUntilUtc);

/** A scenario result, with the evidence that supports it. */
function outcome(id, title, expectation, checks, evidence) {
  const failed = checks.filter((check) => !check.ok);
  return {
    id, title, expectation,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    checks,
    evidence,
  };
}

const check = (name, ok, detail) => ({ name, ok: Boolean(ok), detail: String(detail) });

module.exports = {
  ACCESS, AUDIT, AUDITOR, OTHER_AUDITOR,
  check, decide, outcome, review, setAnswerer, sleep, submitAndAwait, trail,
  chaincode: config.CHAINCODE,
  writeReport(outDir, report) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'scenarios.json'), `${JSON.stringify(report, null, 2)}\n`);
  },
};
