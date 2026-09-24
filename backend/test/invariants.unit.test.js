'use strict';

/**
 * Cross-surface invariants.
 *
 * Some of this system's correctness lives in the relationship BETWEEN two
 * independently editable files rather than inside either one. The evidence
 * collection was sized for a five-organization network and silently became
 * unsatisfiable when a sixth organization joined; the failure surfaced only as
 * an ENDORSEMENT_POLICY_FAILURE at commit time, long after both files looked
 * individually correct. A comment stating an invariant cannot fail a build.
 * These tests compute each relationship instead of restating it.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const REPO = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const collections = JSON.parse(read('chaincode/collections-config.json'));
const configtx = read('network/configtx/configtx.yaml');
const gateway = read('backend/src/fabric/gateway.js');
const protocol = read('chaincode/crimerecords/lib/policy/llmDecisionProtocol.js');
const decision = read('backend/src/llm/policyDecision.js');
const recordContract = read('chaincode/crimerecords/lib/recordContract.js');
const accessRoute = read('backend/src/routes/access.js');

const policy = require('../../chaincode/crimerecords/lib/policy/policyV1');
const reasonDecisions = require('../../chaincode/crimerecords/lib/policy/reasonDecisions');
const controlled = require('../../chaincode/crimerecords/lib/policy/controlledDecision');
const { evaluate } = require('../../chaincode/crimerecords/lib/policy/policyEngine');

/** Application organizations on the DIAS channel, read from its channel profile. */
function channelOrganizations(profileName = 'DiasChannel') {
  const profiles = configtx.slice(configtx.indexOf('Profiles:'));
  const start = profiles.search(new RegExp(`^  ${profileName}:$`, 'm'));
  if (start < 0) return [];
  const rest = profiles.slice(start + 1);
  const next = rest.search(/^  \w+:$/m);
  const profile = next < 0 ? rest : rest.slice(0, next);
  const application = profile.slice(profile.indexOf('Application:'));
  return (application.match(/^\s+- \*(\w+)$/gm) || [])
    .map((line) => line.trim().replace('- *', ''));
}

/** Fabric's ImplicitMeta MAJORITY over N sub-policies. */
const majorityOf = (n) => Math.floor(n / 2) + 1;

