# DIAS v3 — reconciliation of the written description with the code

- **Purpose:** list every place where the written description (manuscript v13, 2026-09-28) and the code disagree, and say which side changes.
- **What this file holds:** the manuscript itself stays outside this repository. This file names the needed corrections only; it holds no manuscript text and changes nothing in it.
- **Rule:**
  - the Methodology (§IV) is the target design, and v3 implements it;
  - factual statements about results must follow measured evidence;
  - no code, label, metric or scoring rule is changed to agree with a printed number.
- **Classes:**
  - **CODE** — the code changes to meet the text (tracked in `docs/design/dias-v3-requirements-traceability.md`);
  - **TEXT** — the text must change;
  - **AFTER-RUN** — the text can change only after the v3 experiments are run on the Mac.

## 1. Implemented in v3 (text becomes true once v3 results exist)

| Item | Manuscript location | v13 states | v3 code | Class |
|---|---|---|---|---|
| κ before review | §IV-A, §IV-D Eq. (2), Alg. 1 l.12–16, Fig. 2 caption | κ committed before review | `CommitRecommendation` | CODE, then AFTER-RUN for §V wording |
| Implementation sections that deny κ | §V-A (p11), §V-C (p12), §V-F (p14), §VII (p18) | "recorded … not before review"; "no earlier commitment κ" | Contradicted by v3; must be rewritten after v3 is evaluated | AFTER-RUN |
| `v_P` binding | §IV-C, §IV-F, §IV-G, Alg. 1 l.5–6, 24–25, 36, Table II | reuse and release bound to `v_P` | Implemented with governed activation | CODE, then AFTER-RUN for §V-E ("does not store or compare `v_P`") |
| `h_J`, `h_M`, `h_N` | §IV-C, §IV-E, §IV-G, Table II | on-chain hashes | Implemented, domain-separated (design §4) | CODE; text should name the hashing rule |
| Note before decision | §IV-E, Alg. 1 l.18, 29–30 | stored first, `h_N` required | Implemented; no cross-store atomicity (design §11) | CODE; text must not claim atomicity across stores |
| Auditor-side H(M) check | §IV-D, Alg. 1 l.16 | interface verifies before decision | Backend and frontend both verify | CODE |
| Generation status on-chain | §IV-B | "UNAVAILABLE, INVALID OUTPUT" | Five statuses committed | TEXT: list all five |
| Lifecycle events | §IV-G | includes commitment and agreement events | `RECOMMENDATION_COMMITTED`, `AGREEMENT_DERIVED` added | CODE |
| Final release re-check | §IV-G | re-checked at release | `AuthorizeRequestedDocumentRead` now re-checks | CODE |
| Counterfactuals | C3 (§II) | "what would have to change" | Policy-verified counterfactuals (design §13) | CODE; text must say they come from the written-policy oracle and are explanation support only |

## 2. Text corrections independent of v3

| ID | Location | Problem | Evidence | Correction |
|---|---|---|---|---|
| T1 | §IV-C | C said to contain the stable identity and record identifier | `lib/dias/verifiedRequest.js`; design D-01 | Say identity and record are bound through the request and σ, not inside C |
| T2 | §IV-A | Backend missing from the trusted base | design §2 | Add the backend, and what v3 does and does not remove |
| T3 | Abstract | "up to 23.75%" | Superseded replay (`experiments/runs/20260916_dias_scope_workload_sweep/SUPERSEDED.md`) | Use the live run's 21.0% (504/2,400), or the v3 rerun once it exists |
| T4 | §II (p5) | 60.27% mixes conventions with Table VII | `metrics.js:11-14`; accuracy CSV | 56.0% under Table VII's rule, or define one convention |
| T5 | §VI-E, Table XIII note | "three failures preceded the fault" | `raw/e7-fault-…/backend-trace.jsonl` | All four were ledger writes in flight during the failover |
| T6 | Fig. 3 text | "0.002–0.007" | `training.log` (0.008 at 1,750) | "0.002–0.008" |
| T7 | Fig. 13(j) | RSS shown as model memory | `raw/mac/mac-samples.csv` | Show GPU memory, or caption the limitation |
| T8 | All experiments | Scripted auditor disclosed only for E5 | `REPORT.md` §0; reuse plan | Disclose for every run; mention the 24 reuse grants that followed model false ALLOWs |
| T9 | Table VI | 60 complete-request examples listed without a result | `workflow-evaluation.cases.jsonl` | Remove the row, or report it |
| T10 | Title, README, `CITATION.cff` | Three different names | — | One name everywhere |
| T11 | §I | "Review Comments" section; no Conclusion | — | Remove; add a Conclusion |
| T12 | §II (p5) | "securely … with confidentiality" | Design §10: interface-level controls only; every member peer stores every block | Narrow the claim |
| T13 | §V-C | Genesis admission exception not mentioned | `userContract.js` `_requireOrgAdmin` | Mention it |
| T14 | Table V | v2 transaction list | Design §5–§8 | Add `CommitRecommendation`, `ExpirePendingRequest`, `CancelAccessRequest` and the policy and signer governance transactions |
| T15 | §IV-A | Auditor = "responsible oversight organization" | Design D-03 | State the district and clearance rule |
| T16 | §IV-G | Release `v_P` check only for reused grants | Design §9 (plan default: all grants) | Say all grants |

## 3. Decisions left to the author

1. **Maximum authorization validity.** A null expiry still never ends, except at a policy change (traceability A06).
2. **Counterfactual visibility.** Counterfactuals reveal the written policy's outcome next to the LLM's advice. This relaxes the 2026-09-11 decision to keep the oracle offline; it was approved through plan step 14, and `DIAS_COUNTERFACTUALS=off` restores the earlier behavior.
3. **Re-training.** Prompt v2 changes the model's input. Whether V7 needs re-training depends on the re-evaluation, which is NOT RUN.
4. **Human-auditor study.** Every experiment used a scripted auditor. A study with human auditors is outside this revision.
5. **Confidentiality against member organizations.** Doing it properly would need private data collections for request records; v3 provides interface-level controls only.

## 4. Status

This file is updated at the end of each plan step. The final state is in the last iteration report of the v3 series.
