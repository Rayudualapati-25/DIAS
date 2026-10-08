# Iteration 072 — Android Studio connection to the Mac portal

Date: 2026-10-08. User order: verify the connection first, then step 15.
Plan: `experiments/plans/20261008_mobile_connection_then_step15.md`.
Evidence: `experiments/runs/20261008_mobile_connection/`.

## Result and scope

The native Kotlin app ran inside Android Studio on `emulator-5554`, AVD
`Medium_Phone_API_36.1`, Android 16. Both `http://10.0.2.2:3001` and
reverse-forwarded `http://127.0.0.1:3001` reached the **normal** Mac portal API,
using its current `diaschannel` / `diasrecords` network. No extra backend was
started for this gate. The running app remains signed in as `insp.sharma` and
shows the two saved case summaries.

This is manual synchronization of read-only summaries. It is not full DIAS
mobile access, automatic synchronization or a phone-hosted Fabric network.

## Changes and checks

The existing live Android test now compares all four fields of every SQLite
summary with the normal portal `/api/cases` response, checks the portal snapshot
before/after, and checks repeat refresh and database reopen. Production mobile
code and the previously added backend route were preserved. The README now
uses port 3001 for the live device checks and records the current scope.

| Check | Result | Evidence in this run |
| --- | --- | --- |
| Existing Android baseline, fresh execution | build, lint, 3 unit and 10 device checks pass; no skipped device checks | `android-baseline.log`, `android-baseline-evidence/` |
| Strengthened comparison, fresh execution | build, lint, 3 unit and 10 device checks pass; zero failures/skips | `android-parity.log`, `android-parity-evidence/` |
| Both live connection methods | authenticated API and Fabric summaries pass | device XML; `connection-gate.json` |
| Visible app SQLite versus portal | exact coverage and equality for 2 summaries: CASE-2026-001 and CASE-2026-002 | `connection-gate.json` |
| Android Studio sign-in and refresh | app shows saved summaries | `android-studio-connected.png`, `android-studio-cases.png` |
| Deterministic 53-case transport baseline | unbounded response 53; batches 20,20,13, exact coverage | `transport/transport-results.json` |
| Batching removed | one response of 53, compared with three bounded responses | same transport artifact |
| Real SQLite cache isolation/persistence and offline fallback | device fixture checks pass, including failed remote refresh and unchanged saved data | device XML and FoundationTest |

Offline/cache tests use deterministic simulated transport failures and real
Android SQLite. No live network outage or physical phone/tunnel was exercised.
The live data contain only two cases, so live multi-page coverage is not claimed;
53-case host and 45-case Android fixtures exercise continuations separately.
These are functional counts, not latency or throughput results.

The host still reads the entire Fabric case result per page. SQLite contains
summaries only; credentials/tokens stay off the database. Sessions need online
sign-in after process recreation. No protected documents, access requests,
auditor decisions, LLM execution or background sync exist in the mobile layer.

The temporary transport-specific capture attempts contain missing-file errors after the app was
reinstalled by Android Studio; they are not used as parity evidence. Fresh test XML
and the independent running-app SQLite comparison establish the gate. The
SQLite capture stays local under the database ignore rule. `capture-note.md`
records this limitation; `source-digests.json` identifies the tested mobile tree.

## Reproduce and next work

Open `mobile/android` in Android Studio with its bundled JDK, keep the normal
Mac backend on port 3001, and run the README device command with both host
arguments. Reproduction requires the existing uncommitted mobile foundation;
this report does not claim the app is present in a clean checkout of the
step 15 commit. Older mobile/host files remain uncommitted and preserved.

Worked: both emulator paths, exact portal parity, explicit refresh and local
paging. Weak: full workflows and automatic updates are absent; no performance
comparison or release/physical-device verification. The connection gate passed,
so step 15 followed. Next mobile work is the authenticated access-request and
request-status flow through this same backend, after host step 16 verification.
