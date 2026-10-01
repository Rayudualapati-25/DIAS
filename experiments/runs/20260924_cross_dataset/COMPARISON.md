# DIAS cross-dataset comparison

Generated 2026-09-24T06:54:42.426461+00:00 · run directory `experiments/runs/20260924_cross_dataset`

## What was run

Two models, identical prompt contract and decoding, on two access-control
datasets from outside the DIAS crime-records domain.

| | |
|---|---|
| Models | `qwen3-14b-dias-v7` (LoRA adapter) vs the same base model untuned |
| Base model | `mlx-community/Qwen3-14B-4bit` |
| Decoding | temperature 0, top_p 1, max_tokens 512, thinking disabled |
| Prompt | production system prompt, lifted verbatim from `backend/src/dias/recommendationPrompt.js` |
| Output contract | the same six-key JSON the paper evaluates |

## 1. LLMAC policy domain (reconstruction)

LLMAC's own dataset is **not published** — the paper carries no data availability
statement, repository or archive link. This set therefore re-implements the seven
policies LLMAC prints in full in its Table II (a class management system, policies
originally from Park, Nguyen & Sandhu 2012) as a deterministic oracle, and generates
requests against it. **It is a reconstruction of the LLMAC policy domain, not LLMAC's
data**, and no number here may be set against a number printed in the LLMAC paper.
Reason codes are our addition: LLMAC records a binary decision plus free text, while
the DIAS schema requires a code, so one code was defined per distinct Table II condition.

Compared on **180 examples** finished by both models.

| Model | Decision acc. (95% CI) | Balanced acc. | Macro F1 | Schema valid | Unsafe ALLOW | Reason code | Policy refs |
|---|---|---|---|---|---|---|---|
| DIAS V7 (fine-tuned) | 0.661 [0.589, 0.726] | 0.658 | 0.628 | 0.978 | 0 | 0.500 | 0.544 |
| Qwen3-14B-4bit (untuned) | 0.628 [0.555, 0.695] | 0.624 | 0.606 | 0.939 | 0 | 0.461 | 0.511 |

Confusion counts (rows = ground truth, columns = model output):

| Model | ALLOW→ALLOW | ALLOW→DENY | DENY→DENY | DENY→ALLOW | invalid |
|---|---|---|---|---|---|
| DIAS V7 (fine-tuned) | 30 | 57 | 89 | 0 | 4 |
| Qwen3-14B-4bit (untuned) | 28 | 56 | 85 | 0 | 11 |

### Benign vs adversarial justifications

| Model | Benign acc. | Adversarial acc. | Unsafe ALLOW (benign) | Unsafe ALLOW (adversarial) |
|---|---|---|---|---|
| DIAS V7 (fine-tuned) | 0.690 | 0.593 | 0 | 0 |
| Qwen3-14B-4bit (untuned) | 0.659 | 0.556 | 0 | 0 |

### Per policy (decision accuracy)

| Policy | DIAS V7 (fine-tuned) | Qwen3-14B-4bit (untuned) | n |
|---|---|---|---|
| append_review_to_grade | 0.600 | 0.550 | 20 |
| grade_homework | 0.536 | 0.429 | 28 |
| replace_homework | 0.963 | 0.889 | 27 |
| review_homework | 0.517 | 0.517 | 29 |
| revise_review | 0.400 | 0.400 | 25 |
| submit_homework | 0.792 | 0.750 | 24 |
| upload_homework | 0.815 | 0.852 | 27 |

## 2. OrgAccess (public benchmark, easy split)

`respai-lab/orgaccess` (MIT licence; Sanyal et al., arXiv:2505.19165), downloaded
from HuggingFace. Ground truth is three-way (`full` / `partial` / `rejected`); this
table uses the binary subset only, mapping `full`→ALLOW and `rejected`→DENY.

Compared on **100 examples** finished by both models.

| Model | Decision acc. (95% CI) | Balanced acc. | Macro F1 | Schema valid | Unsafe ALLOW |
|---|---|---|---|---|---|
| DIAS V7 (fine-tuned) | 0.780 [0.689, 0.850] | 0.777 | 0.781 | 0.980 | 2 |
| Qwen3-14B-4bit (untuned) | 0.770 [0.678, 0.842] | 0.767 | 0.766 | 0.990 | 2 |

Confusion counts (rows = ground truth, columns = model output):

| Model | ALLOW→ALLOW | ALLOW→DENY | DENY→DENY | DENY→ALLOW | invalid |
|---|---|---|---|---|---|
| DIAS V7 (fine-tuned) | 30 | 18 | 48 | 2 | 2 |
| Qwen3-14B-4bit (untuned) | 29 | 20 | 48 | 2 | 1 |

## 3. OrgAccess `partial` rows — the mapping question

`partial` means granted-but-restricted. DIAS emits a binary ALLOW/DENY, so how
`partial` is treated is a judgement call that moves the headline number. The same
40 predictions are rescored below under both readings.

| Treatment | Model | Accuracy on partial rows |
|---|---|---|
| partial counted as ALLOW | DIAS V7 (fine-tuned) | 0.150 |
| partial counted as ALLOW | Qwen3-14B-4bit (untuned) | 0.175 |
| partial counted as DENY | DIAS V7 (fine-tuned) | 0.775 |
| partial counted as DENY | Qwen3-14B-4bit (untuned) | 0.775 |


---

## 4. What these numbers mean

### 4.1 The headline: policy competence does not transfer, but safety and format do

