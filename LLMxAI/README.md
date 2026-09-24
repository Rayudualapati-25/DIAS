# LLMxAI — standalone explainable policy model

LLMxAI is the separated, LLM-only version of the explainable access-control
research prototype. A registered demo user selects a protected resource and
submits a natural-language query. The fine-tuned Qwen3-14B model interprets the
action and purpose, applies the learned policy, and emits `allow`, `deny`, or
`escalate` with a controlled reason code.

This runtime has no blockchain, Hyperledger Fabric, chaincode, wallet, or
on-chain/off-chain dependency.

## Decision path

```text
registered profile + local resource + user query
                       │
                       ▼
         Qwen3-14B + selected V4 LoRA adapter
                       │
                       ▼
      strict JSON/schema/consistency validation
                       │
                       ▼
       model decision + explanation + counterfactual
```

For a schema-valid, internally consistent response, the displayed decision is
exactly the decision emitted by Qwen. The runtime does not run the deterministic
policy oracle during live inference. If the model contradicts its own reason
code or returns malformed output, the wrapper visibly safety-escalates instead
of silently changing or allowing the request.

The heading `LEDGER RESOURCE` remains in the prompt only because the V4 adapter
was trained with that exact label. In this project, the data comes from
`data/resources.json`; no ledger is contacted.

## Run locally

Requirements: Apple Silicon, Python 3.13, Node.js 20 or newer, and enough memory
to serve Qwen3-14B in four-bit MLX format.

```bash
cd "/Users/venkatrayudu/Workspace/LLMxAI"
python3 -m venv .venv
.venv/bin/python -m pip install -r experiments/llm_policy_engine/requirements.txt
npm run model
```

In a second terminal:

```bash
cd "/Users/venkatrayudu/Workspace/LLMxAI"
npm start
```

Open <http://127.0.0.1:3002/>. No `npm install` is necessary because the web
runtime uses Node's standard library and has no package dependencies.

Both servers must be running. If port 8080 is down, `/api/health` reports
`ready: false` and the console shows `Qwen offline`; the interface then has no
model to call.

## Sign in, then ask

The console requires a signed-in identity. `/login.html` accepts a registered
officer identifier and issues an `HttpOnly`, `SameSite=Strict` session cookie.
After signing in the requester types the access request in their own words and
names a record identifier such as `REC-FIR-001`, or pins one with the resource
selector.

Subject attributes are read from the session on the server. `POST /api/decide`
ignores any `profileId` in the request body, so neither the browser nor the
query text can select or change the requester identity — only the record
identifier is read from untrusted prose, and every resource attribute is then
looked up from the registry.

| Route | Method | Purpose |
|---|---|---|
| `/api/directory` | GET | Registered officer identifiers for the sign-in screen |
| `/api/login` | POST | Bind a session to one registered profile |
| `/api/logout` | POST | Destroy the session |
| `/api/session` | GET | The signed-in profile, or 401 |
| `/api/context` | GET | Signed-in profile, resources, policy labels |
| `/api/decide` | POST | Model decision for the signed-in identity |
| `/api/health` | GET | Model reachability and adapter verification |

## Reproducibility in the interface

The console shows a reproducibility panel with every decision: model version,
adapter SHA-256, prompt SHA-256, raw model output SHA-256, and the decoding
settings. A button re-submits the identical request and reports whether the raw
output hash is unchanged.

The interface and the offline evaluator import the same prompt contract
(`experiments/llm_policy_engine/policy_prompts.js` re-exports `src/policy.js`)
and use identical decoding — `temperature 0`, `top_p 1`, `seed 42`,
`max_tokens 192`. An identical request therefore returns the same decision the
retained evaluation measured.

## Registered demonstration users

The interface includes six local profiles: an assigned investigating officer,
a cross-jurisdiction inspector, a suspended inspector, a forensic analyst, a
public prosecutor, and an auditor. Their policy attributes are defined in
`data/profiles.json`; the protected resource examples are in
`data/resources.json`.

These are demonstration profiles, not a production authentication system. The
sign-in screen has no password store and verifies no credential; it demonstrates
attribute binding only. A real deployment must replace it with a verified
identity provider and a verified resource attribute provider.

## Verify

```bash
npm test
node experiments/smoke_standalone.js
SEBA_DATA_DIR=data_v4 \
SEBA_AUDIT_OUTPUT=experiments/runs/new_audit/report.json \
node experiments/llm_policy_engine/audit_dataset.js
```

Retained evidence from the completed V4 experiment:

- selected adapter SHA-256:
  `bdb012513c123311821a8f2a7c10c290dd6dfa52dd51632954484aac2efc873b`;
- decision-balanced 60-example suite: 93.33% decision accuracy, 90.00%
  joint decision-and-reason accuracy, and 2.00% false-allow rate among expected
  non-allows;
- full 360-example test: 91.39% decision accuracy, 88.06% joint accuracy, and
  7.33% false-allow rate among expected non-allows;
- live separated-runtime smoke: expected allow, deny, and escalate cases all
  passed with the V4 model as the decision source.

The JSON evidence is retained under `experiments/runs/`; comparison tables and
plots are under `results/tables/` and `results/plots/`. These results are from
synthetic, oracle-labelled examples and do not establish publication readiness
or production safety by themselves.

## Project map

- `src/` — standalone registry binding, prompt contract, model client, and API.
- `public/` — user query interface.
- `data/` — local registered users and protected resource examples.
- `tests/` — output-contract and trusted-context tests.
- `experiments/llm_policy_engine/` — datasets, training/evaluation scripts,
  adapters, and the offline deterministic labelling oracle.
- `experiments/runs/` — retained logs, configs, metrics, and live smoke output.
- `results/` — retained tables and plots.
- `reports/iteration/` — evidence-based progress and limitations.
- `2511.20284v2.pdf` — the pre-existing attached PDF, preserved unchanged.

## Important limitations

- The deterministic oracle is used only to generate and audit training labels;
  the live decision route uses Qwen.
- The sign-in screen demonstrates session-bound attribute binding but is not
  user authentication: any registered officer identifier is accepted without a
  credential check.
- MLX-LM's built-in server is appropriate for local research, not a hardened
  production service.
- The full-test false-allow rate is still too high for unsupervised deployment.
  High-impact use requires external datasets, human review of escalations,
  stronger adversarial evaluation, and calibrated abstention.
