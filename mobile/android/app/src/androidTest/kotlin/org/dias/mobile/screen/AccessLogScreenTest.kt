package org.dias.mobile.screen

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.dias.mobile.screen.FakeHost.Companion.entries
import org.dias.mobile.screen.FakeHost.Companion.failure
import org.dias.mobile.screen.FakeHost.Companion.success
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The access log on the phone screen: the full log for every officer, reviewer or not. */
@RunWith(AndroidJUnit4::class)
class AccessLogScreenTest {
    private lateinit var host: FakeHost
    private lateinit var screen: Screen

    @Before fun start() { host = FakeHost(); screen = Screen() }
    @After fun stop() {
        if (::screen.isInitialized) screen.close()
        if (::host.isInitialized) host.close()
    }

    private val fullPath = "/api/access/workflow-log"
    private val reducedPath = "/api/access/decision-log"
    private val minePath = "/api/access/requests/mine"

    /** A settled request as a reviewer receives it from the ledger. */
    private fun decided(id: String, minute: Int = 23) = JSONObject()
        .put("requestId", id).put("recordId", "REC-FIR-001").put("caseId", "CASE-2026-001")
        .put("action", "annotate").put("purpose", "investigation").put("status", "granted")
        .put("requester", JSONObject().put("username", "insp.sharma").put("organization", "police")
            .put("role", "inspector"))
        .put("submittedAtUtc", "2026-10-12T07:18:04.240Z")
        .put("outcome", "GRANTED").put("basis", "AUDITOR_DECISION")
        .put("auditor", JSONObject().put("username", "sp.north").put("role", "sp"))
        .put("decision", "FORCE_ALLOW").put("llmAgreement", "AGREED").put("llmRecommendation", "ALLOW")
        .put("recommendationWithheld", false).put("authorizationId", JSONObject.NULL)
        .put("createdAuthorizationId", JSONObject.NULL)
        .put("decidedAtUtc", "2026-10-12T07:%02d:41.063Z".format(minute))

    private fun waiting(id: String) = JSONObject()
        .put("requestId", id).put("recordId", "REC-FSL-002").put("caseId", "CASE-2026-002")
        .put("action", "export").put("purpose", "prosecution").put("status", "awaiting-auditor")
        .put("requester", JSONObject().put("username", "const.verma").put("organization", "police")
            .put("role", "constable"))
        .put("submittedAtUtc", "2026-10-12T09:00:00.000Z")
        .put("outcome", JSONObject.NULL).put("basis", JSONObject.NULL).put("auditor", JSONObject.NULL)
        .put("decision", JSONObject.NULL).put("llmAgreement", JSONObject.NULL)
        .put("llmRecommendation", "DENY").put("recommendationWithheld", false)
        .put("decidedAtUtc", JSONObject.NULL)

    /**
     * A settled request marked as reduced. The contract sends only the first block of fields; the second
     * block is what a faulty host could add, and none of it may reach the screen.
     */
    private fun reduced(decision: String, recommendation: String, agreement: String, outcome: String) =
        JSONObject().put("redacted", true).put("outcome", outcome).put("basis", "AUDITOR_DECISION")
            .put("decision", decision).put("llmRecommendation", recommendation)
            .put("llmAgreement", agreement).put("generationStatus", "OK")
            .put("action", "view").put("purpose", "investigation")
            .put("decidedAtUtc", "2026-10-12T07:23:41.063Z")
            .put("requester", JSONObject().put("organization", "forensics")
                .put("username", "leak.name").put("role", "leak-role"))
            .put("requestId", "REQ-LEAK").put("recordId", "REC-LEAK").put("caseId", "CASE-LEAK")
            .put("auditor", JSONObject().put("username", "leak.auditor").put("role", "sp"))
            .put("authorizationId", "AUTH-LEAK").put("createdAuthorizationId", "AUTH-LEAK-NEW")
            .put("outcomeTxId", "tx-leak").put("decisionTxId", "tx-leak")

    /** The caller's own request record, as `requests/mine` returns it. */
    private fun ownRequest() = JSONObject()
        .put("requestId", "REQ-MINE").put("recordId", "REC-FIR-001").put("caseId", "CASE-2026-001")
        .put("action", "view").put("purpose", "investigation").put("status", "denied")
        .put("requester", JSONObject().put("username", "insp.sharma").put("organization", "police")
            .put("role", "inspector"))
        .put("submittedAtUtc", "2026-10-12T06:00:00.000Z")
        .put("auditorReviewStatus", "FORCE_DENY").put("processingPath", "auditor-review")
        .put("llmRecommendation", "ALLOW").put("llmAgreement", "NOT_AGREED")
        .put("createdAuthorizationId", JSONObject.NULL)
        .put("dynamicAuthorizationCheck", JSONObject().put("matched", false)
            .put("authorizationId", JSONObject.NULL))

    /** The same waiting request as any officer outside the reviewer set receives it. */
    private fun waitingWithheld(id: String) = waiting(id)
        .put("llmRecommendation", JSONObject.NULL).put("recommendationWithheld", true)

