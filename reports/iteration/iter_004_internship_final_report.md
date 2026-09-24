# Iteration 004 — Internship final report

Date: 2026-08-17

## Objective

Prepare an SRM University-AP internship final report for the SEBA-XAI Crime
Records Network using the supplied report and certificate templates and only
the research evidence retained in this repository and its associated paper
artifacts.

## Evidence plan

- Use the fixed eight-scenario live Fabric experiment as the system-level
  baseline/proposed comparison.
- Use the role-only policy as the recorded ablation baseline and the contextual
  Fabric policy as the proposed method.
- Report test, coverage, integrity, latency, and storage measurements exactly as
  recorded in `docs/evaluation.md` and `experiments/results/`.
- Keep the earlier multi-seed synthetic compromised-signer study separate from
  the live Fabric experiment; do not merge their populations or claims.
- Retain explicit limitations for synthetic data, single-host deployment,
  custodial demo identities, the filesystem vault, and absent legal/production
  validation.

## Deliverable

- `papers/final_paper/SEBA_XAI_Internship_Final_Report.docx`
- `papers/final_paper/SEBA_XAI_Internship_Final_Report.pdf`

## What worked

- The supplied report format, completion certificate and assessment rubric were
  distilled into one 29-page A4 report with the required preliminary pages,
  main chapters, references and appendices.
- The main report uses Times New Roman 12 pt, double-spaced body text, one-inch
  margins and top-right serial page numbers 1–23.
- The cover title is 97 characters and the abstract is 158 words, within the
  supplied limits of 100 characters and 200 words respectively.
- The table of contents was checked against the final rendered chapter starts.
- All quantitative statements were traced to retained repository evidence. The
  live Fabric and earlier simulation evidence streams remain explicitly
  separated, and negative results and limitations are retained.
- The report includes the role-only baseline, contextual proposed method,
  component-removal discussion, five figures, thirteen tables, assumptions,
  research questions, outcomes, recommendations and a repository evidence map.
- The DOCX package passed `unzip -t`, and all 29 rendered pages were visually
  inspected after the final margin and contents-page corrections.

## What remains weak or administrative

- Registration number, official joining/start/completion dates, mentor
  designation/signature, student signature and organisation seal were not
  present in the supplied files or repository and therefore remain blank.
- The eight-scenario result is a deterministic functional comparison rather
  than an estimate of real-world policy accuracy.
- Live measurements are from a single-host Fabric deployment; the stronger
  compromised-signer case remains a separate simulation rather than a live
  Fabric replay.
- No authorised domain-expert study, legal validation, production identity
  system or human explanation-quality study has been performed.

## Next experiment or refinement

Run a controlled multi-host Fabric evaluation with varied orderer
`BatchTimeout`, concurrent workloads and a deliberate CA/MSP-authority
compromise. Add independent attribute attestation and domain-expert review of
policy outcomes and explanation usefulness. Preserve the new configuration,
logs, metrics and plots as a separate evidence stream before revising any
claims in the report.
