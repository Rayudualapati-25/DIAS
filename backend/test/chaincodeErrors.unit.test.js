'use strict';

/**
 * A chaincode refusal carries a DIAS error code at the start of its message
 * (docs/design/dias-v3-ledger-schema.md §15). The API maps the code to an HTTP
 * status so a client can tell "not allowed" from "too late" from "malformed".
 */

const { expect } = require('chai');
const { asyncRoute, statusForChaincodeMessage } = require('../src/util/respond');

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const refusal = (message) => Object.assign(new Error('endorse failed'), {
  details: [{ message: `chaincode response 500, ${message}` }],
});

describe('chaincode error status mapping', () => {
  const cases = [
    ['DIAS_AUDITOR_INACTIVE: the ledger profile is suspended', 403],
    ['DIAS_AUDITOR_OUT_OF_DISTRICT: requires a district head of that district', 403],
    ['DIAS_AUDITOR_CLEARANCE: clearance does not cover the record', 403],
    ['unauthorized: a requester cannot decide their own request', 403],
    ['DIAS_REQUEST_EXPIRED: the review deadline has passed', 409],
    ['DIAS_STALE_POLICY: the active policy changed', 409],
    ['DIAS_COMMITMENT_CONFLICT: a different commitment exists', 409],
    ['DIAS_NO_ACTIVE_POLICY: no policy is active', 409],
    ['DIAS_LEGACY_RECORD: request predates v3', 409],
    ['DIAS_SIGNATURE_INVALID: signature does not verify', 422],
    ['DIAS_NOTE_REQUIRED: a note commitment is required', 422],
    ["access request: field 'purpose' must be one of [...]", 422],
  ];

  for (const [message, status] of cases) {
    it(`maps "${message.split(':')[0]}" to ${status}`, () => {
      expect(statusForChaincodeMessage(message)).to.equal(status);
    });
  }

  it('answers through asyncRoute with the mapped status and the contract sentence', async () => {
    const res = fakeResponse();
    await asyncRoute(async () => { throw refusal('DIAS_AUDITOR_OUT_OF_DISTRICT: wrong district'); })(
      { method: 'POST', originalUrl: '/api/access/auditor/REQ-1/decision' }, res
    );
    expect(res.statusCode).to.equal(403);
    expect(res.body.error).to.equal('DIAS_AUDITOR_OUT_OF_DISTRICT: wrong district');
  });
});
