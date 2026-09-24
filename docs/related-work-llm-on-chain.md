# Related Work: Running an LLM "Inside" a Blockchain

Literature search, September 2026. Every figure below was read from the paper's
own abstract, not from a secondary summary; where a claim could not be verified
at source it is marked as such.

---

## 1. The headline finding

**No published work executes a large language model inside a blockchain virtual
machine or smart contract.** The closest results fall into three groups, none of
which puts the model itself on chain:

1. **Prove it afterwards** — run the model off-chain, verify a cryptographic
   proof on-chain (zkML).
2. **Assume it, then challenge it** — run off-chain, publish the result, and
   settle disputes with an on-chain fraud proof (opML).
3. **Shrink it until it fits** — compile a genuinely small model into contract
   code and execute it on-chain (ML2SC).

This is consistent with the determinism and resource limits documented in
`docs/llm-on-chain-challenges.md`. It also means the phrase "LLM on the
blockchain" in the literature almost always denotes *verified off-chain
inference*, not on-chain execution.

---

## 2. Prove it afterwards — zkML

**zkLLM: Zero Knowledge Proofs for Large Language Models.**
Haochen Sun, Jason Li, Hongyang Zhang. ACM CCS 2024. arXiv:2404.16109.

Verified from the abstract:

> "for LLMs boasting 13 billion parameters, our approach enables the generation
> of a correctness proof for the entire inference process in under 15 minutes.
> The resulting proof, compactly sized at less than 200 kB"

Contributes `tlookup` for non-linear tensor operations and `zkAttn` for attention
and softmax. Proof *verification* is cheap; proof *generation* is the obstacle —
15 minutes per inference rules it out for an interactive access decision, though
not for after-the-fact audit.

*(A verification time of 1–3 s is widely quoted but does not appear in the
abstract; confirm in the body before citing.)*

---

## 3. Assume it, then challenge it — opML

**opML: Optimistic Machine Learning on Blockchain.**
KD Conway, Cathie So, Xiaohang Yu, Kartin Wong. arXiv:2401.17555, January 2024.

Claims execution of **7B-LLaMA on standard PCs without GPUs**, using an
interactive fraud-proof protocol in the style of optimistic rollups: a submitter
posts a result, and challengers may dispute it through an on-chain bisection game.

Cheaper than zkML, but the guarantee is weaker and *delayed*: correctness holds
only after a challenge window elapses with no successful dispute. For access
control that is the wrong shape — a file cannot be un-opened once released.

---

## 4. Shrink it until it fits — ML2SC

**ML2SC: Deploying Machine Learning Models as Smart Contracts on the Blockchain.**
Zhikai Li, Steve Vott, Bhaskar Krishnamachari. arXiv:2404.16967, March 2024.

A PyTorch→Solidity translator for **multi-layer perceptrons**, executing inference
genuinely on-chain and reproducing PyTorch outputs exactly by replacing floating
point with fixed-point arithmetic (PRBMath). Gas cost grows linearly with model
parameters.

This is the existence proof that on-chain inference is possible **once the model
is small enough and the arithmetic is integer**. It is also the direct evidence
for the distillation route: a compressed classifier could run in chaincode where
a 14B transformer cannot.

---

## 5. The closest prior work to this system

**Smart Blockchain-Based Access Control for the Internet of Things.**
Mahdi Manavi, Yunpeng Zhang, Guoning Chen. arXiv:2606.13798, 11 June 2026.

> "We propose a risk-adaptive enforcement layer for Hyperledger Fabric that
> couples an off-chain LSTM-based risk oracle with deterministic on-chain checks."

Architecturally this is the nearest neighbour and **must be cited and
differentiated**. Shared design decisions:

- Hyperledger Fabric, permissioned.
- Model inference **off-chain**; enforcement **on-chain**.
- The oracle issues a **signed attestation bound to the client identity and the
  target resource**.
- **Endorsing peers verify that attestation inside chaincode**, deterministically.
- No modification to ordering or consensus.

That is the same skeleton as this system, arrived at independently. The
differentiation must therefore be stated precisely rather than assumed.

| | Manavi et al. (2026) | This system |
|---|---|---|
| Model | LSTM risk classifier | Fine-tuned Qwen3-14B (LoRA), 4-bit |
| Output | 3 risk tiers (Low/Moderate/High) | 12 reason codes + decisive attributes + counterfactual |
| Input | request features | natural-language request + ledger-verified subject and resource attributes |
| Explanation | none | structured XAI artifact, hashed and committed |
| Model identity | oracle signs; not a network member | **the model operator is its own organisation with its own peer and MSP identity, and signs the decision as itself** |
| Independent check | none reported | deterministic policy engine re-executed on every endorser; disagreement forces human review |
| Domain | IoT | inter-agency criminal records |

**The defensible novelty is the last three rows**, not the off-chain-oracle
pattern itself. In particular: making the model operator a *first-class
organisation on the channel* — so the request and the decision are two
transactions signed by two different parties — appears to be unclaimed, as does
committing a validated natural-language explanation artifact alongside the
decision.

---

## 6. Adjacent but different

- **Towards Blockchain-Based Federated ML: Smart Contract for Model Inference**
  (Applied Sciences 11(3):1010) — logistic regression via an oracle plus Fabric
  chaincode; reports 2–4% median oracle overhead.
- **On-Chain Decentralized Learning and Cost-Effective Inference for DeFi Attack
  Mitigation** (arXiv:2510.16024) — on-chain L1 inference for small models;
  reports 57,603 gas for linear models and 143,647 for a small CNN.
- **VeriLLM** (arXiv:2509.24257) — publicly verifiable decentralised inference,
  Solidity verification contracts.
- A large body of work uses **LLMs to audit or generate smart contracts**
  (SmartLLM, SmartInv, SmartGuard). That is the inverse problem and should not be
  confused with running a model on-chain.

---

## 7. How to state the claim in the paper

Avoid "the LLM runs on the blockchain" — no published system does that, and a
reviewer familiar with this literature will challenge it immediately.

The accurate and stronger claim:

> Inference is performed off-chain by a model operator that is itself a member
> organisation of the permissioned network. The decision, its reason code and its
> explanation are committed on-chain, bound by signature to a model artifact
> registered on the ledger and by hash to the exact attributes the model was
> shown, and are re-verified deterministically by every endorsing peer.

Note also what remains open, since reviewers will ask: **executing a distilled
integer classifier inside chaincode** — the ML2SC route applied to the policy
task — would move learned decision logic genuinely on-chain, and is not addressed
by any of the work above in a permissioned access-control setting.
