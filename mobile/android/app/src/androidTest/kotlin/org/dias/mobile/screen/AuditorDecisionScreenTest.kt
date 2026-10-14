package org.dias.mobile.screen

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.dias.mobile.screen.FakeHost.Companion.failure
import org.dias.mobile.screen.FakeHost.Companion.success
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The auditor's final decision, made on the phone screen against a scripted host. */
@RunWith(AndroidJUnit4::class)
class AuditorDecisionScreenTest {
    private lateinit var host: FakeHost
    private lateinit var screen: Screen

    @Before fun start() { host = FakeHost(); screen = Screen() }
    @After fun stop() {
        if (::screen.isInitialized) screen.close()
        if (::host.isInitialized) host.close()
    }

    private val pendingPath = "/api/access/auditor/pending"
    private val reviewPath = "/api/access/auditor/REQ-1"
    private val decisionPath = "/api/access/auditor/REQ-1/decision"
    private val requestPath = "/api/access/request/REQ-1"

    /** One request as the host shows it to an auditor. A null `committed` is advice not yet committed. */
    private fun review(committed: String? = "ALLOW", state: String = "committed") = JSONObject()
        .put("request", JSONObject()
            .put("requestId", "REQ-1").put("recordId", "REC-FIR-001").put("caseId", "CASE-2026-001")
            .put("action", "view").put("purpose", "investigation").put("status", "awaiting-auditor")
            .put("requester", JSONObject().put("username", "insp.sharma"))
            .put("verifiedRequest", JSONObject()
                .put("requester", JSONObject().put("role", "inspector").put("organization", "police")
                    .put("clearance", "high").put("credentialStatus", "active")
                    .put("assignedToRequestedCase", true))
                .put("resource", JSONObject().put("recordType", "fir").put("sensitivityLevel", "medium")
                    .put("jurisdiction", "district-north").put("owningAgency", "police")
                    .put("sealed", false).put("juvenileFlag", false).put("witnessFlag", false)
                    .put("victimProtectionFlag", false))))
        .put("commitment", committed?.let {
            JSONObject().put("recommendation", it).put("generationStatus", "OK")
        } ?: JSONObject.NULL)
        .put("justification", "Assigned to this investigation")
        .put("recommendationState", state)
        .put("recommendation", committed?.let {
            JSONObject().put("recommendation", it).put("generationStatus", "OK")
                .put("reason", "The officer is assigned to the case.")
        } ?: JSONObject.NULL)
        .put("integrity", JSONObject().put("status", if (committed == null) "no-commitment" else "verified")
            .put("problems", JSONArray()))

    private fun scriptQueue(review: JSONObject) {
        host.signsInAs("sp.north", "audit", "sp")
        host.on("GET", pendingPath) { success(JSONArray().put(review)) }
        host.on("GET", reviewPath) { success(review) }
    }

    private fun scriptDecision(outcome: String, status: String) {
        host.on("POST", decisionPath) {
            success(JSONObject().put("accessOutcome", JSONObject().put("outcome", outcome)
                .put("outcomeId", "OUTCOME-1").put("basis", "AUDITOR_DECISION"))
                .put("dynamicAuthorization", JSONObject.NULL), 201)
        }
        host.on("GET", requestPath) {
            success(JSONObject().put("requestId", "REQ-1").put("recordId", "REC-FIR-001")
                .put("status", status).put("outcomeId", "OUTCOME-1"))
        }
    }

    private fun openReview() {
        screen.signIn(host.baseUrl, "sp.north")
        screen.click("auditor_refresh")
        screen.awaitMessage("1 request awaiting an auditor")
        screen.click("review_REQ-1")
        screen.awaitMessage("Review REQ-1")
    }

