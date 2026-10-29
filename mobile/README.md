# DIAS Mobile

This folder holds the Android app for DIAS. This README covers the phone app
only. The Fabric network, the backend and the model are described in the main
`README.md` at the top of the repository.

- App code: `mobile/android`
- App name on the phone: DIAS Mobile
- Version: 0.1.0 (prototype)

## 1. Overview

The app lets an **officer ask for access to a case file** and lets an
**auditor decide on that request**, both from a phone. It is the mobile
version of the main DIAS flow:

1. **The officer asks.** They pick a case file, an operation and a purpose, and
   write a reason ("Why do you need it?", 3 to 2,000 characters). The request
   goes to the backend and is recorded on the blockchain.
2. **An earlier approval is checked first.** If a reusable authorization exists
   for exactly this request, access is granted at once. The screen says this
   before the officer sends.
3. **Otherwise the LLM gives advice.** The backend asks the model for ALLOW or
   DENY.
4. **The auditor decides.** The auditor sees the waiting request and the LLM
   advice, taps Allow or Deny, and writes a reason. A reason is required when
   the decision differs from the LLM or when there is no advice (at most 2,000
   characters).
5. **The officer sees the result** by pressing Check status. After a denial
   they see the LLM's explanation. Before the decision they see nothing from
   the LLM.

The phone runs no blockchain and no LLM. It only shows screens and sends what
the user taps. All the work happens on the host computer.

## 2. Features

The app is one screen with several cards.

| Card | What it does |
| --- | --- |
| Connect to your host | Enter the host address and check the connection. |
| Sign in / Sign out | Sign in with a demo identity (username only, no password). Signing out also clears the saved case summaries. |
| Cases | Case summaries: case ID, owning agency, jurisdiction and status. Loaded 20 at a time ("Refresh first batch", "Load next batch") and browsed with Previous / Next. They are saved on the phone, so they can still be browsed during a connection loss, but they may be out of date. |
| Request access | Case file, operation, purpose and reason, then "Request access". "Check status" shows the progress, and "My requests" shows the newest 10 requests. |
| Auditor decisions | Only for audit-organization district heads. "Refresh pending reviews", open a request, see the LLM advice, then Allow or Deny with a reason. A confirmation box appears before anything is sent. |
| Access log | The newest 100 requests, 10 per page: who requested which case file, what the LLM recommended, what the auditor decided, and the outcome. Every officer with an active credential reads the full log. If the host refuses the full log, the app shows the decision log and the officer's own requests instead. |

### Pending

1. Opening the released case-file details or the full PDF after access is
   granted.
2. Search by case number or evidence number.
3. Cancelling a request or revoking an authorization.
4. The "searches and reads" log.
5. Background sync and notifications. The user must press Refresh or Check
   status.
6. Filters on the access log.

## 3. Connection

### Simple view

Think of the host computer as the **office** and the phone as a **remote
window** into that office.

```
 Phone app  ──►  Backend (host)  ──►  Blockchain + LLM (host)
    ▲                                          │
    └──────────────── reply ◄──────────────────┘
```

1. **The phone (the app)** shows screens and sends what the user taps.
2. **The backend (the middleman)** is the same backend the web portal uses. It
   checks who is asking and passes the work on.
3. **The blockchain and the LLM** do the real work. The LLM gives advice, and
   the blockchain records every request and decision.

### Steps

1. **Find the host.** The user types the host address. The app calls
   `/api/health` to check it can reach it.
2. **Sign in.** The backend returns a **token**, like a visitor pass.
3. **Show the pass every time.** Every call carries the header
   `Authorization: Bearer <token>`.
4. **Send a request.** The backend records it on the blockchain and asks the
   LLM for advice.
5. **The auditor decides.** The backend writes the decision to the blockchain
   (about 2 seconds).
6. **Double-check.** The phone reads the request back from the blockchain
   before it shows "Granted".
7. **The officer sees the result** after pressing Check status.

### Safety

- **Secure link.** The release app accepts HTTPS addresses only. The debug app
  also accepts plain HTTP, but only to `10.0.2.2`, `127.0.0.1` and `localhost`.
- **The pass stays private.** The app does not follow redirects, so the token
  is never sent to another server.