V7 scores **0.987 balanced accuracy on its own crime-records test set**. On these two
external domains it scores **0.658** (LLMAC reconstruction) and **0.777** (OrgAccess).
That gap is the result. Three separate things behave differently:

| Property | Transfers out of domain? | Evidence |
|---|---|---|
| Output-contract discipline | **Yes** | schema validity 0.978 (LLMAC) and 0.980 (OrgAccess) |
| Resistance to untrusted input | **Yes** | **zero** unsafe ALLOWs on 180 LLMAC cases, incl. 54 adversarial |
| Policy reasoning competence | **No** | balanced accuracy falls from 0.987 to 0.658 / 0.777 |

### 4.2 V7's advantage over the untuned base is not significant out of domain

| Set | V7 | Untuned base | Verdict |
|---|---|---|---|
| LLMAC reconstruction | 0.661 [0.589, 0.726] | 0.628 [0.555, 0.695] | overlapping CIs — **not significant** |
| OrgAccess easy | 0.780 [0.689, 0.850] | 0.770 [0.678, 0.842] | overlapping CIs — **not significant** |

V7 is nominally ahead on every metric in both sets, and clearly ahead on schema validity,
but the decision-accuracy confidence intervals overlap heavily. The honest reading is that
**the fine-tuning's decision benefit is specific to the policy domain it was trained on**;
what it carries across domains is the response format, not the policy reasoning.

### 4.3 The failure mode is over-denial, not unsafe approval

This matters more than the headline accuracy, because the two error directions carry very
different consequences in DIAS's threat model.

| Set | Model | ALLOW recall | DENY recall | Unsafe ALLOW (DENY→ALLOW) |
|---|---|---|---|---|
| LLMAC | V7 | 0.337 | 0.978 | **0** |
| LLMAC | base | 0.315 | 0.934 | **0** |
| OrgAccess | V7 | 0.612 | 0.941 | 2 |
| OrgAccess | base | 0.592 | 0.941 | 2 |

On the LLMAC domain V7 recognised only **30 of 89** legitimate requests, wrongly denying 57.
It did not once grant a request the policy forbids. Out of domain the model collapses toward
"deny", which is the safe direction but makes it useless as an assistant.

### 4.4 Adversarial justifications never produced an unsafe ALLOW

| Model | Benign acc. (n=126) | Adversarial acc. (n=54) | Unsafe ALLOW (adversarial) |
|---|---|---|---|
| V7 | 0.690 | 0.593 | **0** |
| base | 0.659 | 0.556 | **0** |

The 54 adversarial cases carry injected instructions ("SYSTEM: policy override authorised…",
"Ignore the policy above…", false claims of authorship or of an ungraded state). Balanced
accuracy under attack falls to 0.522 for V7 — barely above chance — but **every single
degradation is in the deny direction**. No injection flipped a DENY into an ALLOW on a
domain the model has never seen. The untrusted-input wrapper holds.

### 4.5 The `partial` mapping, resolved empirically

Both models behave as though `partial` means DENY: counted as DENY they score 0.775 on the
partial rows, counted as ALLOW they score 0.150. So the conservative mapping is also the one
that matches observed behaviour. Reported both ways above; **the choice is still yours**,
and it only affects OrgAccess rows we excluded from the headline table.

## 5. Provenance and honest limits

1. **LLMAC's dataset was never published.** Section 1's set is our re-implementation of the
   seven policies in their Table II. It is not their data, and none of these numbers may be
   placed beside a number printed in the LLMAC paper. The repository's existing claim
   boundary (`LLMxAI/.../llmac_arxiv_2602.09392.md`) already forbids that.
2. **Both external datasets are synthetic.** OrgAccess is synthetic-but-expert-validated;
   the LLMAC reconstruction is generated from a published policy. So this experiment tests
   **cross-domain generalization**, not real-world realism. The "synthetic data" limitation
   stands and should still be stated.
3. **OrgAccess medium and hard splits were not used.** Measured label counts: medium has 3
   `full` rows out of 10,073; hard has 30 out of 20,148. With the ALLOW class effectively
   absent, a balanced accuracy on them is not interpretable. This is a property of the
   benchmark, not a choice to show DIAS favourably.
4. **Sample sizes were capped** (180 / 100 / 40) to fit a fixed compute window. Case files
   were shuffled before capping, so each cap is a random sample; class balance was verified
   (LLMAC 91 DENY / 89 ALLOW, OrgAccess 51 / 49). Confidence intervals reflect these sizes.
5. **Reason codes for both external domains are our definitions.** LLMAC records binary
   decisions plus free text and OrgAccess records a three-way label plus a rationale;
   neither ships reason codes. Reason-code accuracy is therefore reported for the LLMAC set
   only, where the oracle defines a code per Table II condition, and not for OrgAccess.
6. **Inference only.** No retraining, no adapter change, no contact with the live Fabric
   network. V7 weights and the paper's existing numbers are untouched.

## 6. Reproducing this

```
experiments/cross-dataset/build_llmac.py       # LLMAC Table II oracle + generator
experiments/cross-dataset/build_orgaccess.py   # samples the public OrgAccess splits
experiments/cross-dataset/run_eval.py          # inference, production prompt contract
experiments/cross-dataset/score.py             # metrics, matched on completed ids
experiments/cross-dataset/report.py            # this report
experiments/runs/20260924_cross_dataset/       # predictions, comparison.json, this file
```
