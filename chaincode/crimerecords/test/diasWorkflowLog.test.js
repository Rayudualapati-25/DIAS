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

  it('refuses the full workflow log to a requester without reviewer authority', async () => {
    await expect(read(CALLERS.inspector, 'QueryAccessWorkflowLog')).to.be.rejectedWith(/unauthorized/);
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