- **No hanging.** It waits at most 10 s to connect and 30 s for a reply.
- **No double decisions.** The app never sends a decision again by itself. If
  the host refused it, the app says "Nothing was recorded" and the auditor may
  correct it and send it again. If the reply is unclear, the app says the
  decision may have been recorded and asks the auditor to refresh the queue
  before deciding again.
- **The address must be plain.** No `/api`, no user name or password, and no
  query in the host address.

### Options

`scripts/mobile-connect.sh` prints the right address. It only works locally and
never opens a public tunnel or changes the Fabric network.

| Mode | Command | Address to type in the app |
| --- | --- | --- |
| Emulator | `scripts/mobile-connect.sh emulator` | `http://10.0.2.2:3001` (the emulator's name for the host computer) |
| Real phone on USB | `scripts/mobile-connect.sh usb` (runs `adb reverse tcp:3001 tcp:3001`) | `http://127.0.0.1:3001` |
| Check the host | `scripts/mobile-connect.sh check` | none (calls `/api/health`) |

The port can be changed with `MOBILE_HOST_PORT`. `scripts/mobile-host.js`
starts an extra local API for mobile development on port 3002 (loopback
only). It uses the same Fabric settings but does not start the worker replay
or the expiry sweeper.

### API calls

| Method | Path | Used for |
| --- | --- | --- |
| GET | `/api/health` | Connection check |
| POST | `/api/auth/login` | Sign in |
| GET | `/api/mobile/cases?limit=&cursor=` | Case summaries, page by page |
| POST | `/api/access/request` | Send an access request |
| GET | `/api/access/request/{id}` | Status of one request |
| GET | `/api/access/request/{id}/recommendation` | LLM explanation after the decision |
| GET | `/api/access/requests/mine?limit=` | My requests |
| GET | `/api/access/auditor/pending` | Requests waiting for the auditor |
| GET | `/api/access/auditor/{id}` | One request for review |
| POST | `/api/access/auditor/{id}/decision` | Record Allow or Deny |
| GET | `/api/access/workflow-log?limit=` | Full access log |
| GET | `/api/access/decision-log?limit=` | Access log when the full log is refused |

### Mobile route

All calls except one are the same ones the web portal uses. The only route
added for the phone is `/api/mobile/cases` (`backend/src/routes/mobile.js`,
`backend/src/mobile/casePage.js`):

1. It reads the case list from the ledger (`QueryCases`) with the same identity
   checks as before.
2. It returns only four fields per case (case ID, owning agency, jurisdiction,
   status), sorted by case ID.
3. It returns 1 to 50 cases per page (20 if not given).
4. The "next page" marker is signed and belongs to one account. It expires
   after 15 minutes and cannot be used as a sign-in token.
5. If the case list changed between pages, the host answers 409 and the app
   starts again from the first page.
6. Only the reply is paged. The ledger read itself is not paged.

Tests: `backend/test/mobileCases.unit.test.js`.

## 4. Approval

1. The app checks the rules on the phone first: a reason when needed, at most
   2,000 characters.
2. A confirmation box shows the request, the LLM advice, whether a reusable
   authorization will be created, and "This final decision will be recorded on
   Fabric."
3. The phone sends the decision. The backend writes it to the blockchain in
   one transaction, and the outcome becomes **GRANTED** (or DENIED for Deny).
4. The app checks that the reply matches the choice (Allow → GRANTED, Deny →
   DENIED).
5. The app reads the request back from the blockchain. It shows "Fabric
   confirms GRANTED" only when the read-back matches.

A **reusable authorization** is created only when the LLM said DENY and the
auditor overrides it with Allow. After that, the exact same request is
granted at once, with no LLM and no auditor. When the auditor agrees with an
LLM ALLOW, access is granted but no reusable authorization is created.

## 5. Performance

Measured on 14 October 2026.

### Setup

- One Mac running the Fabric network, the backend and the model.
- Two Android emulators with identical settings: `DIAS_Officer_Phone` (port
  5556) and `DIAS_Auditor_Phone` (port 5558).
- "Phone" means the real app screen on the emulator, driven by an
  instrumented test. "Mac" means the same calls sent by a script, as the web
  portal sends them.
- 96 requests per model, 24 in each of four setups: Mac only, phone only,
  officer on Mac with auditor on phone, and officer on phone with auditor on
  Mac.
- Two models: the untuned Qwen3-14B and the fine-tuned V7.
- The auditor was a script tapping the real screen, so no number includes
  human thinking time.

Raw data: `experiments/runs/20261014_mac_mobile_setups/` (the `untuned/` and
`v7/` folders, file `analysis.json`).

### Results

| Step | Phone (untuned / V7) | Mac (untuned / V7) |
| --- | --- | --- |
| Sign in | about 0.15 s | — |
| Officer sends a request | 2.10 s / 2.10 s | 2.09 s / 2.10 s |
| Auditor taps Allow → saved on the blockchain | 2.11 s / 2.11 s | 2.11 s / 2.12 s |
| All auditor steps (load list, open, decide, log) | 2.37 s / 2.49 s | 2.30 s / 2.43 s |
| Officer reads the result | 0.04 s / 0.04 s | 0.04 s / 0.04 s |
| Whole request, start to decision | 13.32 s / 14.37 s (phone only) | 13.19 s / 14.15 s (Mac only) |
| Same request again (reusable authorization) | 2.10 s / 2.10 s | 2.09 s / 2.10 s |

What this shows:

1. **The phone is not slower in any way that matters.** Phone only minus Mac
   only is +0.12 s (95% CI −0.34 to +0.38 s) with the untuned model and
   +0.23 s (−0.34 to +0.60 s) with V7. Neither difference is significant.
2. The auditor's own steps are about 0.06 s slower on the phone (untuned
   +62 ms, 95% CI 51–70 ms; V7 +61 ms, 55–66 ms).
