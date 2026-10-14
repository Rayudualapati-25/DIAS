package org.dias.mobile.screen

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.data.HostAddress
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * One auditor decision of the end-to-end experiment, made on the phone screen against the real Mac host,
 * with each step timed on the phone.
 */
@RunWith(AndroidJUnit4::class)
class EndToEndExperimentTest {
    private fun timed(step: () -> Unit): Double {
        val started = SystemClock.elapsedRealtimeNanos()
        step()
        return (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
    }

    @Test fun theAuditorFollowsTheAdviceOnThePhone() {
        val arguments = InstrumentationRegistry.getArguments()
        val apiBase = arguments.getString("apiBase")
        val requestId = arguments.getString("experimentRequestId")
        assumeTrue("Set apiBase and experimentRequestId to record a timed decision",
            apiBase != null && requestId != null)
        val auditor = arguments.getString("reviewerUsername") ?: "sp.north"
        val screen = Screen()
        try {
            val result = JSONObject().put("requestId", requestId).put("auditor", auditor)
            result.put("signInMs", timed { screen.signIn(HostAddress.normalize(apiBase!!, true), auditor) })
            result.put("queueMs", timed {
                screen.click("auditor_refresh")
                screen.awaitMessage("awaiting an auditor", pollMillis = POLL)
            })
            result.put("pendingShown", screen.lines("auditor_queue").count { it == "Review" })
            result.put("reviewMs", timed {
                screen.click("review_$requestId")
                screen.awaitMessage("Review $requestId", pollMillis = POLL)
            })

            val advice = screen.lines("auditor_details").first { it.startsWith(ADVICE_LINE) }.removePrefix(ADVICE_LINE)
            val followed = advice == "ALLOW" || advice == "DENY"
            val grant = advice == "ALLOW"
            val outcome = if (grant) "GRANTED" else "DENIED"
            if (!followed) screen.type("auditor_reason", NO_ADVICE_REASON)
            screen.click(if (grant) "auditor_allow" else "auditor_deny")
            assertFalse("Following the advice never creates a reusable authorization",
                screen.dialogMessage().contains("creates an exact-scope reusable authorization"))
            var confirmed = ""
            result.put("decisionMs", timed {
                screen.pressDialogButton(if (grant) "Record grant" else "Record denial")
                confirmed = screen.awaitMessage("Fabric confirms $outcome for $requestId", 90_000, POLL)
            })
            result.put("logMs", timed {
                screen.click("access_log_refresh")
                screen.awaitMessage("Access log read from Fabric", pollMillis = POLL)
            })

            val newest = screen.lines("access_log_rows").take(ROW_LINES)
            val decisionLabel = if (grant) "FORCE ALLOW" else "FORCE DENY"
            result.put("advice", advice).put("followed", followed)
                .put("decision", if (grant) "FORCE_ALLOW" else "FORCE_DENY").put("outcome", outcome)
                .put("outcomeId", Regex("\\((OUTCOME-[0-9a-f]+)\\)").find(confirmed)?.groupValues?.get(1))
                .put("logFirstRowIsThisRequest", newest.firstOrNull()?.endsWith(requestId!!) == true)
                .put("logShowsDecision", newest.any {
                    it.startsWith("Auditor decided: $decisionLabel") && it.endsWith("by $auditor")
                })
                .put("logShowsOutcome", newest.lastOrNull()?.startsWith("Outcome: $outcome") == true)
            screen.saveText("e2e-$requestId.json", result.toString())
            assertTrue("The decided request leads the phone's access log with its decision and outcome",
                result.getBoolean("logFirstRowIsThisRequest") && result.getBoolean("logShowsDecision")
                    && result.getBoolean("logShowsOutcome"))
        } finally { screen.close() }
    }

    private companion object {
        const val POLL = 20L
        const val ROW_LINES = 6
        const val ADVICE_LINE = "LLM recommendation (advisory): "
        const val NO_ADVICE_REASON =
            "No committed and verified LLM recommendation was available; denied pending manual review."
    }
}
