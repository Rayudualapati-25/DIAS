'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;
const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

describe('portal request history and blockchain workflow log', () => {
  let world;
  const read = (caller, method, limit = '100') => world.run(caller, world.nextTx('READ'),
    (ctx) => world.contracts.access[method](ctx, limit)).then(({ result }) => result);
  beforeEach(async () => { world = await createDiasWorld().seed(); });

  it('restores only the signing requester’s requests, including requests awaiting a decision', async () => {
    const { result: own } = await world.submit(CALLERS.inspector);
    await world.submit(CALLERS.constable);
    const entries = await read(CALLERS.inspector, 'QueryMyAccessRequests');
    expect(entries.map((item) => item.requestId)).to.deep.equal([own.requestId]);
    expect(entries[0]).to.include({ status: 'awaiting-auditor', recordId: 'FIR-1' });
    expect(JSON.stringify(entries)).to.not.include('Reviewing the FIR');
  });

  it('restores a committed decision after a new browser session without exposing the auditor note', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.decide(request.requestId, 'FORCE_DENY', 'ALLOW');
    const [entry] = await read(CALLERS.inspector, 'QueryMyAccessRequests');
    expect(entry).to.include({ status: 'denied', requestId: request.requestId });
    expect(entry.outcomeId).to.be.a('string');
    expect(entry).to.not.have.property('noteHash');
  });

  it('shows a pending request and its committed LLM recommendation to a reviewer', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' }));
    const [entry] = await read(CALLERS.auditor, 'QueryAccessWorkflowLog');
    expect(entry).to.include({ requestId: request.requestId, status: 'awaiting-auditor',
      llmRecommendation: 'DENY', generationStatus: 'OK', decision: null, outcome: null });
    expect(entry.dynamicAuthorizationCheck).to.include({ matched: false });
    expect(entry.recommendationTxId).to.be.a('string');
    expect(JSON.stringify(entry)).to.not.match(/Reviewing the FIR|"reason"|"justification"|"noteHash"/);
  });

  it('records automatic approval, the authorization check and bypass without pretending the LLM ran', async () => {
    const { result: first } = await world.submit(CALLERS.inspector);
    await world.decide(first.requestId, 'FORCE_ALLOW', 'DENY');
    const { result: reused } = await world.submit(CALLERS.inspector);
    const entries = await read(CALLERS.auditor, 'QueryAccessWorkflowLog');
    const entry = entries.find((item) => item.requestId === reused.requestId);
    expect(entry).to.include({ outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION',
      decision: null, llmRecommendation: null, recommendationTxId: null });
    expect(entry.dynamicAuthorizationCheck).to.include({ matched: true,
      authorizationId: reused.dynamicAuthorizationCheck.authorizationId });
    expect(entry.authorizationId).to.equal(reused.dynamicAuthorizationCheck.authorizationId);
  });

  // Every enrolled officer reads the access log in full.
  it('shows the workflow log, with names and case files, to every enrolled officer', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.decide(request.requestId, 'FORCE_DENY', 'DENY');
    for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst, CALLERS.prosecutor, CALLERS.auditor]) {
      const [entry] = await read(caller, 'QueryAccessWorkflowLog');
      expect(entry, caller.identityId).to.include({
        requestId: request.requestId, recordId: 'FIR-1', caseId: 'CASE-1', status: 'denied',
        decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED', outcome: 'DENIED',
        recommendationWithheld: false,
      });
      expect(entry.requester).to.deep.equal({ username: 'insp.test', organization: 'police', role: 'inspector' });
      expect(entry.auditor).to.deep.equal({ username: 'sp.test', role: 'sp' });
      expect(JSON.stringify(entry)).to.not.match(/Reviewing the FIR|"reason"|"justification"|"noteHash"|identityHash/);
    }
  });

  it('withholds the advice on a request that still waits from every officer who is not a reviewer', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' }));
    // The requester rule of 2026-10-08 stays: nobody outside the reviewers learns the advice before the
    // decision.
    for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst]) {
      const [entry] = await read(caller, 'QueryAccessWorkflowLog');
      expect(entry, caller.identityId).to.include({
        requestId: request.requestId, recordId: 'FIR-1', status: 'awaiting-auditor',
        llmRecommendation: null, generationStatus: null, recommendationWithheld: true,
      });
      // The transaction that committed the advice is not named to them either.
      expect(entry).to.not.have.property('recommendationTxId');
      expect(entry.requester.username).to.equal('insp.test');
    }
    await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
    const [decided] = await read(CALLERS.constable, 'QueryAccessWorkflowLog');
    expect(decided).to.include({ llmRecommendation: 'DENY', decision: 'FORCE_ALLOW', recommendationWithheld: false });
  });

  it('does not mark a waiting request as withheld when there is no advice yet', async () => {
    await world.submit(CALLERS.inspector);
    const [entry] = await read(CALLERS.constable, 'QueryAccessWorkflowLog');
    expect(entry).to.include({ status: 'awaiting-auditor', llmRecommendation: null, recommendationWithheld: false });
  });

  it('refuses the workflow log to an identity without an enrolled role', async () => {
    const noRole = { ...CALLERS.inspector, identityId: 'no.role', attrs: { ...CALLERS.inspector.attrs, role: '' } };
    await expect(read(noRole, 'QueryAccessWorkflowLog')).to.be.rejectedWith(/unauthorized/);
  });

  // What every officer reads: who asked for which file, the advice, the decision and the outcome.
  const OFFICER_FIELDS = Object.freeze([
    'action', 'auditor', 'authorizationId', 'basis', 'caseId', 'createdAuthorizationId', 'decidedAtUtc',
    'decision', 'dynamicAuthorizationCheck', 'generationStatus', 'llmAgreement', 'llmRecommendation', 'outcome',
    'processingPath', 'purpose', 'recommendationWithheld', 'recordId', 'requestId', 'requester', 'status',
    'submittedAtUtc',
  ]);
  const TRANSACTION_FIELDS = Object.freeze(['decisionTxId', 'outcomeTxId', 'recommendationTxId', 'requestTxId']);

  it('gives an officer exactly the log fields, and only a reviewer the transactions and the full authorization check', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
    for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst, CALLERS.prosecutor]) {
      const [entry] = await read(caller, 'QueryAccessWorkflowLog');
      expect(Object.keys(entry).sort(), caller.identityId).to.deep.equal([...OFFICER_FIELDS]);
      expect(Object.keys(entry.dynamicAuthorizationCheck).sort()).to.deep.equal(['authorizationId', 'matched', 'outcome']);
      expect(Object.keys(entry.requester).sort()).to.deep.equal(['organization', 'role', 'username']);
      expect(Object.keys(entry.auditor).sort()).to.deep.equal(['role', 'username']);
    }
    for (const caller of [CALLERS.auditor, CALLERS.judge, CALLERS.districtJudge]) {
      const [entry] = await read(caller, 'QueryAccessWorkflowLog');
      expect(Object.keys(entry).sort(), caller.identityId).to.deep.equal([...OFFICER_FIELDS, ...TRANSACTION_FIELDS].sort());
      expect(entry.dynamicAuthorizationCheck).to.have.property('conditionsHash');
    }
  });

  it('never lets a stored digest or identity hash into what an officer reads, under any field name', async () => {
    const { result: request } = await world.submit(CALLERS.inspector);
    await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
    const stored = world.readRequest(request.requestId);
    const decision = world.readState('diasAuditorDecision', request.requestId);
    const commitment = world.readState('diasRecommendationCommitment', request.requestId);
    // The context digest is unsalted: with the public profile of the requester it would let any officer
    // test guesses of a file's protected flags.
    const secrets = [
      stored.justificationHash, stored.requester.identityHash, stored.dynamicAuthorizationCheck.conditionsHash,
      stored.dynamicAuthorizationCheck.scopeHash, decision.noteHash, decision.auditor.identityHash,
      commitment.commitmentId, commitment.recommendationHash,
    ];
    expect(secrets.every((value) => typeof value === 'string' && value.length >= 16), JSON.stringify(secrets)).to.equal(true);
    for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst, CALLERS.prosecutor]) {
      const text = JSON.stringify([
        await read(caller, 'QueryAccessWorkflowLog'), await read(caller, 'QueryAccessDecisions', '50'),
      ]);
      for (const secret of secrets) expect(text, `${caller.identityId} ${secret}`).to.not.include(secret);
    }
  });

  it('keeps the advice of a request that was cancelled or expired while it waited from every non-reviewer', async () => {
    const { result: cancelled } = await world.submit(CALLERS.inspector);
    await world.commit(cancelled.requestId, world.commitmentFor(cancelled.requestId, { recommendation: 'DENY' }));
    await world.cancel(cancelled.requestId);
    const { result: expired } = await world.submit(CALLERS.constable);
    await world.commit(expired.requestId, world.commitmentFor(expired.requestId, { recommendation: 'ALLOW' }));
    await world.expire(expired.requestId, { timestamp: '2027-01-01T00:00:00.000Z' });
    for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst]) {
      const entries = await read(caller, 'QueryAccessWorkflowLog');
      for (const [requestId, status] of [[cancelled.requestId, 'cancelled'], [expired.requestId, 'expired']]) {
        expect(entries.find((entry) => entry.requestId === requestId), `${caller.identityId} ${status}`).to.include({
          status, llmRecommendation: null, generationStatus: null, llmAgreement: null, recommendationWithheld: true,
        });
      }
    }
  });

  it('refuses both logs to a certificate whose credential is not active', async () => {
    await world.submit(CALLERS.inspector);
    for (const credentialStatus of ['suspended', 'revoked', '']) {
      const caller = { ...CALLERS.constable, attrs: { ...CALLERS.constable.attrs, credentialStatus } };
      await expect(read(caller, 'QueryAccessWorkflowLog')).to.be.rejectedWith(/unauthorized.*active credential/);
      await expect(read(caller, 'QueryAccessDecisions', '50')).to.be.rejectedWith(/unauthorized.*active credential/);
    }
  });

  it('withholds a pending recommendation from a reviewer who is also its requester', async () => {
    const { result: request } = await world.submit(CALLERS.auditor, { purpose: 'audit-review' });
    await world.commit(request.requestId, world.commitmentFor(request.requestId));
    const [entry] = await read(CALLERS.auditor, 'QueryAccessWorkflowLog');
    expect(entry).to.include({ llmRecommendation: null, generationStatus: null,
      recommendationTxId: null, recommendationWithheld: true });
  });

  it('lets any enrolled role discover an evidence identifier without returning its private detail', async () => {
    await world.run(CALLERS.analyst, world.nextTx('EVIDENCE'), (ctx) => {
      ctx.stub.getTransient = () => new Map();
      return world.contracts.records.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64),
        'private evidence description', 'FSL-1');
    });
    const { result } = await world.run(CALLERS.constable, world.nextTx('LOOKUP'),
      (ctx) => world.contracts.records.QueryEvidenceIndex(ctx, 'EV-1'));
    expect(result).to.deep.equal([{ evidenceId: 'EV-1', recordId: 'FIR-1', caseId: 'CASE-1',
      owningMsp: 'PoliceMSP', owningAgency: 'police', owningStation: 'PS-Central' }]);
    expect(JSON.stringify(result)).to.not.include('private evidence');
  });

  it('validates limits instead of accepting an unbounded or malformed scan result', async () => {
    for (const method of ['QueryMyAccessRequests', 'QueryAccessWorkflowLog']) {
      for (const limit of ['0', '501', '2.5', 'oops']) {
        await expect(read(CALLERS.auditor, method, limit)).to.be.rejectedWith(/limit/);
      }
    }
  });
});