3. **Saving a decision takes about 2.1 s** because Fabric waits up to 2 s to
   fill a block. The real work is about 0.1 s.
4. Most of a whole request is the LLM (about 7–8 s) plus three blockchain
   writes of about 2.1 s each.
5. **All results were checked on the blockchain.** All 96 requests per model
   were verified, with 864 of 864 ledger checks passing. With the reusable
   authorization, 36 of 36 repeats were granted at once, and 0 of 24 near
   misses or revoked scopes were granted.

For the untuned model, the whole-request times use the 93 requests that got
usable advice.

### Emulators

An older emulator (`emulator-5554`, the default Android Studio device) added
about 0.5 s to every new connection to the host. A fresh emulator adds about
0.004 s. That is why the timing runs used the two fresh emulators. The probe
results are in `experiments/runs/20261014_mac_mobile_setups/phones/`.

## 6. Code

### Tools

| Item | Value |
| --- | --- |
| Language | Kotlin, Java 17 |
| Build | Gradle 9.3.1, Android Gradle Plugin 9.1.1 |
| Android | minSdk 26 (Android 8.0), compileSdk and targetSdk 36 |
| Runtime libraries | None. Only what Android provides: `HttpURLConnection`, `org.json`, SQLite and Android Views |
| Test libraries | JUnit 4.13.2, AndroidX Test runner 1.7.0, AndroidX JUnit 1.3.0 |
| Size | About 1,700 lines of app code and 2,300 lines of tests |
| Permission | `INTERNET` only |

### Layers

```
presentation/  →  screens and buttons
domain/        →  data shapes and rules
data/          →  talks to the host and the phone's database
```

All files are under `mobile/android/app/src/main/kotlin/org/dias/mobile/`.

| File | Lines | Job |
| --- | --- | --- |
| `presentation/MainActivity.kt` | 482 | The one screen: all cards, background work, the decision box |
| `presentation/RequestPanel.kt` | 113 | Request access card |
| `presentation/AccessLogPanel.kt` | 185 | Access log card |
| `presentation/Views.kt` | 37 | Small helpers for labels, cards and dividers |
| `domain/Models.kt` | 128 | `Session`, `CaseSummary`, `AuditorReview`, `DecisionReceipt` and the interfaces |
| `domain/AccessRequests.kt` | 152 | Request draft and status, rules and limits |
| `domain/AccessLog.kt` | 165 | Access log rows, pages and rules |
| `data/ApiClient.kt` | 235 | Every call to the backend |
| `data/AccessRequestJson.kt` | 39 | Reads request replies |
| `data/AccessLogJson.kt` | 40 | Reads access log replies |
| `data/CaseDatabase.kt` | 87 | SQLite storage for case summaries |
| `data/CaseRepository.kt` | 23 | Joins the host and the local database for case summaries |
| `data/HostAddress.kt` | 22 | Checks the typed host address |

