# Iteration 075 — Native Android check against the current DIAS portal

Date: 2026-10-12. Request: check whether the same Search → LLM advice → auditor decision → requester outcome workflow runs in the Android Studio emulator. Plan: [`20261012_mobile_emulator_check.md`](../../experiments/plans/20261012_mobile_emulator_check.md). Evidence: [`20261012_mobile_emulator_check/`](../../experiments/runs/20261012_mobile_emulator_check/). Capability table: [`20261012_mobile_emulator_check.csv`](../../results/tables/20261012_mobile_emulator_check.csv).

## Facts observed

The native `org.dias.mobile.dev` app was built and run inside Android Studio on `emulator-5554` (Medium Phone API 36.1, Android 16). It reached the normal Mac DIAS API on port 3001 through both `10.0.2.2` and an existing `adb reverse` mapping for `127.0.0.1`. The live tests authenticated `insp.sharma`, fetched the portal's Fabric-backed case list, transferred the bounded mobile response into real Android SQLite, and compared all four summary fields with the portal response. Both transport tests passed without a skip. The visible app then signed in and refreshed successfully; its screen showed two saved summaries and no remaining batch. The copied running-app SQLite database independently matched both `/api/cases` and `/api/mobile/cases` for `CASE-2026-001` and `CASE-2026-002` across case ID, agency, jurisdiction and status. See `device-results/`, `running-app-parity.json` and `android-studio-cases.png`.

| Verification | Baseline, 2026-10-08 | Current, 2026-10-12 | Evidence |
| --- | --- | --- | --- |
| Native production and test source | Mobile foundation | Same 16 source-file SHA-256 values | `source-digests.json`, prior `20261008_mobile_connection/source-digests.json` |
| Build, unit, device, lint | Build/lint passed; 3 unit and 10 device tests passed | Build/lint passed; fresh 3 unit and 10 device tests passed, zero failures/skips | `android-verification.log`, `android-unit-lint-fresh.log`, XML results |
| Host transports | Emulator alias and reverse forwarding reached normal port 3001 | Both passed against the currently upgraded Mac host and Fabric | Two `HostConnectionTest` XML cases, `reverse-before.txt` |
| Visible summaries | Two saved case summaries | Two summaries refreshed in app; copied SQLite equals portal and mobile API | `android-studio-cases.png`, `running-app-parity.json` |
| Full Search/review workflow | Absent from native app | Still absent; source unchanged | Native `ApiClient.kt`, `MainActivity.kt`, capability table |

The fresh lint run reported one nonblocking toolchain version warning (`AndroidGradlePluginVersion`), recorded in `lint-results-debug.xml`. The 7 fixture tests cover batches of 45 cases, local cache and scoped identities, duplicate-page idempotence, and persistence through failed fetch/write. These are functional checks; no live multi-page host dataset, outage, physical phone or latency result is claimed.

The instrumentation runner uninstalled the target app after its tests, so the attempted `run-as` captures of its temporary per-transport cache files failed with “unknown package.” Both errors are retained in `apiBase-capture-error.txt` and `reverseBase-capture-error.txt`. I reinstalled/launched through Android Studio, refreshed the screen, copied the resulting app-private SQLite database read-only, and used that copy for the independent comparison. The binary copy remains in ignored `mobile/android/build/emulator-check-20261012/`; the committed evidence contains only summary fields and no session token or credential. The app's current screen is left signed in on the emulator.

## Interpretation and next refinement

The **connection and read-only case-summary sync work** on the current host. The native app does **not** yet submit a Search access request, display the LLM recommendation, let an auditor decide, show the requester the final decision, read protected case/evidence content, or show blockchain access logs. Its two-case refresh is manual; no background synchronization runs. The portal workflow checks in iteration 074 verify the web path, not those absent mobile controls. The mobile route currently slices a full Fabric `QueryCases` result per request, so live large-dataset efficiency is unmeasured.

Worked: live authenticated connectivity over both emulator routes, exact four-field SQLite parity, the running screen refresh, and regression tests on the unchanged mobile foundation. Weak: full DIAS parity and automated sync are missing; this check cannot measure model quality or end-to-end access latency. Next refinement: implement native Search/request, pending and final status, and auditor review/decision screens against the existing Mac API; then verify a real mobile-origin request through model advice, binding auditor decision and ledger workflow log before any performance rerun. The research model baseline, proposed-method and component-ablation experiments remain the separate step 16–17 testbed work.

Reproduction requires the local pre-existing uncommitted mobile foundation and mobile backend route; this verification commit does not add them to a clean checkout. The mobile source was neither edited nor committed in this check, and unrelated user changes were preserved.
