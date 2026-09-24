# The model as a network participant

> **Historical design (retired 2026-09-15).** DIAS no longer has an AI
> organization. The LLM now runs in the application backend, its recommendation
> stays off-chain, and the ledger records only the request and the auditor
> decision with whether it agreed with the LLM, on the five-organization
> `diaschannel`. See [architecture.md](architecture.md) for the current design.
> This page is kept because the retained evidence in
> `experiments/runs/20260912_dias_live_fabric/` was produced under it.

The policy model is not a library the API calls. It is an **organisation on the
channel** — `AIOrgMSP` — with its own peer, its own CA, its own enrolled
identity, and its own transactions.

That framing is the point of the design, and it is also its main limitation, so
both are stated here.

## What that buys

**Attribution.** A recommendation is a transaction signed by
`AIOrgMSP/llm-decider`. The request that prompted it is a different transaction
signed by the requester. Two organisations, two signatures — which is what
proves the model answered as itself rather than under the requester's
certificate.

**A real authorisation boundary.** `GetAccessRequestForRecommendation` admits
only the `llm-decider` role of `AIOrgMSP`. `SubmitLLMRecommendation` and
`RecordLLMRecommendationUnavailable` do the same. Live scenario N confirms it on
a running network: a police inspector and an audit district head both tried to
record a recommendation and both were refused.

**No back channel.** Everything the model sees reaches it through the chain: the
verified attributes from committed state, the justification from a private
collection the AI organisation is a member of. The API server cannot slip the
model an extra fact, because it never talks to the model at all.

**The model's peer holds the question.** `AIOrgMSP` is in the endorsing set for
`CreateAccessRequest`, so its peer receives the transient justification directly
rather than waiting to pull it from a neighbour.

## What it deliberately does not buy

**The model has no authority.** It cannot write an `AccessDecision`. It cannot
create, match or revoke a dynamic authorization. Being an organisation on the
channel gives it the ability to *say* something, attributably; it gives it no
ability to *do* anything.

**Inference is off-chain, and must be.** A 14B model cannot run inside a
chaincode container, and determinism across endorsers would be impossible if it
could. What is on-chain is the *record*: which model, which revision, which
adapter hash, which prompt version, which policy bundle, the hash of the exact
prompt, the hash of the raw output, the token counts, the latency breakdown, and
an Ed25519 signature binding all of it to that request's committed facts.

**Re-execution is not reproduction.** The chain can prove *that this registered
model, on this prompt, produced this output* — because the operator signed for
it. It cannot re-run the inference to check. That is the honest boundary of
on-chain provenance for a large model, and no amount of hashing changes it.
Anyone claiming otherwise is describing a different system.

## Registration

A model is registered before it may attest anything:

```
modelId · modelFamily · baseModel · baseModelRevision · quantization
adapterId · adapterHash · promptVersion · responseSchemaVersion
registrationPurpose · Ed25519 public key
```

Registration is a governance act by an AuditMSP district head. Registrations are
never overwritten; activation moves a pointer, so a previous model can be
re-activated and the key history keeps the record.

The registration script refuses to register or activate an adapter-backed model
unless it can read the adapter directory and recompute the same digest. A
registration whose hash describes no local bytes cannot be checked by anyone
later, which makes it worse than no registration at all.

Provenance is validated against the **registered** model, so a running service
cannot describe itself as something it is not: its identity comes from the
ledger, and only its endpoint comes from local configuration.

## Failure is a first-class, attested outcome

When generation fails the service records a status —

| Status | Cause |
| --- | --- |
| `UNAVAILABLE` | unreachable, timed out, or the facts did not match their committed hashes |
| `INVALID_OUTPUT` | the answer was not a schema-valid recommendation |
| `CONTEXT_OVERFLOW` | the prompt did not fit |
| `POLICY_CONTEXT_UNAVAILABLE` | the policy bundle could not be assembled, or was not the active one |

— and **signs it**. An unsigned failure claim would be an unauthenticated way to
push a request to an auditor, so there is no unsigned path.

Nothing is invented to fill the gap. The auditor sees "no recommendation, and
here is why", must give a reason, and no authorization is created whatever they
decide. Live scenarios I and J demonstrate both halves.

## Restart, replay and duplicates

The service is stateless apart from a block checkpoint. It advances the
checkpoint past events it did not answer, so a Fabric block holding several
events cannot cause a later one to be skipped, and it **never** checkpoints a
request it failed to answer — advancing there would make a pending request
unreachable after a restart.

Answering is idempotent: a request that has left the recommendation step is a
no-op. Live scenarios K and L cover both, on chain.

## Why not have the model decide?

Because the failure modes are not symmetric and not recoverable.

A wrong recommendation that an auditor reads is a wrong sentence on a screen. A
wrong *decision* is a case file opened. Prompt injection, a bad fine-tune, a
model server swapped underneath the registration, or simple error all produce
the first; none of them can produce the second, because the authority is not
there to be taken.

The cost is real and worth stating: every policy miss needs a human. DIAS
reduces that load with dynamic authorizations, which is why the one path that
creates one — a model DENY an auditor overrode — is also the most carefully
constrained thing in the system.