The domain layer defines interfaces (`RemoteCases`, `RemoteAuditor`,
`RemoteAccessLog`, `RemoteRequests`, `LocalCases`, `CasesRepository`). The tests
use them to swap in a fake host.

### UI

- There are no XML layout files. Every screen is built in Kotlin code from
  `LinearLayout`, labels, text fields and buttons.
- The whole app is one Activity (`MainActivity`).
- A helper `button(parent, text, tag, enabledWhen) { … }` creates each button
  and decides when it can be pressed. For example, "Request access" works only
  after sign-in.
- Before an auditor decision, an `AlertDialog` asks "Grant access?" or "Deny
  access?".

### Threading

1. All network and database work runs on **one background thread**
   (`Executors.newSingleThreadExecutor()`).
2. One helper, `perform()`, runs every action:
   - it marks the app as busy and disables the buttons, so only one action
     runs at a time;
   - it runs the work on the background thread;
   - it shows the result on the screen thread (`runOnUiThread`).
3. If the host answers 401 (the sign-in ended), the app clears the saved data
   and signs out.

### Storage

- One SQLite file, `dias-summaries.db`, with two tables: `case_summary` and
  `sync_state`.
- Signing out, or an expired sign-in, deletes both tables.
- Android backup and device transfer are switched off for the app
  (`allowBackup="false"` and `data_extraction_rules.xml`).
- The sign-in token is kept only in memory. It is never written to disk.
- The host address is remembered between runs (the Activity's private
  preferences).

### Builds

| | Debug | Release |
| --- | --- | --- |
| App ID | `org.dias.mobile.dev` | `org.dias.mobile` |
| Default host | `http://10.0.2.2:3001` | none |
| Plain HTTP | only to `10.0.2.2`, `127.0.0.1`, `localhost` | never (HTTPS only) |

## 7. Build and test

You need Android Studio (set `JAVA_HOME` to its bundled JDK), Android SDK 36
and the platform tools (`adb`).

To run the app, open `mobile/android` in Android Studio and run it on an
emulator. Start the backend on the host first (see the main README).

Unit tests (no phone needed):

```bash
cd mobile/android && ./gradlew :app:testDebugUnitTest
```

Build the app and the screen tests:

```bash
cd mobile/android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
```

Install both on an emulator:

```bash
adb -s emulator-5556 install -r -t mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

```bash
adb -s emulator-5556 install -r -t mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
```

Run the screen tests:

```bash
adb -s emulator-5556 shell am instrument -w org.dias.mobile.dev.test/androidx.test.runner.AndroidJUnitRunner
```

Use `am instrument` as above, not `connectedDebugAndroidTest`, which
uninstalls the app afterwards.

To start a headless emulator for timing runs (the experiments used two Medium
Phone, API 36.1 devices with the same settings):

```bash
emulator -avd DIAS_Officer_Phone -no-window -no-audio -no-boot-anim -no-snapshot -port 5556
```

### Tests

1. **Unit tests** (4 files, `app/src/test`): host address checks, request
   rules, auditor rules and access log rules.
2. **Screen tests** (13 files, `app/src/androidTest`): they run on the emulator
   and tap the real screens. Most use a fake host (`FakeHost.kt`) and never
   touch the real blockchain.
3. **Live tests** run only when they are given arguments, because they write
   to the live ledger:
   - `LiveHostScreenTest` needs `-e apiBase http://10.0.2.2:3001`. It also
     accepts `username`, `reviewerUsername`, and `decisionRequestId` with
     `decision` (plus `decisionReason` and `allowAuthorization`) to record
     one named decision.
   - `PhoneSessionTest` and `EndToEndExperimentTest` drove the phones in the
     14 October experiments. Both need `apiBase` and `experimentSession`.
   - `IdleLatencyProbeTest` (`idleProbe`) measured the emulator connection
     delay.
