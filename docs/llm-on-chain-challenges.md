# Challenges of Executing an LLM Inside a Hyperledger Fabric Peer

Measured on the SEBA-XAI crime-records network: 5 organizations, 5 peers, one
channel, `MAJORITY` endorsement (3 of 5 organizations must agree), fine-tuned
Qwen3-14B-4bit as the access-control policy engine.

---

## 1. "LLM as a peer" is two different proposals

The phrase conflates two designs with very different feasibility, and it is worth
separating them before discussing challenges.

**(a) On-chain execution.** The model runs *inside* chaincode, so every endorsing
peer performs inference as part of validating the transaction. This is what
"AI on the blockchain" usually implies. Sections 2–7 concern this design.

**(b) The model operator as a network participant.** Inference stays off-chain,
but the AI service holds its own MSP identity and peer, and submits decisions as
itself. This is feasible today; its challenges are in Section 9.

A Fabric *peer* is a node that stores the ledger and endorses transactions. A peer
does not "contain" an application. So (a) is not really "the LLM as a peer" — it is
the LLM as chaincode, which is a stricter requirement.

---

## 2. Determinism — the fundamental blocker

Fabric's execute–order–validate model requires every endorsing peer to execute the
same chaincode over the same state and produce **byte-identical** read-write sets.
Divergent results fail the endorsement policy and the transaction is rejected.

Neural network inference is floating-point. Floating-point addition is not
associative: `(a + b) + c ≠ a + (b + c)`. The realised order of accumulation depends
on factors that are not uniform across five independently operated machines:

- SIMD width and vectorised reduction order (AVX-512, NEON, differing lane counts)
- BLAS / kernel library implementation and version
- thread count and scheduling in parallel reductions
- memory alignment selecting different kernel paths
- accelerator backend (CPU, GPU, Apple Metal)

A perturbation in the final logits changes the `argmax`, which changes one emitted
token, which changes the entire structured output. In this system that is the
difference between `ALLOW`, `DENY` and `ESCALATE`.

Because a divergence of one bit is sufficient, this is not a reliability problem to
be reduced by engineering; it is a categorical incompatibility with the consensus
model. **Every other item below is a cost. This one is a blocker.**

---

## 3. Resource limits — measured

| Quantity | Present system | With the model in chaincode |
|---|---:|---:|
| Chaincode package installed per peer | **56,387 bytes** | **~8 GB** (7,939 MB weights + 50 MB adapter) |
| Resident memory per model instance | n/a | **8.9 GB** |
| Instances required | 1 (off-chain) | **5** (one per peer) ≈ 45 GB |
| Container memory limit (measured) | 2 GiB | 2 GiB — **insufficient by ~4×** |
| GPU available to chaincode (measured) | n/a | **none** |
| Median decision latency | **~2,300 ms** off-chain | ≥ 2,300 ms, on every endorsing peer |
| Median ordinary chaincode read | **40–120 ms** | — |

The chaincode container is capped at 2 GiB and is granted no GPU device. The model
cannot be loaded at all, and would run on CPU if it could. Inference is already
20–50× slower than an ordinary ledger read; performing it redundantly on every
endorsing peer multiplies the cost without adding information.

---

## 4. Execution environment

Chaincode is deliberately sandboxed: no host filesystem, no outbound network, and a
bounded execution time (Fabric default 30 s; raised to 300 s in this deployment).
Consequences:

- Model weights must be *inside* the chaincode package, since fetching them at
  runtime would break both isolation and reproducibility.
- The runtime is Node.js. A 14-billion-parameter model would require a WASM or
  native inference stack embedded in the package.
- No GPU access removes the only reason current latency is ~2 s rather than minutes.

---

## 5. Governance and lifecycle coupling

Promoting a new model version is presently **one transaction** — the adapter's
SHA-256 digest and its Ed25519 signing key are registered on-chain.

With the model as chaincode, every retrain becomes a chaincode upgrade: repackage
~8 GB, install on all peers, obtain approval from a majority of organizations, and
commit a new definition sequence. Routine model iteration would become a
multi-party governance event, and rollback likewise.

---

## 6. Confidentiality of the model