    @Test fun anAuditorGrantsARequestTheLlmAlsoAllowed() {
        scriptQueue(review("ALLOW"))
        scriptDecision("GRANTED", "granted")
        openReview()
        val details = screen.lines("auditor_details")
        assertTrue(details.contains("LLM recommendation (advisory): ALLOW"))
        assertTrue(details.contains("LLM explanation: The officer is assigned to the case."))
        assertTrue(details.contains("Requester justification (unverified claim): Assigned to this investigation"))

        screen.click("auditor_allow")
        assertTrue(screen.dialogMessage().contains("LLM advice: ALLOW"))
        assertTrue("Nothing is sent before the auditor confirms", host.calls("POST", decisionPath).isEmpty())
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("Fabric confirms GRANTED for REQ-1 (OUTCOME-1)")

        val sent = host.calls("POST", decisionPath)
        assertEquals("The decision is submitted exactly once", 1, sent.size)
        assertEquals(FakeHost.BEARER, sent.single().authorization)
        val body = JSONObject(sent.single().body)
        assertEquals("FORCE_ALLOW", body.getString("decision"))
        assertEquals("", body.getString("reason"))
        // The phone never reports an agreement or a recommendation; the ledger derives both.
        assertEquals(setOf("decision", "reason"), body.keys().asSequence().toSet())
        assertEquals(1, host.calls("GET", requestPath).size)
        assertEquals(listOf("No pending requests loaded."), screen.lines("auditor_queue"))
        assertFalse(screen.isShown("auditor_allow"))
        assertTrue(screen.text("auditor_info").contains("GRANTED · OUTCOME-1 · verified on Fabric"))
    }

    @Test fun aDenialAgainstTheLlmNeedsAReasonBeforeItIsSent() {
        scriptQueue(review("ALLOW"))
        scriptDecision("DENIED", "denied")
        openReview()

        screen.click("auditor_deny")
        assertNotNull("A reason is asked for", screen.error("auditor_reason"))
        assertTrue(host.calls("POST", decisionPath).isEmpty())

        screen.type("auditor_reason", "The stated purpose does not match the case diary.")
        screen.click("auditor_deny")
        val asked = screen.dialogMessage()
        assertTrue(asked.contains("LLM advice: ALLOW") && asked.contains("No reusable authorization will be created."))
        screen.pressDialogButton("Record denial")
        screen.awaitMessage("Fabric confirms DENIED for REQ-1 (OUTCOME-1)")

        val body = JSONObject(host.calls("POST", decisionPath).single().body)
        assertEquals("FORCE_DENY", body.getString("decision"))
        assertEquals("The stated purpose does not match the case diary.", body.getString("reason"))
    }

    @Test fun aGrantOverACommittedDenialSaysItCreatesAReusableAuthorization() {
        scriptQueue(review("DENY"))
        scriptDecision("GRANTED", "granted")
        openReview()
        assertTrue(screen.lines("auditor_details")
            .contains("Allow consequence: Grant and create exact-scope reusable authorization"))

        screen.type("auditor_reason", "A court order covers this export.")
        screen.click("auditor_allow")
        assertTrue(screen.dialogMessage().contains("This also creates an exact-scope reusable authorization."))
        screen.pressDialogButton("Cancel")
        assertTrue("Cancelling sends nothing", host.calls("POST", decisionPath).isEmpty())
        assertTrue(screen.isOffered("auditor_allow"))
    }

    @Test fun adviceStillBeingPreparedCannotBeDecided() {
        scriptQueue(review(committed = null, state = "pending"))
        openReview()
        assertFalse(screen.isOffered("auditor_allow"))
        assertFalse(screen.isOffered("auditor_deny"))
        assertTrue(screen.lines("auditor_details").any { it.startsWith("Decision unavailable: The LLM recommendation is still being prepared") })
    }

