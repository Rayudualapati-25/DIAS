'use strict';

/**
 * Plan step 11 (contract side): the auditor note commitment h_N (design §7;
 * paper §IV-E, Algorithm 1 lines 18 and 29–30). The note text stays off-chain;
 * the decision carries only its digest. A decision that does not agree with the
 * committed recommendation, or has none to agree with, must carry a note digest,
 * and is otherwise rejected with no writes. An agreeing decision may carry one.
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');
const { hashText } = require('../lib/dias/commitments');

const INSPECTOR = CALLERS.inspector;
const NOTE = hashText('note', 'The case lead confirmed the assignment by phone.');

describe('DIAS auditor note commitment (plan step 11)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  async function pending() {
    const { result } = await world.submit(INSPECTOR);
    return result;
  }

  const snapshot = () => JSON.stringify([...world.ledger._state.entries()]);

  describe('a note digest is required', () => {
    const cases = [
      ['FORCE_ALLOW over a committed DENY (NOT_AGREED)', 'FORCE_ALLOW', 'DENY', {}],
      ['FORCE_DENY over a committed ALLOW (NOT_AGREED)', 'FORCE_DENY', 'ALLOW', {}],
      ['a committed failure status (NO_RECOMMENDATION)', 'FORCE_DENY', 'UNAVAILABLE', { generationStatus: 'INVALID_OUTPUT' }],
      ['no commitment at all (NO_RECOMMENDATION)', 'FORCE_ALLOW', null, {}],
    ];
    for (const [name, decision, recommendation, options] of cases) {
      it(`rejects ${name} without one, writing nothing`, async () => {
        const request = await pending();
        if (recommendation !== null) {
          const failed = recommendation === 'UNAVAILABLE';
          await world.commit(request.requestId, world.commitmentFor(request.requestId, {
            recommendation: failed ? null : recommendation,
            generationStatus: failed ? options.generationStatus : 'OK',
          }));
        }
        const before = snapshot();
        await expect(world.decide(request.requestId, decision, recommendation, { ...options, noteHash: '' }))
          .to.be.rejectedWith(/^DIAS_NOTE_REQUIRED: /);
        expect(snapshot()).to.equal(before);
        expect(world.readRequest(request.requestId).status).to.equal('awaiting-auditor');
      });
    }

    it('accepts the same decision once the digest is supplied, and records it', async () => {
      const request = await pending();
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY', { noteHash: NOTE });
      expect(result.auditorDecision).to.include({ llmAgreement: 'NOT_AGREED', noteHash: NOTE });
      const recorded = world.requestEvents(request.requestId)
        .find((event) => event.eventType === 'AUDITOR_DECISION_RECORDED');
      expect(recorded.data.noteHash).to.equal(NOTE);
    });
  });

  describe('an agreeing decision', () => {
    it('needs no note, and records that none was given', async () => {
      const request = await pending();
      const { result } = await world.decide(request.requestId, 'FORCE_DENY', 'DENY', { noteHash: '' });
      expect(result.auditorDecision).to.include({ llmAgreement: 'AGREED', noteHash: null });
    });

    it('may carry a note digest, which is recorded', async () => {
      const request = await pending();
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW', { noteHash: NOTE });
      expect(result.auditorDecision).to.include({ llmAgreement: 'AGREED', noteHash: NOTE });
    });
  });

  it('returns the committed decision with its note digest in the auditor review, for read-back', async () => {
    const request = await pending();
    const review = (ctx) => world.contracts.access.GetAuditorReview(ctx, request.requestId);
    const before = await world.run(CALLERS.auditor, world.nextTx('READ'), review);
    expect(before.result.decision).to.equal(null);
    await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY', { noteHash: NOTE });
    const after = await world.run(CALLERS.auditor, world.nextTx('READ'), review);
    expect(Object.keys(after.result)).to.deep.equal(['request', 'commitment', 'decision']);
    expect(after.result.decision).to.include({ decision: 'FORCE_ALLOW', noteHash: NOTE, llmAgreement: 'NOT_AGREED' });
  });

  it('rejects a malformed note digest before reading anything', async () => {
    const request = await pending();
    for (const bad of ['abc', 'F'.repeat(64), `${'a'.repeat(63)}g`]) {
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'DENY', { noteHash: bad }), bad)
        .to.be.rejectedWith(/noteHash must be a SHA-256 digest/);
    }
  });
});