The chaincode package is distributed to every endorsing peer. A fine-tuned
policy model *is* the encoded policy; distributing it gives every organization —
including those whose requests it adjudicates — the ability to extract the weights
and probe them offline. At present only the digest is public and the weights remain
with the operator.

---

## 7. Denial of service

Inference on every endorsing peer makes request submission asymmetrically cheap for
a client and expensive for the network: a request costing nothing to send obliges
five peers to perform seconds of computation. Off-chain, that cost is borne by a
single service that can rate-limit and queue.

---

## 8. Known approaches that relax the constraint

**Zero-knowledge ML (zkML).** Execute off-chain, then verify a succinct proof
on-chain that a committed model evaluated committed inputs to a declared output.
Verification is integer arithmetic and therefore deterministic. The obstacle is
proof-generation cost. Sun, Li and Zhang (zkLLM, ACM CCS 2024, arXiv:2404.16109)
report, for a 13-billion-parameter model, "the generation of a correctness proof
for the entire inference process in under 15 minutes", with a proof "compactly
sized at less than 200 kB". Acceptable for after-the-fact audit; not for an
interactive access decision.

**Quantised integer model.** Removing floating point removes the
non-determinism, and the resulting module executes identically across peers. This
genuinely works, but only for a small model. Li, Vott and Krishnamachari (ML2SC,
arXiv:2404.16967) demonstrate it concretely: a PyTorch-to-Solidity translator that
executes multi-layer-perceptron inference on-chain and reproduces PyTorch outputs
exactly by replacing floating point with fixed-point arithmetic, with gas cost
growing linearly in model size. A plausible variant here is to distil the policy
behaviour into such a classifier and execute *that* on-chain, retaining the LLM
only for natural-language understanding and explanation.

**Optimistic ML (opML).** Conway et al. (arXiv:2401.17555) run inference off-chain
and settle disputes through an on-chain interactive fraud proof, reporting
execution of 7B-LLaMA on machines without GPUs. Cheaper than zkML, but the
guarantee only holds once a challenge window has closed — the wrong shape for
access control, since a released file cannot be un-released.

---

## 9. What is feasible: the operator as a network participant

Design (b) avoids every blocker above, because inference remains off-chain. Its own
challenges are engineering rather than categorical:

- The requester's attributes must be captured in the request transaction rather
  than derived from whoever signs the decision transaction, so that the AI can sign
  as itself without the decision being attributed to the wrong subject.
- The request and the decision become two transactions linked by a ledger event,
  requiring a durable event listener with checkpointing and idempotent replay.
- Adding an organization to a running channel requires a channel configuration
  update approved by the existing members.
- The endorsement policy must be reconsidered: with six organizations, `MAJORITY`
  becomes 4 rather than 3.

---

## 10. The architecture adopted, and what it guarantees

Inference is performed off-chain; **verification and enforcement are on-chain**.
Each decision is committed with:

- the decision, reason code and structured explanation;
- a hash of the exact ledger-derived attributes the model was shown, rejecting the
  transaction if that state changed between inference and commit;
- a hash of the natural-language query;
- an **Ed25519 signature verified against the adapter digest registered on-chain**;
- the active policy version.

Every one of these checks is hashing and signature verification over integers, and
is therefore deterministic across all five peers.

The resulting guarantee is not that the chain executed the model, but that it can
prove, permanently and tamper-evidently, that **a specific registered model observed
a specific set of ledger facts and produced a specific decision** — while a
deterministic policy engine, re-executed on every peer, remains the authority that
can override it.

---

## 11. Where this sits in the literature

No published system executes a large language model inside a blockchain virtual
machine. The nearest architectural neighbour is Manavi, Zhang and Chen
(arXiv:2606.13798, June 2026), which couples "an off-chain LSTM-based risk oracle
with deterministic on-chain checks" on Hyperledger Fabric, has the oracle issue a
signed attestation bound to the client identity and target, and has endorsing
peers verify that attestation in chaincode — the same skeleton as the design
described here, reached independently with a much smaller model and no
explanation artifact. A fuller comparison is in
`docs/related-work-llm-on-chain.md`.
