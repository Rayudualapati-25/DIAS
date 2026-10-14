package org.dias.mobile.screen

import android.os.SystemClock
import android.util.Base64
import org.dias.mobile.domain.actionLabel
import org.dias.mobile.domain.purposeLabel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * One phone in an experiment against the real Mac host: a person who stays on the app's screen and does
 * what the host asks, one step at a time.
 */
internal class ExperimentSession(private val screen: Screen, private val folder: File, private val host: String) {

    /** Serve commands until `stop`. `firstUser` signs in before the first command. */
    fun serve(firstUser: String) {
        screen.keepScreenOn()
        answer("ready.json", signIn(firstUser))
        var number = 1
        while (true) {
            val command = awaitCommand(number).trim().split(' ')
            if (command[0] == "stop") break
            val result = try {
                when (command[0]) {
                    "signin" -> signIn(command[1])
                    "request" -> request(command[1], command[2], command[3], text(command[4]))
                    "status" -> status(command[1])
                    "open" -> open(command[1])
                    "decide" -> decide(command[1], readLog = command.getOrNull(2) != "nolog")
                    "override" -> override(command[1], text(command[2]))
                    else -> error("unknown command '${command[0]}'")
                }
            } catch (failure: Throwable) {
                JSONObject().put("error", failure.message ?: failure.toString())
            }
            answer("res-$number.json", result.put("command", command[0]))
            number++
        }
    }

    private fun signIn(username: String): JSONObject {
        if (screen.isOffered("logout")) {
            screen.click("logout")
            screen.awaitMessage("Signed out")
        }
        val started = SystemClock.elapsedRealtimeNanos()
        screen.signIn(host, username)
        return JSONObject().put("username", username)
            .put("signInMs", (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0)
    }

    /**
     * The officer fills the form and sends the request; the time runs from the press to the ledger's
     * answer.
     */
    private fun request(recordId: String, action: String, purpose: String, reason: String): JSONObject {
        screen.type("request_record", recordId)
        screen.choose("request_action", actionLabel(action))
        screen.choose("request_purpose", purposeLabel(purpose))
        screen.type("request_reason", reason)
        val submitMs = screen.timeToMessageThat("that answers the request", 180_000,
            { it.startsWith("Request ") || it.contains("Nothing was") || it.contains("may have been recorded") }) {
            screen.click("request_submit")
        }
        val shown = screen.text("message")
        val requestId = REQUEST_ID.find(shown)?.groupValues?.get(1) ?: error(shown)
        return JSONObject().put("requestId", requestId).put("submitMs", submitMs)
            .put("automatic", shown.contains("was granted at once")).put("message", shown)
            .put("lines", JSONArray(screen.lines("request_status")))
    }

    /** The officer presses Check status on the request the card follows. */
    private fun status(requestId: String): JSONObject {
        check(screen.lines("request_status").firstOrNull() == "Request: $requestId") {
            "the request card does not follow $requestId"
        }
        val statusMs = screen.timeToMessage("Request $requestId") { screen.click("request_check") }
        val lines = screen.lines("request_status")
        val state = lines.firstOrNull { it.startsWith("Outcome: ") || it.startsWith("Status: ") } ?: ""
        return JSONObject().put("requestId", requestId).put("statusMs", statusMs)
            .put("message", screen.text("message")).put("state", state.substringAfter(": "))
            .put("explanationShown", lines.any { it.startsWith("LLM explanation (advisory): ") })
            .put("lines", JSONArray(lines))
    }

    /** The auditor reads the queue and opens the review of one request. */
    private fun open(requestId: String): JSONObject {
        val queueMs = screen.timeToMessage("awaiting an auditor") { screen.click("auditor_refresh") }
        val pendingShown = screen.lines("auditor_queue").count { it == "Review" }
        val reviewMs = screen.timeToMessage("Review $requestId") { screen.click("review_$requestId") }
        return JSONObject().put("requestId", requestId).put("queueMs", queueMs).put("reviewMs", reviewMs)
            .put("pendingShown", pendingShown).put("advice", adviceShown())
    }

    /** The auditor follows the advice of the open review and confirms it. */
    private fun decide(requestId: String, readLog: Boolean): JSONObject {
        val advice = adviceShown()
        val followed = advice == "ALLOW" || advice == "DENY"
        val grant = advice == "ALLOW"
        if (!followed) screen.type("auditor_reason", NO_ADVICE_REASON)
        screen.click(if (grant) "auditor_allow" else "auditor_deny")
        if (screen.dialogMessage().contains(CREATES_AUTHORIZATION)) {
            screen.pressDialogButton("Cancel")
            error("this decision would create a reusable authorization; it was cancelled")
        }
        return confirm(requestId, grant, readLog).put("advice", advice).put("followed", followed)
    }

    /**
     * The auditor grants against a committed DENY, which creates the exact-scope reusable authorization.
     */
    private fun override(requestId: String, reason: String): JSONObject {
        val advice = adviceShown()
        check(advice == "DENY") { "the advice shown is '$advice'; an override needs a committed DENY" }
        screen.type("auditor_reason", reason)
        screen.click("auditor_allow")
        if (!screen.dialogMessage().contains(CREATES_AUTHORIZATION)) {
            screen.pressDialogButton("Cancel")
            error("the grant would not create a reusable authorization; it was cancelled")
        }
        val result = confirm(requestId, grant = true, readLog = true).put("advice", advice).put("followed", false)
        val created = screen.lines("access_log_rows").take(ROW_LINES).lastOrNull()
            ?.let { AUTHORIZATION_ID.find(it)?.groupValues?.get(1) }
        return result.put("authorizationId", created ?: JSONObject.NULL)
    }

    /**
     * Press the dialog's confirming button, wait for the ledger's confirmation, then read the access log.
     */
    private fun confirm(requestId: String, grant: Boolean, readLog: Boolean): JSONObject {
        val outcome = if (grant) "GRANTED" else "DENIED"
        val press = screen.dialogButton(if (grant) "Record grant" else "Record denial")
        val decisionMs = screen.timeToMessage("Fabric confirms $outcome for $requestId", 120_000) { press() }
        val confirmed = screen.text("message")
        val result = JSONObject().put("requestId", requestId).put("decisionMs", decisionMs)
            .put("decision", if (grant) "FORCE_ALLOW" else "FORCE_DENY").put("outcome", outcome)
            .put("outcomeId", OUTCOME_ID.find(confirmed)?.groupValues?.get(1))
        if (!readLog) return result
        val logMs = screen.timeToMessage("Access log read from Fabric") { screen.click("access_log_refresh") }
        val newest = screen.lines("access_log_rows").take(ROW_LINES)
        val decisionLabel = if (grant) "FORCE ALLOW" else "FORCE DENY"
        return result.put("logMs", logMs)
            .put("logFirstRowIsThisRequest", newest.firstOrNull()?.endsWith(requestId) == true)
            .put("logShowsDecision", newest.any { it.startsWith("Auditor decided: $decisionLabel") })
            .put("logShowsOutcome", newest.lastOrNull()?.startsWith("Outcome: $outcome") == true)
    }

    private fun adviceShown(): String =
        screen.lines("auditor_details").first { it.startsWith(ADVICE_LINE) }.removePrefix(ADVICE_LINE)

    private fun text(encoded: String): String =
        String(Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), Charsets.UTF_8)

