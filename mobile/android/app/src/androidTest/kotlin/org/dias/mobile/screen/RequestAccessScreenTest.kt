package org.dias.mobile.screen

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.dias.mobile.screen.FakeHost.Companion.entries
import org.dias.mobile.screen.FakeHost.Companion.failure
import org.dias.mobile.screen.FakeHost.Companion.success
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** An officer asks for access on the phone screen and follows the request to its decision. */
@RunWith(AndroidJUnit4::class)
class RequestAccessScreenTest {
    private lateinit var host: FakeHost
    private lateinit var screen: Screen

    @Before fun start() { host = FakeHost(); screen = Screen() }
    @After fun stop() {
        if (::screen.isInitialized) screen.close()
        if (::host.isInitialized) host.close()
    }

    private val submitPath = "/api/access/request"
    private val requestPath = "/api/access/request/REQ-1"
    private val detailPath = "/api/access/request/REQ-1/recommendation"
    private val minePath = "/api/access/requests/mine"
    private val reason = "I am the investigating officer on this case."

    /** The ledger's request record, as the host returns it to the officer who made it. */
    private fun request(status: String = "awaiting-auditor", id: String = "REQ-1", matched: String? = null) =
        JSONObject().put("requestId", id).put("recordId", "REC-FIR-001").put("caseId", "CASE-2026-001")
            .put("action", "export").put("purpose", "prosecution").put("status", status)
            .put("requester", JSONObject().put("username", "insp.sharma").put("organization", "police")
                .put("role", "inspector"))
            .put("submittedAtUtc", "2026-10-14T06:00:00.000Z")
            .put("processingPath", if (matched == null) "auditor-review" else "dynamic-authorization")
            .put("dynamicAuthorizationCheck", JSONObject().put("matched", matched != null)
                .put("authorizationId", matched ?: JSONObject.NULL))

    /** What the host lets the requester read of a decision; `account` only after a denial. */
    private fun detail(decision: String, recommended: String, agreement: String, account: Boolean) = JSONObject()
        .put("requestId", "REQ-1").put("viewer", "requester")
        .put("decision", JSONObject().put("decision", decision).put("llmRecommendation", recommended)
            .put("llmAgreement", agreement)
            .put("auditor", JSONObject().put("username", "sp.north").put("role", "sp")))
        .put("explanationVisible", account).put("available", account)
        .put("recommendation", recommended)
        .put("reason", "The role has no export permission on a FIR.")
        .put("reasonCode", "RBAC_NO_PERMISSION")
        .put("policyRefs", JSONArray().put("GP-RBAC:C2@v1"))
        .put("missingEvidence", JSONArray()).put("reviewFlags", JSONArray())

    private fun signInAndFill() {
        host.signsInAs("insp.sharma", "police", "inspector")
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.type("request_record", "REC-FIR-001")
        screen.choose("request_action", "Export")
        screen.choose("request_purpose", "Prosecution")
        screen.type("request_reason", "  $reason ")
    }

    @Test fun anOfficerRequestsAccessAndTheRequestWaitsForAnAuditor() {
        host.on("POST", submitPath) { success(request().put("processingState", "awaiting-auditor"), 202) }
        host.on("GET", requestPath) { success(request()) }
        assertFalse("Nobody requests access before signing in", screen.isOffered("request_submit"))
        signInAndFill()
        assertFalse("There is no request to check yet", screen.isOffered("request_check"))

        screen.click("request_submit")
        screen.awaitMessage("Request REQ-1 is on the ledger. An auditor will make the final decision.")
        val sent = host.calls("POST", submitPath).single()
        assertEquals(FakeHost.BEARER, sent.authorization)
        val body = JSONObject(sent.body)
        assertEquals(setOf("recordId", "action", "purpose", "justification"), body.keys().asSequence().toSet())
        assertEquals("REC-FIR-001", body.getString("recordId"))
        assertEquals("export", body.getString("action"))
        assertEquals("prosecution", body.getString("purpose"))
        assertEquals(reason, body.getString("justification"))
        assertEquals(listOf("Request: REQ-1", "Case file: REC-FIR-001 · export · prosecution",
            "Status: Waiting for the auditor",
            "Nothing from the LLM is shown to you before the auditor decides."), screen.lines("request_status"))
        assertEquals("The reason is not kept on the screen once it is sent", "", screen.text("request_reason"))

        screen.click("request_check")
        screen.awaitMessage("Request REQ-1 is waiting for an auditor.")
        assertEquals(1, host.calls("GET", requestPath).size)
        assertTrue("A waiting request has no decision to read", host.calls("GET", detailPath).isEmpty())
    }

    @Test fun afterADenialTheOfficerReadsTheDecisionAndTheLlmExplanation() {
        host.on("POST", submitPath) { success(request(), 202) }
        host.on("GET", requestPath) { success(request("denied")) }
        host.on("GET", detailPath) { success(detail("FORCE_DENY", "DENY", "AGREED", account = true)) }
        signInAndFill()
        screen.click("request_submit")
        screen.awaitMessage("Request REQ-1 is on the ledger")
        screen.click("request_check")
        screen.awaitMessage("Request REQ-1: DENIED by sp.north.")
        assertEquals(listOf("Request: REQ-1", "Case file: REC-FIR-001 · export · prosecution",
            "Outcome: DENIED", "Auditor decision: FORCE DENY by sp.north", "LLM recommendation: DENY",
            "Decision against the LLM: agreed",
            "LLM explanation (advisory): The role has no export permission on a FIR.",
            "Reason code: RBAC_NO_PERMISSION", "Policy clauses cited: GP-RBAC:C2@v1",
            "What the LLM said was missing: nothing", "Review flags: none"), screen.lines("request_status"))
        assertEquals(FakeHost.BEARER, host.calls("GET", detailPath).single().authorization)
    }

