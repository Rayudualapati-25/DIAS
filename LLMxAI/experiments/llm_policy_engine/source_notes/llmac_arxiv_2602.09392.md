# Source note: LLMAC (arXiv:2602.09392v1)

Retrieved: 2026-09-01  
Primary source: <https://arxiv.org/html/2602.09392>  
Authors: Sharif Noor Zisad and Ragib Hasan  
Version/date reported by arXiv: v1, 10 February 2026

## Facts used from the base paper

- LLMAC uses a three-part architecture: a policy-to-synthetic-dataset
  generator, a fine-tuning/evaluation module, and a trained-LLM runtime.
- Its synthetic examples contain request context, system/resource state, a
  ground-truth decision, and a natural-language explanation tied to policy
  conditions.
- It fine-tunes Mistral 7B with LoRA and deploys that trained model to make the
  live access decision and produce an explanation.
- The reported experiment generates 10,000 examples but trains on 10% because
  of compute limits, with balanced representation across seven policy/action
  categories.
- It compares the trained model with RBAC, ABAC, and DAC baselines using
  accuracy, precision, recall, macro-F1, and operational measurements.
- The paper identifies higher LLM inference latency as a trade-off. Its future
  work explicitly includes prompt-injection/data-leakage threats and stronger
  policy conformance through formal verification.

## What this repository adopts

- The learned model, not a deterministic fallback, is the proposed runtime
  decision authority.
- A synthetic policy-oracle dataset trains the model to emit a decision and a
  policy reason together.
- Parameter-efficient adaptation and explicit untuned baselines are retained.

## What this repository changes or adds

- Qwen3-14B replaces Mistral 7B and is adapted locally with MLX QLoRA.
- The output is ternary (`allow`, `deny`, `escalate`) and uses a fixed reason
  vocabulary. The runtime materializes a controlled explanation, decisive
  attributes, and counterfactual from the model-selected reason without
  re-evaluating or changing the authorization decision. This is a deliberate
  grounding layer rather than free-form explanation generation.
- Identity and resource attributes do not come from self-reported query text.
  Fabric supplies a minimized context from the authenticated certificate and
  governed ledger state.
- Held-out prompt-injection queries are part of the evaluation rather than only
  future work.
- Fabric registers the exact adapter digest and attestation public key, then
  checks freshness and signature bindings before retaining a model decision.
  These checks establish provenance and integrity, not semantic correctness.
- The evaluation measures false allows, exact reason fidelity, explanation
  attribute fidelity, schema validity, and trusted-subject ablation in addition
  to decision accuracy and latency.

## Claim boundary

The base paper's reported numbers are not evidence for this implementation and
must never be copied into this project's result tables. This project can cite
only its own retained evaluation artifacts. A synthetic criminal-record policy
experiment does not by itself establish legal validity, field safety, or
generalization to real agency data.
