'use strict';

/**
 * The recommendation listener.
 *
 * These tests pin the properties the architecture depends on and that no amount
 * of careful reading can guarantee: a failure is recorded rather than converted
 * into a recommendation, a replayed event does nothing, a broken checkpoint does
 * not swallow a pending request, and nothing but the model's own output ever
 * becomes the recommendation.
 */

const crypto = require('crypto');
const { expect } = require('chai');

const service = require('../src/dias/recommendationService');
const { createAttestationSigner } = require('../src/dias/attestation');
const { createPolicyContextProvider } = require('../src/dias/policyContextProvider');
const { createRecommender } = require('../src/dias/recommender');
const { PROMPT_VERSION } = require('../src/dias/recommendationPrompt');
const {
  GENERATION_STATUS, RESPONSE_SCHEMA_VERSION,
} = require('../../chaincode/crimerecords/lib/dias/recommendationSchema');
const {
  verifiedRequestHash,
} = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
const {
  attestationPayload, validateProvenance, verifyAttestation,
} = require('../../chaincode/crimerecords/lib/dias/recommendationProvenance');
const { CHAINCODE_EVENT_NAME } = require('../../chaincode/crimerecords/lib/dias/lifecycle');
const { sha256 } = require('../../policies/lib/bundle');
const { verifiedRequestFixture, validOutput } = require('./fixtures/diasFixtures');

const silent = { log() {}, error() {} };
const JUSTIFICATION = 'I am assigned to this case and need the FIR to prepare the charge sheet.';

const REGISTRATION = Object.freeze({
  registrationId: 'REG-1',
  modelId: 'qwen3-14b-dias-v7',
  modelFamily: 'qwen3',
  baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4',
  quantization: '4bit',
  adapterId: null,
  adapterHash: null,
  promptVersion: PROMPT_VERSION,
  responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
});

const policyContextProvider = createPolicyContextProvider({});
const POLICY = policyContextProvider.bundleInfo();

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const signer = createAttestationSigner({
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});
const registrationWithKey = {
  ...REGISTRATION,
  publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

function chatReply(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 900, completion_tokens: 60 },
    }),
  };
}

function recommenderFor(fetchImpl) {
  return () => createRecommender({
    policyContextProvider,
    model: {
      ...REGISTRATION,
      url: 'http://127.0.0.1:8081/v1',
      servedModel: 'default_model',
    },
    fetchImpl,
    options: { timeoutMs: 1000 },
  });
}

function ledgerContext(overrides = {}) {
  const verifiedRequest = verifiedRequestFixture();
  return {
    requestId: 'REQ-abc123',
    status: 'awaiting-recommendation',
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
    justification: JUSTIFICATION,
    justificationHash: sha256(JUSTIFICATION),
    justificationHashVerified: true,
    policyBundle: { bundleId: POLICY.bundleId, version: POLICY.version, bundleHash: POLICY.bundleHash },
    model: registrationWithKey,
    ...overrides,
  };
}

/** A ledger stub that records what the listener submitted. */
function fakeLedger(context) {
  const submissions = [];
  return {
    submissions,
    evaluate: async (_org, _user, _contract, fn) => {
      if (fn !== 'GetAccessRequestForRecommendation') throw new Error(`unexpected evaluate ${fn}`);
      if (context === null) throw new Error("access request 'REQ-abc123' does not exist");
      return context;
    },
    submit: async (_org, _user, _contract, fn, ...args) => {
      submissions.push({ fn, args });
      return { fn, requestId: args[0] };
    },
  };
}

async function runOnce(context, fetchImpl) {
  const ledger = fakeLedger(context);
  const result = await service.handleRequest('REQ-abc123', {
    fabric: ledger,
    recommenderFor: recommenderFor(fetchImpl),
    signer,
    policyBundleHash: POLICY.bundleHash,
    log: silent,
  });
  return { ledger, result };
}

