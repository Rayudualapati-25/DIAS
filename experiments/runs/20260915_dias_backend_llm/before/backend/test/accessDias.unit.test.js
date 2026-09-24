'use strict';

/**
 * DIAS access-route progress.
 *
 * The route must distinguish three states that look similar from the browser but
 * mean different things on the ledger: a committed access outcome, a request
 * parked for the auditor, and a request still waiting for the model. Reporting
 * the wrong one told a requester that no decision existed while the ledger held
 * one.
 */

const { expect } = require('chai');

const accessRouter = require('../src/routes/access');

const user = Object.freeze({ org: 'police', fabricUser: 'insp.test' });
const request = Object.freeze({
  requestId: 'REQ-1',
  recordId: 'FIR-1',
  status: 'awaiting-recommendation',
});

describe('DIAS access route progress', () => {
  it('reports a committed grant as decided without reading a separate decision', async () => {
    const calls = [];
    const ledger = {
      evaluate: async (...args) => {
        calls.push(args);
        return {
          ...request,
          status: 'granted',
          processingPath: 'dynamic-authorization',
          outcomeId: 'OUTCOME-1',
          llmRecommendationStatus: 'SKIPPED',
          auditorReviewStatus: 'SKIPPED',
        };
      },
    };

    const result = await accessRouter.waitForAccessProgress(user, request, 1000, { ledger });

    expect(result.state).to.equal('decided');
    expect(result.data).to.include({ status: 'granted', outcomeId: 'OUTCOME-1' });
    // The request itself carries the outcome, so no second evaluate is needed.
    expect(calls.map((call) => call[3])).to.deep.equal(['GetRequest']);
  });

  it('reports a committed denial as decided', async () => {
    const ledger = {
      evaluate: async () => ({ ...request, status: 'denied', auditorReviewStatus: 'FORCE_DENY' }),
    };
    const result = await accessRouter.waitForAccessProgress(user, request, 1000, { ledger });
    expect(result.state).to.equal('decided');
    expect(result.data.auditorReviewStatus).to.equal('FORCE_DENY');
  });

  it('stops at the auditor once a recommendation exists, without calling it a decision', async () => {
    const ledger = {
      evaluate: async () => ({
        ...request, status: 'awaiting-auditor', recommendationId: 'REC-1',
      }),
    };

    const result = await accessRouter.waitForAccessProgress(user, request, 1000, { ledger });

    expect(result.state).to.equal('awaiting-auditor');
    expect(result.data).to.include({ status: 'awaiting-auditor', recommendationId: 'REC-1' });
    expect(result.data).to.not.have.property('outcomeId');
  });

  it('stops at the auditor when generation failed and nothing was recommended', async () => {
    const ledger = {
      evaluate: async () => ({
        ...request,
        status: 'awaiting-auditor',
        recommendationId: 'REC-1',
        llmRecommendationStatus: 'UNAVAILABLE',
      }),
    };
    const result = await accessRouter.waitForAccessProgress(user, request, 1000, { ledger });
    expect(result.state).to.equal('awaiting-auditor');
    expect(result.data.llmRecommendationStatus).to.equal('UNAVAILABLE');
  });

  it('gives up as still-awaiting-recommendation rather than inventing an answer', async () => {
    let polls = 0;
    const ledger = {
      evaluate: async () => {
        polls += 1;
        return { ...request };
      },
    };
    const result = await accessRouter.waitForAccessProgress(
      user, request, 0, { ledger, sleep: async () => {} }
    );
    expect(result.state).to.equal('awaiting-recommendation');
    expect(polls).to.equal(1);
  });

  it('retries only the pre-submit peer-convergence mismatch', async () => {
    let attempts = 0;
    const sleeps = [];
    const ledger = {
      ACCESS_QUERY_ENDORSERS: ['PoliceMSP', 'AIOrgMSP'],
      submitWithTransient: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ProposalResponsePayloads do not match');
        return { requestId: 'REQ-2', status: 'awaiting-recommendation' };
      },
    };

    const result = await accessRouter.submitAccessRequest(
      user,
      ['FIR-1', '{"action":"view","purpose":"investigation","emergencyFlag":false}'],
      { justification: Buffer.from('why') },
      { ledger, sleep: async (milliseconds) => sleeps.push(milliseconds), retries: 3 }
    );

    expect(result.requestId).to.equal('REQ-2');
    expect(attempts).to.equal(3);
    expect(sleeps).to.deep.equal([150, 300]);
  });

  it('does not retry unrelated Fabric failures', async () => {
    let attempts = 0;
    const ledger = {
      ACCESS_QUERY_ENDORSERS: [],
      submitWithTransient: async () => {
        attempts += 1;
        throw new Error('authorization failed');
      },
    };

    let caught;
    try {
      await accessRouter.submitAccessRequest(
        user, ['FIR-1', '{}'], { justification: Buffer.from('why') },
        { ledger, sleep: async () => {}, retries: 3 }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught.message).to.equal('authorization failed');
    expect(attempts).to.equal(1);
  });

  it('sends the justification as transient data, never as a chaincode argument', async () => {
    let captured;
    const ledger = {
      ACCESS_QUERY_ENDORSERS: ['PoliceMSP'],
      submitWithTransient: async (...args) => {
        captured = args;
        return { requestId: 'REQ-3' };
      },
    };
    await accessRouter.submitAccessRequest(
      user, ['FIR-1', '{"action":"view"}'], { justification: Buffer.from('sensitive reason') },
      { ledger }
    );
    const [, , contract, fn, args, transient] = captured;
    expect(contract).to.equal('AccessContract');
    expect(fn).to.equal('CreateAccessRequest');
    expect(args.join(' ')).to.not.contain('sensitive reason');
    expect(transient.justification.toString('utf8')).to.equal('sensitive reason');
  });
});