    @Test fun afterAGrantTheOfficerReadsTheDecisionWithoutTheLlmExplanation() {
        host.on("POST", submitPath) { success(request(), 202) }
        host.on("GET", requestPath) { success(request("granted")) }
        // A faulty host that sends the account with a grant: none of it may reach the screen.
        host.on("GET", detailPath) {
            success(detail("FORCE_ALLOW", "DENY", "NOT_AGREED", account = false)
                .put("reason", "LEAK").put("reasonCode", "LEAK").put("policyRefs", JSONArray().put("LEAK")))
        }
        signInAndFill()
        screen.click("request_submit")
        screen.awaitMessage("Request REQ-1 is on the ledger")
        screen.click("request_check")
        screen.awaitMessage("Request REQ-1: GRANTED by sp.north.")
        assertEquals(listOf("Request: REQ-1", "Case file: REC-FIR-001 · export · prosecution",
            "Outcome: GRANTED", "Auditor decision: FORCE ALLOW by sp.north", "LLM recommendation: DENY",
            "Decision against the LLM: not agreed"), screen.lines("request_status"))
        assertTrue(screen.lines("request_status").none { it.contains("LEAK") })
    }

    @Test fun anExactReusableAuthorizationGrantsAtOnce() {
        host.on("POST", submitPath) {
            success(request("granted", matched = "AUTH-7").put("processingState", "decided"), 201)
        }
        host.on("GET", requestPath) { success(request("granted", matched = "AUTH-7")) }
        signInAndFill()
        screen.click("request_submit")
        screen.awaitMessage("Request REQ-1 was granted at once by reusable authorization AUTH-7. " +
            "No auditor review was needed.")
        assertEquals(listOf("Request: REQ-1", "Case file: REC-FIR-001 · export · prosecution",
            "Outcome: GRANTED", "Granted by reusable authorization AUTH-7",
            "Neither the LLM nor an auditor was asked."), screen.lines("request_status"))
        screen.click("request_check")
        screen.awaitMessage("Request REQ-1: GRANTED by reusable authorization AUTH-7.")
        assertTrue("No auditor decided, so there is no decision to read", host.calls("GET", detailPath).isEmpty())
    }

    @Test fun anIncompleteRequestIsNotSent() {
        host.on("POST", submitPath) { success(request(), 202) }
        signInAndFill()
        screen.type("request_reason", " a ")
        screen.click("request_submit")
        screen.awaitMessage("Say why you need it, in at least 3 characters. Nothing was sent.")
        screen.type("request_reason", reason)
        screen.type("request_record", "REC FIR 001")
        screen.click("request_submit")
        screen.awaitMessage("Enter a case-file identifier, for example REC-FIR-001. Nothing was sent.")
        assertTrue(host.calls("POST", submitPath).isEmpty())
        assertTrue(screen.lines("request_status").isEmpty())
    }

    @Test fun aRefusalRecordsNothingAndALostReplySaysTheRequestMayExist() {
        host.on("POST", submitPath) { failure(422, "access request: case file 'REC-FIR-001' does not exist") }
        signInAndFill()
        screen.click("request_submit")
        screen.awaitMessage("does not exist. Nothing was recorded. You can correct the request and send it again.")
        assertEquals("A refused request keeps what was typed", "  $reason ", screen.text("request_reason"))

        host.on("POST", submitPath) { FakeHost.DROPPED }
        screen.click("request_submit")
        screen.awaitMessage("The request may have been recorded. Read My requests before sending it again.")
        assertEquals(2, host.calls("POST", submitPath).size)
        assertTrue(screen.lines("request_status").isEmpty())
    }

    @Test fun theOfficersOwnRequestsCanBeReadAndOpenedAgain() {
        host.signsInAs("insp.sharma", "police", "inspector")
        host.on("GET", minePath) { success(entries(request("denied", "REQ-1"), request("awaiting-auditor", "REQ-2"))) }
        host.on("GET", requestPath) { success(request("denied")) }
        host.on("GET", detailPath) { success(detail("FORCE_DENY", "DENY", "AGREED", account = true)) }
        screen.signIn(host.baseUrl, "insp.sharma")
        screen.click("request_mine")
        screen.awaitMessage("2 of your requests read from Fabric.")
        assertEquals("/api/access/requests/mine?limit=10", host.calls("GET", minePath).single().target)
        val listed = screen.lines("request_list")
        assertTrue(listed.containsAll(listOf("REQ-1 · REC-FIR-001 · export · denied",
            "REQ-2 · REC-FIR-001 · export · waiting for an auditor")))

        screen.click("request_open_REQ-1")
        screen.awaitMessage("Request REQ-1: DENIED by sp.north.")
        assertTrue(screen.lines("request_status").contains("Reason code: RBAC_NO_PERMISSION"))
    }

    @Test fun signingOutRemovesTheRequestFromTheScreen() {
        host.on("POST", submitPath) { success(request(), 202) }
        host.on("GET", minePath) { success(entries(request())) }
        signInAndFill()
        screen.click("request_submit")
        screen.awaitMessage("Request REQ-1 is on the ledger")
        screen.click("request_mine")
        screen.awaitMessage("1 of your requests read from Fabric.")
        screen.type("request_reason", "typed and not sent")
        screen.click("logout")
        screen.awaitMessage("Signed out")
        assertTrue(screen.lines("request_status").isEmpty())
        assertTrue(screen.lines("request_list").isEmpty())
        assertEquals("", screen.text("request_reason"))
        assertEquals("", screen.text("request_record"))
        assertFalse(screen.isOffered("request_submit"))
        assertFalse(screen.isOffered("request_check"))
    }
}
