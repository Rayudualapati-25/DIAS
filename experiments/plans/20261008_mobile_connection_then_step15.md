# Verify emulator connection, then step 15

User instruction: first check the Mac portal and Android Studio emulator connection; proceed with step 15 after it works. The current Android application remains the basic sign-in and read-only case-summary layer with explicit refresh. No claim of full DIAS mobile workflow or automatic synchronization is permitted.

1. Record the running emulator, current host, dirty tree and prior limitations. Use the same normal DIAS API on port 3001, not the older channel or a second backend.
2. Run the existing Android unit/build/lint/device checks with both the emulator host alias and reverse-forwarded loopback. Retain fresh XML/logs as baseline. Compare normal portal case responses with bounded mobile responses.
3. Strengthen connection evidence where needed: compare every case-summary field saved in real SQLite with the current portal API. Check repeat refresh, duplicate-free paging, offline cache, isolation and screen sign-in/read/sign-out. Preserve app data outside temporary test databases and do not mutate user case records.
4. Verify the installed app visibly through Android Studio. Update connection docs to current observed settings. Retain deterministic baseline and batching/cache ablations without speed or complete-sync claims.
5. Gate step 15 on successful actual-device transport and exact case coverage. Then inspect and update legacy acceptance, testbed preparation/load scripts, ledger inspection and final contract version labels for current schemas and backend-generated recommendations. Keep the oracle offline and LLM explanation only.
6. Run focused tests first, full appropriate suites after changes, one safe current host workflow, and reproducibility checks. Do not redeploy/reset the network or rerun research load experiments merely to update scripts. Record scripts needing a separate testbed run honestly.
7. Retain configs/logs/results in runs, comparison tables and iteration reports; commit only authorized changes. Never push/merge unless separately instructed.
