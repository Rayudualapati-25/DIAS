'use strict';

/**
 * Prompt v1 is frozen. The published dataset and the reported V7 evaluation used
 * it, and the live system moved to prompt v2 in the v3 revision (plan step 5).
 * This test rebuilds every tracked prompt from its recorded facts and
 * justification and compares the digest with the one stored when the dataset was
 * generated, so any change to the v1 prompt text fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createPolicyContextProvider } = require('../../../../backend/src/dias/policyContextProvider');
const {
  PROMPT_VERSION_V1, buildRecommendationMessagesV1,
} = require('../../../../backend/src/dias/recommendationPrompt');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const provider = createPolicyContextProvider({});
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const caseFiles = fs.readdirSync(DATASET).filter((name) => name.endsWith('.cases.jsonl')).sort();

test('the dataset manifest names the v1 prompt', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATASET, 'manifest.json'), 'utf8'));
  assert.equal(PROMPT_VERSION_V1, 'dias-recommendation-prompt-v1');
  assert.match(JSON.stringify(manifest), /dias-recommendation-prompt-v1/);
});

for (const file of caseFiles) {
  test(`prompt v1 reproduces every recorded prompt in ${file}`, () => {
    const cases = fs.readFileSync(path.join(DATASET, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let compared = 0;
    for (const example of cases) {
      if (!example.promptHash) continue;
      const messages = buildRecommendationMessagesV1({
        verifiedRequest: example.verifiedRequest,
        policyContext: provider.assemble(example.verifiedRequest),
        justification: example.justification,
      });
      const promptText = messages.map((m) => `${m.role}:${m.content}`).join('\n');
      assert.equal(sha256(promptText), example.promptHash, `${file} ${example.exampleId}`);
      compared += 1;
    }
    assert.ok(compared > 0, `${file} has no recorded prompt hashes`);
  });
}
