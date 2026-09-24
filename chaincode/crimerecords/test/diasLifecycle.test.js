'use strict';

const { expect } = require('chai');
const { buildMockContext } = require('./testHelpers');
const {
  CHAINCODE_EVENT_NAME, EVENT, actorFrom, appendAuthorizationEvents, appendRequestEvents,
  emitLifecycle, readAuthorizationEvents, readRequestEvents,
} = require('../lib/dias/lifecycle');

describe('DIAS lifecycle events', () => {
  const caller = { enrollmentId: 'insp.sharma', mspId: 'PoliceMSP', role: 'inspector' };

  it('writes ordered, transaction-bound events under the request ID', async () => {
    const ctx = buildMockContext({ mspId: 'PoliceMSP', txId: 'TX-A' });
    const actor = actorFrom(caller, 'h'.repeat(64));
    const first = await appendRequestEvents(ctx, {
      requestId: 'REQ-1', lastSeq: 0, actor,
      events: [
        { type: EVENT.ACCESS_REQUEST_SUBMITTED, data: { recordId: 'REC-1' } },
        { type: EVENT.DYNAMIC_AUTHORIZATION_CHECKED, data: { outcome: 'NO_AUTHORIZATION' } },
      ],
    });
    expect(first.lastSeq).to.equal(2);
    const second = await appendRequestEvents(ctx, {
      requestId: 'REQ-1', lastSeq: first.lastSeq, actor,
      events: [{ type: EVENT.AUDITOR_DECISION_RECORDED }],
    });
    expect(second.records[0]).to.include({ seq: 3, txId: 'TX-A', requestId: 'REQ-1' });
    const events = await readRequestEvents(ctx, 'REQ-1');
    expect(events.map((event) => event.eventType)).to.deep.equal([
      'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'AUDITOR_DECISION_RECORDED',
    ]);
    expect(events[0].actor).to.deep.equal({
      username: 'insp.sharma', mspId: 'PoliceMSP', role: 'inspector', identityHash: 'h'.repeat(64),
    });
    expect(events[0].timestamp).to.equal('2026-08-05T12:00:00.000Z');
    expect(events[2].data).to.deep.equal({});
  });

  it('keeps request event streams isolated even when IDs share a prefix', async () => {
    const ctx = buildMockContext({ mspId: 'PoliceMSP' });
    const actor = actorFrom(caller, 'h');
    await appendRequestEvents(ctx, { requestId: 'REQ-1', lastSeq: 0, actor, events: [{ type: EVENT.ACCESS_REQUEST_SUBMITTED }] });
    await appendRequestEvents(ctx, { requestId: 'REQ-10', lastSeq: 0, actor, events: [{ type: EVENT.ACCESS_REQUEST_SUBMITTED }] });
    expect(await readRequestEvents(ctx, 'REQ-1')).to.have.length(1);
    expect(await readRequestEvents(ctx, 'REQ-10')).to.have.length(1);
  });

  it('stores authorization events in their own key space', async () => {
    const ctx = buildMockContext({ mspId: 'AuditMSP' });
    const actor = actorFrom({ enrollmentId: 'sp.north', mspId: 'AuditMSP', role: 'sp' }, 'h');
    await appendAuthorizationEvents(ctx, {
      authorizationId: 'AUTH-1', lastSeq: 0, actor, events: [{ type: EVENT.DYNAMIC_AUTHORIZATION_CREATED }],
    });
    expect(await readAuthorizationEvents(ctx, 'AUTH-1')).to.have.length(1);
    expect(await readRequestEvents(ctx, 'AUTH-1')).to.have.length(0);
  });

  it('emits one chaincode event naming every committed stage', () => {
    const ctx = buildMockContext({ mspId: 'PoliceMSP', txId: 'TX-B' });
    emitLifecycle(ctx, { requestId: 'REQ-1', stages: ['ACCESS_REQUEST_SUBMITTED'], nextStep: 'AUDITOR_DECISION' });
    expect(ctx._events).to.have.length(1);
    expect(ctx._events[0].name).to.equal(CHAINCODE_EVENT_NAME);
    expect(JSON.parse(ctx._events[0].payload)).to.include({
      requestId: 'REQ-1', nextStep: 'AUDITOR_DECISION', txId: 'TX-B',
    });
  });
});