describe('DIAS recommendation service', () => {
  describe('a schema-valid model answer', () => {
    it('is submitted unchanged, with provenance and an attestation chaincode accepts', async () => {
      const output = validOutput();
      const { ledger } = await runOnce(
        ledgerContext(), async () => chatReply(JSON.stringify(output))
      );

      expect(ledger.submissions).to.have.length(1);
      const [submission] = ledger.submissions;
      expect(submission.fn).to.equal('SubmitLLMRecommendation');

      const [requestId, outputJson, provenanceJson, signature] = submission.args;
      const submitted = JSON.parse(outputJson);
      const provenance = JSON.parse(provenanceJson);

      // The recommendation reaches the ledger exactly as the model produced it.
      expect(submitted).to.deep.equal(output);

      const context = ledgerContext();
      expect(validateProvenance(provenance, {
        requestId,
        verifiedRequestHash: context.verifiedRequestHash,
        justificationHash: context.justificationHash,
        generationStatus: GENERATION_STATUS.OK,
        model: REGISTRATION,
        policyBundle: POLICY,
      })).to.deep.equal([]);

      expect(verifyAttestation(registrationWithKey, attestationPayload({
        requestId,
        verifiedRequestHash: context.verifiedRequestHash,
        justificationHash: context.justificationHash,
        generationStatus: GENERATION_STATUS.OK,
        output: submitted,
        provenance,
      }), signature)).to.equal(true);
    });

    it('submits a DENY exactly as recommended, with no engine allowed to soften it', async () => {
      const output = validOutput({
        recommendation: 'DENY',
        reason_code: 'NOT_ASSIGNED',
        reason: 'The requester is not assigned to case CASE-7F2A (GP-ASSIGN:C1@v1).',
        policy_refs: ['GP-ASSIGN:C1@v1'],
      });
      const { ledger } = await runOnce(
        ledgerContext(), async () => chatReply(JSON.stringify(output))
      );
      expect(JSON.parse(ledger.submissions[0].args[1])).to.deep.equal(output);
    });
  });

  describe('generation failures become statuses, never recommendations', () => {
    const cases = [
      {
        name: 'the model server is unreachable',
        fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
        status: GENERATION_STATUS.UNAVAILABLE,
        errorCode: 'server_unreachable',
      },
      {
        name: 'the request times out',
        fetchImpl: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
        status: GENERATION_STATUS.UNAVAILABLE,
        errorCode: 'timeout',
      },
      {
        name: 'the model returns prose instead of JSON',
        fetchImpl: async () => chatReply('I think this should probably be allowed.'),
        status: GENERATION_STATUS.INVALID_OUTPUT,
        errorCode: undefined,
      },
      {
        name: 'the model invents a third class',
        fetchImpl: async () => chatReply(JSON.stringify(validOutput({ recommendation: 'ESCALATE' }))),
        status: GENERATION_STATUS.INVALID_OUTPUT,
        errorCode: undefined,
      },
      {
        name: 'the server reports a context-length error',
        fetchImpl: async () => ({
          ok: false, status: 400, text: async () => 'maximum context length exceeded',
        }),
        status: GENERATION_STATUS.CONTEXT_OVERFLOW,
        errorCode: 'http_400',
      },
    ];

    for (const { name, fetchImpl, status, errorCode } of cases) {
      it(`records ${status} when ${name}`, async () => {
        const { ledger } = await runOnce(ledgerContext(), fetchImpl);
        expect(ledger.submissions).to.have.length(1);
        const [submission] = ledger.submissions;
        expect(submission.fn).to.equal('RecordLLMRecommendationUnavailable');
        const reported = JSON.parse(submission.args[1]);
        expect(reported.generationStatus).to.equal(status);
        expect(reported.errorCode).to.match(/^[a-z0-9_]{1,64}$/);
        if (errorCode) expect(reported.errorCode).to.equal(errorCode);

        const provenance = JSON.parse(submission.args[2]);
        const context = ledgerContext();
        expect(validateProvenance(provenance, {
          requestId: 'REQ-abc123',
          verifiedRequestHash: context.verifiedRequestHash,
          justificationHash: context.justificationHash,
          generationStatus: status,
          model: REGISTRATION,
          policyBundle: POLICY,
        })).to.deep.equal([]);
      });
    }

    it('signs the failure too, so nobody can fake "the model was unavailable"', async () => {
      const { ledger } = await runOnce(
        ledgerContext(), async () => { throw new Error('connect ECONNREFUSED'); }
      );
      const [, statusJson, provenanceJson, signature] = ledger.submissions[0].args;
      const context = ledgerContext();
      expect(verifyAttestation(registrationWithKey, attestationPayload({
        requestId: 'REQ-abc123',
        verifiedRequestHash: context.verifiedRequestHash,
        justificationHash: context.justificationHash,
        generationStatus: JSON.parse(statusJson).generationStatus,
        output: null,
        provenance: JSON.parse(provenanceJson),
      }), signature)).to.equal(true);
    });
  });

  describe('integrity of what the model is shown', () => {
    it('refuses to ask the model when the justification does not match its committed hash', async () => {
      let called = false;
      const { ledger } = await runOnce(
        ledgerContext({ justificationHashVerified: false }),
        async () => { called = true; return chatReply('{}'); }
      );
      expect(called, 'the model must not see unverified private data').to.equal(false);
      expect(JSON.parse(ledger.submissions[0].args[1])).to.deep.equal({
        generationStatus: GENERATION_STATUS.UNAVAILABLE,
        errorCode: 'justification_hash_mismatch',
      });
    });

    it('refuses when the verified request does not match its committed hash', async () => {
      const context = ledgerContext({ verifiedRequestHash: 'f'.repeat(64) });
      let called = false;
      const { ledger } = await runOnce(context, async () => { called = true; return chatReply('{}'); });
      expect(called).to.equal(false);
      expect(JSON.parse(ledger.submissions[0].args[1]).errorCode)
        .to.equal('verified_request_hash_mismatch');
    });

    it('refuses when the local bundle is not the bundle the ledger activated', async () => {
      const context = ledgerContext({
        policyBundle: { bundleId: POLICY.bundleId, version: POLICY.version, bundleHash: 'a'.repeat(64) },
      });
      let called = false;
      const ledger = fakeLedger(context);
      await service.handleRequest('REQ-abc123', {
        fabric: ledger,
        recommenderFor: recommenderFor(async () => { called = true; return chatReply('{}'); }),
        signer,
        policyBundleHash: POLICY.bundleHash,
        log: silent,
      });
      expect(called).to.equal(false);
      const reported = JSON.parse(ledger.submissions[0].args[1]);
      expect(reported.generationStatus).to.equal(GENERATION_STATUS.POLICY_CONTEXT_UNAVAILABLE);
      expect(reported.errorCode).to.equal('policy_bundle_mismatch');
    });
  });

  describe('idempotence and replay', () => {
    it('does nothing for a request that already left the recommendation step', async () => {
      const { ledger, result } = await runOnce(
        ledgerContext({ status: 'awaiting-auditor' }), async () => chatReply('{}')
      );
      expect(result).to.equal(null);
      expect(ledger.submissions).to.deep.equal([]);
    });

    it('does nothing for a request that does not exist', async () => {
      const { ledger, result } = await runOnce(null, async () => chatReply('{}'));
      expect(result).to.equal(null);
      expect(ledger.submissions).to.deep.equal([]);
    });
  });

  describe('configuration mismatches stop the service instead of burning requests', () => {
    it('rejects a registration that pins a different prompt version', () => {
      expect(() => service.assertRegistrationMatchesBuild({
        ...REGISTRATION, promptVersion: 'dias-recommendation-prompt-v0',
      })).to.throw(/prompt/);
    });

    it('rejects a registration that pins a different response schema', () => {
      expect(() => service.assertRegistrationMatchesBuild({
        ...REGISTRATION, responseSchemaVersion: 'something-else',
      })).to.throw(/response schema/);
    });

    it('accepts the registration this build implements', () => {
      expect(() => service.assertRegistrationMatchesBuild(REGISTRATION)).to.not.throw();
    });
  });

  describe('event selection', () => {
    const event = (payload, eventName = CHAINCODE_EVENT_NAME) => ({
      eventName, payload: Buffer.from(JSON.stringify(payload)),
    });

    it('answers only events that ask for a recommendation', () => {
      expect(service.requestNeedingRecommendation(
        event({ requestId: 'REQ-1', nextStep: 'LLM_RECOMMENDATION' })
      )).to.equal('REQ-1');
    });

    it('ignores a request already settled by a dynamic authorization', () => {
      expect(service.requestNeedingRecommendation(
        event({ requestId: 'REQ-1', nextStep: null, outcome: 'GRANTED' })
      )).to.equal(null);
    });

    it('ignores other chaincode events and unparseable payloads', () => {
      expect(service.requestNeedingRecommendation(
        event({ requestId: 'REQ-1', nextStep: 'LLM_RECOMMENDATION' }, 'SomethingElse')
      )).to.equal(null);
      expect(service.requestNeedingRecommendation({
        eventName: CHAINCODE_EVENT_NAME, payload: Buffer.from('not json'),
      })).to.equal(null);
    });
  });

  describe('checkpointing', () => {
    function streamOf(events) {
      return {
        closed: false,
        close() { this.closed = true; },
        [Symbol.asyncIterator]() { return events[Symbol.iterator](); },
      };
    }

    it('advances past blocks it did not answer, so a multi-event block is not skipped', async () => {
      const written = [];
      const events = [
        { eventName: 'Other', blockNumber: 10n, payload: Buffer.from('{}') },
        { eventName: CHAINCODE_EVENT_NAME, blockNumber: 11n, payload: Buffer.from(JSON.stringify({ requestId: 'REQ-1', nextStep: 'LLM_RECOMMENDATION' })) },
      ];
      const ledger = {
        chaincodeEvents: async () => streamOf(events),
        evaluate: async () => ledgerContext({ status: 'awaiting-auditor' }),
        submit: async () => ({}),
      };
      await service.run({
        fabric: ledger,
        recommenderFor: recommenderFor(async () => chatReply('{}')),
        signer,
        policyBundleHash: POLICY.bundleHash,
        log: silent,
        checkpoint: { read: () => undefined, write: (block) => written.push(block) },
      });
      expect(written).to.deep.equal([10n, 11n]);
    });

    it('does not checkpoint a request it failed to answer', async () => {
      const written = [];
      const events = [{
        eventName: CHAINCODE_EVENT_NAME,
        blockNumber: 12n,
        payload: Buffer.from(JSON.stringify({ requestId: 'REQ-1', nextStep: 'LLM_RECOMMENDATION' })),
      }];
      const ledger = {
        chaincodeEvents: async () => streamOf(events),
        evaluate: async () => { throw new Error('peer unavailable'); },
        submit: async () => ({}),
      };
      let caught;
      try {
        await service.run({
          fabric: ledger,
          recommenderFor: recommenderFor(async () => chatReply('{}')),
          signer,
          policyBundleHash: POLICY.bundleHash,
          log: silent,
          checkpoint: { read: () => undefined, write: (block) => written.push(block) },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught.message).to.equal('peer unavailable');
      expect(written, 'a failed request must stay replayable').to.deep.equal([]);
    });
  });

  it('never submits an access decision of its own', async () => {
    const { ledger } = await runOnce(
      ledgerContext(), async () => chatReply(JSON.stringify(validOutput()))
    );
    const forbidden = ['SubmitAuditorDecision', 'CreateAccessRequest', 'RevokeDynamicAuthorization'];
    expect(ledger.submissions.map((s) => s.fn).filter((fn) => forbidden.includes(fn)))
      .to.deep.equal([]);
  });
});