    @Test fun adviceThatWasNeverCommittedIsNotTreatedAsARecommendation() {
        // The off-chain value exists, but the ledger holds no commitment for it.
        val uncommitted = review("DENY").put("commitment", JSONObject.NULL)
            .put("recommendationState", "commit-rejected")
            .put("integrity", JSONObject().put("status", "no-commitment").put("problems", JSONArray()))
        scriptQueue(uncommitted)
        openReview()
        val details = screen.lines("auditor_details")
        assertTrue(details.contains("LLM recommendation (advisory): No committed recommendation"))
        assertTrue(details.contains("Allow consequence: Grant this request"))
        assertFalse(details.any { it.startsWith("LLM explanation") })

        screen.click("auditor_deny")
        assertNotNull("Deciding without a recommendation needs a reason", screen.error("auditor_reason"))
        assertTrue(host.calls("POST", decisionPath).isEmpty())
    }

    @Test fun anUnconfirmedSubmissionIsNotOfferedForABlindRetry() {
        scriptQueue(review("ALLOW"))
        host.on("POST", decisionPath) { failure(503, "this decision is not confirmed: the ledger did not answer in time") }
        openReview()
        screen.click("auditor_allow")
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("The decision may have been recorded. Refresh the queue before deciding again.")
        assertEquals(1, host.calls("POST", decisionPath).size)
        assertFalse("The review is closed until the queue is read again", screen.isShown("auditor_allow"))
    }

    @Test fun aReplyThatCannotBeReadClosesTheReview() {
        // The host answered 201, so the decision is on the ledger; the phone could not read the reply.
        scriptQueue(review("ALLOW"))
        host.on("POST", decisionPath) { FakeHost.Reply(201, "<html>proxy page</html>") }
        openReview()
        screen.click("auditor_allow")
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("The decision may have been recorded. Refresh the queue before deciding again.")
        assertEquals(1, host.calls("POST", decisionPath).size)
        assertFalse("A committed decision is not offered again", screen.isShown("auditor_allow"))
    }

    @Test fun aLostConnectionAfterSendingClosesTheReview() {
        scriptQueue(review("ALLOW"))
        host.on("POST", decisionPath) { FakeHost.DROPPED }
        openReview()
        screen.click("auditor_allow")
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("The decision may have been recorded. Refresh the queue before deciding again.")
        assertEquals("The phone does not send the decision again by itself", 1,
            host.calls("POST", decisionPath).size)
        assertFalse(screen.isShown("auditor_allow"))
    }

    @Test fun aRefusalThatWroteNothingKeepsTheReviewOpenForCorrection() {
        scriptQueue(review("ALLOW"))
        host.on("POST", decisionPath) { failure(400, "a reason is required for this decision") }
        openReview()
        screen.click("auditor_allow")
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("a reason is required for this decision. Nothing was recorded.")
        assertTrue("The auditor can correct the decision and send it", screen.isOffered("auditor_allow"))

        scriptDecision("GRANTED", "granted")
        screen.type("auditor_reason", "Reason added after the host asked for one.")
        screen.click("auditor_allow")
        screen.pressDialogButton("Record grant")
        screen.awaitMessage("Fabric confirms GRANTED for REQ-1 (OUTCOME-1)")
        assertEquals(2, host.calls("POST", decisionPath).size)
    }

    @Test fun signingOutLeavesNothingOfTheReviewInTheHiddenScreen() {
        scriptQueue(review("ALLOW"))
        openReview()
        screen.type("auditor_reason", "A half-written reason")
        assertTrue(screen.lines("auditor_details").isNotEmpty())
        screen.click("logout")
        screen.awaitMessage("Signed out")
        assertFalse(screen.isShown("auditor_refresh"))
        assertTrue(screen.lines("auditor_details").isEmpty())
        assertTrue(screen.lines("auditor_queue").isEmpty())
        assertEquals("", screen.text("auditor_reason"))
        assertEquals("", screen.text("auditor_info"))
    }

    @Test fun anOfficerIsNeverOfferedTheAuditorScreen() {
        host.signsInAs("insp.sharma", "police", "inspector")
        screen.signIn(host.baseUrl, "insp.sharma")
        assertFalse(screen.isShown("auditor_refresh"))
        assertFalse(screen.isShown("auditor_allow"))
        assertTrue(host.calls.none { it.path.startsWith("/api/access/auditor") })
    }
}