    private fun scriptOfficer() {
        host.signsInAs("insp.sharma", "police", "inspector")
        host.on("GET", fullPath) { success(entries(decided("REQ-9"), waitingWithheld("REQ-10"))) }
    }

    /** A host that still runs the earlier contract: it refuses the full log to this officer. */
    private fun scriptEarlierHost() {
        host.signsInAs("insp.sharma", "police", "inspector")
        host.on("GET", fullPath) { failure(403, "unauthorized: QueryAccessWorkflowLog requires a reviewer") }
        host.on("GET", reducedPath) {
            success(entries(reduced("FORCE_ALLOW", "ALLOW", "AGREED", "GRANTED"),
                reduced("FORCE_DENY", "ALLOW", "NOT_AGREED", "DENIED")))
        }
        host.on("GET", minePath) { success(entries(ownRequest())) }
    }

    @Test fun aReviewerReadsTheFullLogWithNamesCaseFilesAndWaitingRequests() {
        host.signsInAs("sp.north", "audit", "sp")
        host.on("GET", fullPath) { success(entries(decided("REQ-9"), waiting("REQ-10"))) }
        screen.signIn(host.baseUrl, "sp.north")
        assertEquals("Press Refresh to read the access log from Fabric.", screen.text("access_log_info"))

        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 2 requests.")
        assertTrue(screen.text("access_log_info").startsWith("2 requests on the ledger"))
        assertTrue(screen.text("access_log_scope").startsWith("Full log"))
        val lines = screen.lines("access_log_rows")
        // Newest first: the request still waiting was raised after the other was decided.
        assertTrue(lines.indexOfFirst { it.endsWith("REQ-10") } < lines.indexOfFirst { it.endsWith("REQ-9") })
        assertTrue(lines.containsAll(listOf(
            "const.verma · constable · police", "REC-FSL-002 · export · prosecution",
            "LLM recommended: DENY", "Auditor decided: Waiting for auditor · no final decision committed",
            "Outcome: Waiting",
            "insp.sharma · inspector · police", "REC-FIR-001 · annotate · investigation",
            "LLM recommended: ALLOW",
            "Auditor decided: FORCE ALLOW · agreed with the LLM's ALLOW · by sp.north",
            "Outcome: GRANTED")))
        assertFalse("A full log needs no second list", screen.isShown("access_log_mine"))

        val read = host.calls("GET", fullPath).single()
        assertEquals("/api/access/workflow-log?limit=100", read.target)
        assertEquals(FakeHost.BEARER, read.authorization)
        assertTrue(host.calls("GET", reducedPath).isEmpty())
    }

    @Test fun anOfficerReadsTheFullLogAndAdviceOnAWaitingRequestIsWithheld() {
        scriptOfficer()
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 2 requests.")
        assertTrue(screen.text("access_log_scope").startsWith("Full log"))
        val lines = screen.lines("access_log_rows")
        assertTrue(lines.containsAll(listOf(
            "const.verma · constable · police", "REC-FSL-002 · export · prosecution",
            "LLM recommended: Withheld until decision · shown once the auditor has decided",
            "Auditor decided: Waiting for auditor · no final decision committed",
            "Outcome: Waiting",
            "insp.sharma · inspector · police", "REC-FIR-001 · annotate · investigation",
            "LLM recommended: ALLOW",
            "Auditor decided: FORCE ALLOW · agreed with the LLM's ALLOW · by sp.north",
            "Outcome: GRANTED")))
        assertFalse("A full log needs no second list", screen.isShown("access_log_mine"))

        val read = host.calls("GET", fullPath).single()
        assertEquals("/api/access/workflow-log?limit=100", read.target)
        assertEquals(FakeHost.BEARER, read.authorization)
        assertTrue("A full log is not followed by the reduced one", host.calls("GET", reducedPath).isEmpty())
        assertTrue(host.calls("GET", minePath).isEmpty())
    }

    @Test fun adviceAHostMarksAsWithheldIsNotShownEvenIfTheHostSendsItsValue() {
        host.signsInAs("insp.sharma", "police", "inspector")
        host.on("GET", fullPath) { success(entries(waitingWithheld("REQ-10").put("llmRecommendation", "DENY"))) }
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 1 request.")
        val lines = screen.lines("access_log_rows")
        assertTrue(lines.contains("LLM recommended: Withheld until decision · shown once the auditor has decided"))
        assertTrue("The withheld value reaches no line of the screen", lines.none { it.contains("DENY") })
    }

