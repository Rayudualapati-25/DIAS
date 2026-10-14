package org.dias.mobile.screen

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.data.HostAddress
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The auditor's side of the end-to-end experiment, on the phone screen against the real Mac host. It writes
 * real decisions to the ledger and runs only when `apiBase` and `experimentSession` are given.
 */
@RunWith(AndroidJUnit4::class)
class EndToEndExperimentTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()

    @Test fun theAuditorServesTheExperimentFromThePhone() {
        val arguments = InstrumentationRegistry.getArguments()
        val apiBase = arguments.getString("apiBase")
        val session = arguments.getString("experimentSession")
        assumeTrue("Set apiBase and experimentSession to serve an experiment",
            apiBase != null && session != null && SESSION_NAME.matches(session))
        val auditor = arguments.getString("reviewerUsername") ?: "sp.north"
        val folder = File(instrument.targetContext.cacheDir, "evidence/session-$session").apply { mkdirs() }
        val screen = Screen()
        try {
            screen.keepScreenOn()
            val started = SystemClock.elapsedRealtimeNanos()
            screen.signIn(HostAddress.normalize(apiBase!!, true), auditor)
            val signInMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
            answer(folder, "ready.json", JSONObject().put("auditor", auditor).put("signInMs", signInMs))
            var number = 1
            while (true) {
                val command = awaitCommand(folder, number).trim().split(' ')
                if (command[0] == "stop") break
                val result = try {
                    when (command[0]) {
                        "open" -> open(screen, command[1])
                        "decide" -> decide(screen, command[1], auditor)
                        else -> error("unknown command '${command[0]}'")
                    }
                } catch (failure: Throwable) {
                    JSONObject().put("error", failure.message ?: failure.toString())
                }
                answer(folder, "res-$number.json", result.put("command", command[0]))
                number++
            }
        } finally { screen.close() }
    }

    /** The auditor reads the queue and opens the review of one request. */
    private fun open(screen: Screen, requestId: String): JSONObject {
        val queueMs = screen.timeToMessage("awaiting an auditor") { screen.click("auditor_refresh") }
        val pendingShown = screen.lines("auditor_queue").count { it == "Review" }
        val reviewMs = screen.timeToMessage("Review $requestId") { screen.click("review_$requestId") }
        return JSONObject().put("requestId", requestId).put("queueMs", queueMs).put("reviewMs", reviewMs)
            .put("pendingShown", pendingShown).put("advice", adviceShown(screen))
    }

    /** The auditor follows the advice of the open review, confirms it, and reads the access log. */
    private fun decide(screen: Screen, requestId: String, auditor: String): JSONObject {
        val advice = adviceShown(screen)
        val followed = advice == "ALLOW" || advice == "DENY"
        val grant = advice == "ALLOW"
        val outcome = if (grant) "GRANTED" else "DENIED"
        if (!followed) screen.type("auditor_reason", NO_ADVICE_REASON)
        screen.click(if (grant) "auditor_allow" else "auditor_deny")
        if (screen.dialogMessage().contains("creates an exact-scope reusable authorization")) {
            screen.pressDialogButton("Cancel")
            error("this decision would create a reusable authorization; it was cancelled")
        }
        val press = screen.dialogButton(if (grant) "Record grant" else "Record denial")
        val decisionMs = screen.timeToMessage("Fabric confirms $outcome for $requestId", 120_000) { press() }
        val confirmed = screen.text("message")
        val logMs = screen.timeToMessage("Access log read from Fabric") { screen.click("access_log_refresh") }
        val newest = screen.lines("access_log_rows").take(ROW_LINES)
        val decisionLabel = if (grant) "FORCE ALLOW" else "FORCE DENY"
        return JSONObject().put("requestId", requestId).put("decisionMs", decisionMs).put("logMs", logMs)
            .put("advice", advice).put("followed", followed)
            .put("decision", if (grant) "FORCE_ALLOW" else "FORCE_DENY").put("outcome", outcome)
            .put("outcomeId", Regex("\\((OUTCOME-[0-9a-f]+)\\)").find(confirmed)?.groupValues?.get(1))
            .put("logFirstRowIsThisRequest", newest.firstOrNull()?.endsWith(requestId) == true)
            .put("logShowsDecision", newest.any {
                it.startsWith("Auditor decided: $decisionLabel") && it.endsWith("by $auditor")
            })
            .put("logShowsOutcome", newest.lastOrNull()?.startsWith("Outcome: $outcome") == true)
    }

    private fun adviceShown(screen: Screen): String =
        screen.lines("auditor_details").first { it.startsWith(ADVICE_LINE) }.removePrefix(ADVICE_LINE)

    /** Wait for the host's next command file. Checking a local file costs the host nothing. */
    private fun awaitCommand(folder: File, number: Int): String {
        val file = File(folder, "cmd-$number")
        val deadline = SystemClock.elapsedRealtime() + COMMAND_TIMEOUT_MS
        while (!file.exists()) {
            check(SystemClock.elapsedRealtime() < deadline) { "no command $number from the host in time" }
            Thread.sleep(25)
        }
        return file.readText()
    }

    /** Written under another name first, so the host never reads half an answer. */
    private fun answer(folder: File, name: String, content: JSONObject) {
        val draft = File(folder, "$name.tmp")
        draft.writeText(content.toString())
        check(draft.renameTo(File(folder, name))) { "could not save $name" }
    }

    private companion object {
        const val ROW_LINES = 6
        const val COMMAND_TIMEOUT_MS = 15 * 60_000L
        const val ADVICE_LINE = "LLM recommendation (advisory): "
        const val NO_ADVICE_REASON =
            "No committed and verified LLM recommendation was available; denied pending manual review."
        val SESSION_NAME = Regex("^[A-Za-z0-9-]{1,40}$")
    }
}