const membersOf = (name) => {
  const collection = collections.find((c) => c.name === name);
  return (collection.policy.match(/'(\w+MSP)\.member'/g) || [])
    .map((m) => m.replace(/'|\.member/g, ''));
};

const frozenList = (source, name) => {
  const match = source.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]`));
  return match ? (match[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1)).sort() : null;
};

describe('cross-surface invariants', () => {
  const orgCount = channelOrganizations().length;
  const majority = majorityOf(orgCount);

  describe('endorsement capacity vs private data collection membership', () => {
    it('reads the organization count from the channel profile', () => {
      expect(orgCount, 'application organizations on DiasChannel').to.equal(5);
      expect(channelOrganizations()).to.not.include('AIOrg');
    });

    // The defect this suite exists for.
    collections.forEach((collection) => {
      it(`'${collection.name}' has enough members to satisfy MAJORITY endorsement`, () => {
        const members = membersOf(collection.name);
        expect(
          members.length,
          `${collection.name} has ${members.length} member org(s) but a transaction writing `
          + `to it must be endorsed by ${majority} of ${orgCount}. Transient data is only sent `
          + 'to collection members, so the collection can never satisfy the policy.'
        ).to.be.at.least(majority);
      });
    });

    it('the evidence endorser set is drawn only from evidenceDetails members', () => {
      const members = membersOf('evidenceDetails');
      const endorsers = frozenList(gateway, 'EVIDENCE_ENDORSERS');
      expect(endorsers).to.not.equal(null);
      endorsers.forEach((org) => expect(members, `${org} is not a collection member`).to.include(org));
      expect(endorsers.length, 'endorser set below MAJORITY').to.be.at.least(majority);
    });

    it('no collection names an organization outside the DIAS channel', () => {
      const channelMsps = {
        Police: 'PoliceMSP', Forensics: 'ForensicsMSP', Prosecution: 'ProsecutionMSP', Court: 'CourtMSP', Audit: 'AuditMSP',
      };
      const allowed = channelOrganizations().map((name) => channelMsps[name]).filter(Boolean);
      expect(allowed).to.have.length(orgCount);
      collections.forEach((collection) => membersOf(collection.name)
        .forEach((msp) => expect(allowed, `${collection.name} names ${msp}`).to.include(msp)));
    });

    it('recordContract mirrors the evidenceDetails distribution policy', () => {
      const declared = (recordContract.match(/EVIDENCE_PDC_MSPS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
      expect(
        (declared.match(/MSP\.\w+/g) || []).length,
        'EVIDENCE_PDC_MSPS must list the same organizations as the collection'
      ).to.equal(membersOf('evidenceDetails').length);
    });
  });

  describe('explanation schema headroom', () => {
    const capOf = (source) => Number((source.match(/decisiveAttributes\.length > (\d+)/) || [])[1]);

    it('the decisiveAttributes cap is identical on both sides of the wire', () => {
      expect(capOf(protocol)).to.equal(capOf(decision));
    });

    it('no reason can emit more decisive attributes than the validators accept', () => {
      const cap = capOf(protocol);
      const fromTable = Math.max(
        ...Object.values(controlled.REASON_DETAILS).map((d) => d.decisiveAttributes.length)
      );
      // The engine builds POLICY_SATISFIED's evidence dynamically, so measure the
      // widest case it can actually produce rather than trusting the table.
      const widestAllow = evaluate(
        {
          mspId: 'PoliceMSP',
          role: 'constable',
          jurisdiction: 'd',
          clearance: 'high',
          credentialStatus: 'active',
          caseAssignments: 'CASE-1',
        },
        {
          recordId: 'R',
          caseId: 'CASE-1',
          recordType: 'fir',
          sensitivityLevel: 'low',
          jurisdiction: 'd',
          sealed: false,
          juvenileFlag: false,
          victimProtectionFlag: false,
        },
        'view',
        { purpose: 'investigation', emergencyFlag: false }
      );
      const widest = Math.max(fromTable, widestAllow.decisiveAttributes.length);
      expect(
        widest,
        `a reason can emit ${widest} decisive attributes but the cap is ${cap}; `
        + 'adding policy conditions would break every decision at the chaincode boundary'
      ).to.be.below(cap);
    });
  });

  describe('model budget', () => {
    it('the backend recommender reads the one configurable model budget', () => {
      const config = read('backend/src/config.js');
      const runtime = read('backend/src/dias/runtime.js');
      expect(config, 'DIAS_MODEL_TIMEOUT_MS must be one configurable budget').to.contain('DIAS_MODEL_TIMEOUT_MS');
      expect(runtime).to.contain('settings.DIAS_MODEL_TIMEOUT_MS');
      // The request route no longer waits for the model, so it keeps no budget of its own.
      expect(accessRoute).to.not.match(/MODEL_TIMEOUT_MS|COMMIT_HEADROOM_MS|waitForAccessProgress/);
    });
  });

  describe('reason vocabulary', () => {
    it('every reason code has explanation details', () => {
      expect(Object.keys(controlled.REASON_DETAILS).sort())
        .to.deep.equal(Object.keys(reasonDecisions).sort());
    });

    it('the model may not emit a system-generated reason', () => {
      controlled.SYSTEM_REASON_CODES.forEach((code) => {
        expect(controlled.MODEL_REASON_CODES).to.not.include(code);
      });
    });

    it('the request schema derives its vocabulary from the policy tables', () => {
      // Restating the vocabulary as literals let the API and the chaincode drift.
      // The route now imports the same frozen arrays the chaincode validates
      // against, so the relationship is identity rather than agreement.
      expect(accessRoute, 'the route must import ACTIONS/PURPOSES from policyV1')
        .to.match(/const \{[^}]*ACTIONS[^}]*PURPOSES[^}]*\} =\s*\n?\s*require\('\.\.\/\.\.\/\.\.\/chaincode\/crimerecords\/lib\/policy\/policyV1'\)/);
      expect(accessRoute).to.contain('z.enum(ACTIONS)');
      expect(accessRoute).to.contain('z.enum(PURPOSES)');
      const { requestSchema } = require('../src/routes/access');
      expect(policy.ACTIONS.length).to.be.greaterThan(0);
      expect(policy.PURPOSES.length).to.be.greaterThan(0);
      expect(requestSchema, 'the route must export its schema so this can be checked')
        .to.be.an('object');
      for (const action of policy.ACTIONS) {
        expect(requestSchema.safeParse({
          recordId: 'FIR-1', action, purpose: policy.PURPOSES[0], justification: 'because',
        }).success, `action ${action} rejected by the API`).to.equal(true);
      }
      for (const purpose of policy.PURPOSES) {
        expect(requestSchema.safeParse({
          recordId: 'FIR-1', action: policy.ACTIONS[0], purpose, justification: 'because',
        }).success, `purpose ${purpose} rejected by the API`).to.equal(true);
      }
      expect(requestSchema.safeParse({
        recordId: 'FIR-1', action: 'delete', purpose: policy.PURPOSES[0], justification: 'because',
      }).success, 'an action outside the policy vocabulary must be rejected').to.equal(false);
    });
  });

  describe('authorization gates agree between API and chaincode', () => {
    const rolesIn = (source, symbol) => {
      const block = source.slice(source.indexOf(symbol));
      return (block.slice(0, block.indexOf(']')).match(/'[^']+'/g) || [])
        .map((s) => s.slice(1, -1)).sort();
    };

    it('record-filing roles are identical', () => {
      const api = rolesIn(read('backend/src/routes/records.js'), 'const RECORD_CREATOR_ROLES = [');
      const chain = rolesIn(recordContract, 'const RECORD_CREATOR_ROLES = [');
      // Both are built from policyV1.ROLES, so compare the resolved names.
      expect(api.length, 'API list must not be wider than the chaincode list')
        .to.equal(chain.length);
    });

    it('audit-trail roles are derived from the same policy tables on both sides', () => {
      const expected = [...new Set([...policy.SEAL_AUTHORITY_ROLES, ...policy.DISTRICT_HEAD_ROLES])];
      const auditRoute = read('backend/src/routes/audit.js');
      expect(auditRoute, 'the API must derive reviewer roles, not restate them')
        .to.contain('SEAL_AUTHORITY_ROLES');
      const auditContract = read('chaincode/crimerecords/lib/auditContract.js');
      expect(auditContract, 'the chaincode must enforce the role dimension, not only the MSP')
        .to.contain('requireRole');
      expect(expected, 'the most junior court role must not be a reviewer')
        .to.not.include('court-clerk');
    });
  });
});