    /** Wait for the host's next command file. Checking a local file costs the host nothing. */
    private fun awaitCommand(number: Int): String {
        val file = File(folder, "cmd-$number")
        val deadline = SystemClock.elapsedRealtime() + COMMAND_TIMEOUT_MS
        while (!file.exists()) {
            check(SystemClock.elapsedRealtime() < deadline) { "no command $number from the host in time" }
            Thread.sleep(25)
        }
        return file.readText()
    }

    /** Written under another name first, so the host never reads half an answer. */
    private fun answer(name: String, content: JSONObject) {
        val draft = File(folder, "$name.tmp")
        draft.writeText(content.toString())
        check(draft.renameTo(File(folder, name))) { "could not save $name" }
    }

    private companion object {
        const val ROW_LINES = 6
        const val COMMAND_TIMEOUT_MS = 30 * 60_000L
        const val ADVICE_LINE = "LLM recommendation (advisory): "
        const val CREATES_AUTHORIZATION = "creates an exact-scope reusable authorization"
        const val NO_ADVICE_REASON =
            "No committed and verified LLM recommendation was available; denied pending manual review."
        val REQUEST_ID = Regex("^Request (REQ-[A-Za-z0-9._-]+)[ :]")
        val OUTCOME_ID = Regex("\\((OUTCOME-[0-9a-f]+)\\)")
        val AUTHORIZATION_ID = Regex("created authorization ([A-Za-z0-9._-]+)")
    }
}