    @Test fun aHostThatRefusesTheFullLogIsReadAsTheReducedLogAndTheOfficersOwnRequests() {
        scriptEarlierHost()
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 2 decisions on the channel and 1 of your own requests.")
        assertTrue(screen.text("access_log_scope").startsWith("Reduced log"))

        val everyone = screen.lines("access_log_rows")
        assertEquals(2, everyone.count { it == "Name hidden · forensics" })
        assertEquals(2, everyone.count { it == "Case file hidden · view · investigation" })
        assertTrue(everyone.containsAll(listOf(
            "Auditor decided: FORCE ALLOW · agreed with the LLM's ALLOW", "Outcome: GRANTED",
            "Auditor decided: FORCE DENY · against the LLM's ALLOW", "Outcome: DENIED")))
        assertTrue("No name, role, case file, request, auditor or authorization in the reduced log",
            everyone.none { it.contains("leak", ignoreCase = true) })

        assertTrue(screen.isSelected("access_log_all"))
        screen.click("access_log_mine")
        assertTrue(screen.isSelected("access_log_mine"))
        assertFalse(screen.isSelected("access_log_all"))
        val mine = screen.lines("access_log_rows")
        assertTrue(mine.any { it.endsWith("REQ-MINE") })
        assertTrue(mine.containsAll(listOf(
            "insp.sharma · inspector · police", "REC-FIR-001 · view · investigation",
            "LLM recommended: ALLOW", "Auditor decided: FORCE DENY · against the LLM's ALLOW",
            "Outcome: DENIED")))
        // Reading the log again keeps the list the reader was on.
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric")
        assertTrue(screen.isSelected("access_log_mine"))
        assertEquals(mine, screen.lines("access_log_rows"))
        screen.click("access_log_all")
        assertEquals(everyone, screen.lines("access_log_rows"))

        assertEquals("The full log is asked for once per read", 2, host.calls("GET", fullPath).size)
        assertEquals("/api/access/decision-log?limit=100", host.calls("GET", reducedPath).first().target)
        assertEquals("/api/access/requests/mine?limit=100", host.calls("GET", minePath).first().target)
    }

    @Test fun olderEntriesAreReachedPageByPage() {
        host.signsInAs("sp.north", "audit", "sp")
        host.on("GET", fullPath) {
            success(entries(*(1..12).map { decided("REQ-%02d".format(it), minute = it) }.toTypedArray()))
        }
        screen.signIn(host.baseUrl, "sp.north")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 12 requests.")
        assertEquals("1–10 of 12", screen.text("access_log_position"))
        assertFalse(screen.isOffered("access_log_newer"))
        assertEquals(10, screen.lines("access_log_rows").count { it.startsWith("Outcome: ") })
        assertTrue(screen.lines("access_log_rows").first().endsWith("REQ-12"))

        screen.click("access_log_older")
        assertEquals("11–12 of 12", screen.text("access_log_position"))
        assertEquals(2, screen.lines("access_log_rows").count { it.startsWith("Outcome: ") })
        assertTrue(screen.lines("access_log_rows").any { it.endsWith("REQ-01") })
        assertFalse(screen.isOffered("access_log_older"))
        screen.click("access_log_newer")
        assertEquals("1–10 of 12", screen.text("access_log_position"))
        assertEquals(1, host.calls("GET", fullPath).size)
        assertFalse("Twelve requests are the whole log", screen.isShown("access_log_cut_off"))
    }

    @Test fun aReadCutOffAtOneHundredSaysOlderRequestsAreNotShown() {
        host.signsInAs("sp.north", "audit", "sp")
        host.on("GET", fullPath) {
            success(entries(*(1..100).map { decided("REQ-%03d".format(it), minute = it % 60) }.toTypedArray()))
        }
        screen.signIn(host.baseUrl, "sp.north")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: the newest 100 requests.")
        assertTrue(screen.text("access_log_info").startsWith("The newest 100 requests on the ledger"))
        assertTrue(screen.isShown("access_log_cut_off"))
        assertTrue(screen.text("access_log_cut_off").startsWith("Only the newest 100 are loaded."))
    }

    @Test fun anEmptyLogSaysSoAndAFailedReadKeepsWhatWasShown() {
        host.signsInAs("sp.north", "audit", "sp")
        host.on("GET", fullPath) { success(entries()) }
        screen.signIn(host.baseUrl, "sp.north")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 0 requests.")
        assertEquals(listOf("No access request has been recorded on this channel."),
            screen.lines("access_log_rows"))

        host.on("GET", fullPath) { success(entries(decided("REQ-9"))) }
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: 1 request.")
        host.on("GET", fullPath) { failure(500, "internal error") }
        screen.click("access_log_refresh")
        screen.awaitMessage("internal error. The access log shown was not updated.")
        assertTrue(screen.lines("access_log_rows").any { it.endsWith("REQ-9") })
    }

    @Test fun signingOutOrAnExpiredSessionRemovesTheLogFromTheScreen() {
        scriptOfficer()
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric")
        screen.click("logout")
        screen.awaitMessage("Signed out")
        assertTrue(screen.lines("access_log_rows").isEmpty())
        assertEquals("Sign in to read the access log.", screen.text("access_log_info"))
        assertFalse(screen.isOffered("access_log_refresh"))

        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric")
        host.on("GET", fullPath) { failure(401, "invalid or expired token") }
        screen.click("access_log_refresh")
        screen.awaitMessage("Session expired. Sign in again.")
        assertTrue(screen.lines("access_log_rows").isEmpty())
    }
}
