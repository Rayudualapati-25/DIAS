package org.dias.mobile.screen

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.data.ApiClient
import org.dias.mobile.data.HostAddress
import org.dias.mobile.domain.AccessLog
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.countedLog
import org.dias.mobile.domain.logPage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URI

/** The same screens against the real Mac host and its Fabric ledger. */
@RunWith(AndroidJUnit4::class)
class LiveHostScreenTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val apiBase: String? = arguments.getString("apiBase")
    private val officer = arguments.getString("username") ?: "insp.sharma"
    private val reviewer = arguments.getString("reviewerUsername") ?: "sp.north"
    private lateinit var screen: Screen

    @Before fun start() {
        assumeTrue("Set apiBase to test against a live host", apiBase != null)
        screen = Screen()
    }
    @After fun stop() { if (::screen.isInitialized) screen.close() }

    /** What the web portal's API returns for this identity, read without the app's client. */
    private fun portal(session: Session, path: String): JSONObject {
        val connection = URI(session.baseUrl + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${session.token}")
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return JSONObject(stream.bufferedReader().use { it.readText() }).put("httpStatus", status)
        } finally { connection.disconnect() }
    }

    private fun JSONObject.entries(): JSONArray = getJSONObject("data").getJSONArray("entries")
    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    /**
     * The phone's access log for one identity against the portal's: the same requests in the client, and
     * the newest of them leading the screen.
     */
    private fun thePhoneLogMatchesThePortal(client: ApiClient, session: Session, picture: String): AccessLog {
        val portalLog = portal(session, "/api/access/workflow-log?limit=100").entries().objects()
        val log = client.accessLog(session)
        assertTrue("Every officer reads the full log", log.full)
        assertEquals("The phone reads the same requests as the portal's access log",
            portalLog.map { it.getString("requestId") }, log.entries.map { it.requestId })
        portalLog.zip(log.entries).forEach { (portal, phone) ->
            assertEquals(portal.getJSONObject("requester").getString("username"), phone.requesterUsername)
            assertEquals(portal.getString("recordId"), phone.recordId)
            assertEquals(portal.optString("decision").takeIf { !portal.isNull("decision") }, phone.decision)
            assertEquals(portal.optString("llmRecommendation").takeIf { !portal.isNull("llmRecommendation") },
                phone.llmRecommendation)
            assertEquals(portal.optString("outcome").takeIf { !portal.isNull("outcome") }, phone.outcome)
        }

        screen.signIn(session.baseUrl, session.username)
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric: " + countedLog(portalLog.size, "request", "requests"))
        assertTrue(screen.text("access_log_scope").startsWith("Full log"))
        val newest = log.entries.logPage(0).rows.firstOrNull()?.requestId
        if (newest != null) assertTrue("The newest request leads the screen",
            screen.lines("access_log_rows").first().endsWith(newest))
        screen.reveal("access_log_info")
        screen.screenshot(picture)
        return log
    }

    @Test fun aReviewerSeesOnThePhoneEveryRequestThePortalLogHolds() {
        val client = ApiClient(HostAddress.normalize(apiBase!!, true))
        val session = client.login(reviewer)
        assertTrue("$reviewer must be a reviewer", session.org in setOf("audit", "court", "prosecution"))
        thePhoneLogMatchesThePortal(client, session, "access-log-reviewer")
    }

    @Test fun anOfficerOutsideTheReviewerSetSeesTheSameFullLog() {
        val client = ApiClient(HostAddress.normalize(apiBase!!, true))
        val session = client.login(officer)
        assertFalse("$officer must be outside the reviewer organisations",
            session.org in setOf("audit", "court", "prosecution"))
        val log = thePhoneLogMatchesThePortal(client, session, "access-log-officer")
        assertTrue("Names and case files are shown to every officer",
            log.entries.all { !it.redacted && it.requesterUsername != null && it.recordId != null })
        assertTrue("The LLM's advice on a request that still waits is not sent to this officer",
            log.entries.filter { it.status == "awaiting-auditor" }.all { it.llmRecommendation == null })
        assertFalse("An officer is not offered the auditor's screen", screen.isShown("auditor_refresh"))
    }

    @Test fun thePhoneQueueShowsTheSameWaitingRequestsAsThePortal() {
        val client = ApiClient(HostAddress.normalize(apiBase!!, true))
        val session = client.login(reviewer)
        assumeTrue("$reviewer must be an audit-organisation district head", session.canAudit)
        val portalQueue = portal(session, "/api/access/auditor/pending").getJSONArray("data").objects()
            .map { it.getJSONObject("request") }

        screen.signIn(session.baseUrl, reviewer)
        screen.click("auditor_refresh")
        screen.awaitMessage("${portalQueue.size} request")
        val queue = screen.lines("auditor_queue")
        assertEquals("One Review button for each request the portal lists",
            portalQueue.size, queue.count { it == "Review" })
        portalQueue.forEach { request ->
            assertTrue("The phone lists ${request.getString("requestId")}",
                screen.isShown("review_${request.getString("requestId")}"))
            assertTrue(queue.contains("${request.getString("recordId")} · " +
                request.getJSONObject("requester").getString("username")))
        }
        screen.reveal("auditor_info")
        screen.screenshot("auditor-queue")
    }

    /** Writes one auditor decision to the ledger, through the screen, for the named request. */
    @Test fun anAuditorDecidesANamedRequestOnThePhoneAndTheLogShowsIt() {
        val requestId = arguments.getString("decisionRequestId")
        val decision = arguments.getString("decision")
        assumeTrue("Set decisionRequestId and decision to record a live auditor decision",
            requestId != null && decision in setOf("FORCE_ALLOW", "FORCE_DENY"))
        val grant = decision == "FORCE_ALLOW"
        val expected = if (grant) "GRANTED" else "DENIED"

        screen.signIn(HostAddress.normalize(apiBase!!, true), reviewer)
        screen.click("auditor_refresh")
        screen.awaitMessage("awaiting an auditor")
        screen.click("review_$requestId")
        screen.awaitMessage("Review $requestId")
        screen.reveal("auditor_review")
        screen.screenshot("auditor-review")
        screen.type("auditor_reason", arguments.getString("decisionReason") ?: "")
        assertTrue("The request must be decidable: " + screen.lines("auditor_details").lastOrNull(),
            screen.isOffered(if (grant) "auditor_allow" else "auditor_deny"))
        screen.reveal("auditor_reason")
        screen.click(if (grant) "auditor_allow" else "auditor_deny")
        val asked = screen.dialogMessage()
        screen.screenshot("auditor-confirm")
        if (asked.contains("creates an exact-scope reusable authorization") &&
            arguments.getString("allowAuthorization") != "true") {
            screen.pressDialogButton("Cancel")
            fail("This grant would create a reusable authorization on the live ledger. " +
                "Pass allowAuthorization=true to record it on purpose.")
        }
        screen.pressDialogButton(if (grant) "Record grant" else "Record denial")
        screen.awaitMessage("Fabric confirms $expected for $requestId", timeoutMillis = 60_000)
        screen.reveal("message")
        screen.screenshot("auditor-confirmed")

        // The decision is now the newest entry of the access log this auditor reads.
        screen.click("access_log_refresh")
        screen.awaitMessage("Access log read from Fabric")
        val lines = screen.lines("access_log_rows")
        assertTrue("The decided request leads the access log", lines.first().endsWith(requestId!!))
        assertTrue(lines.take(6).any {
            it.startsWith("Auditor decided: ${decision!!.replace('_', ' ')}") && it.endsWith("by $reviewer")
        })
        assertTrue(lines.take(6).last().startsWith("Outcome: $expected"))
        screen.reveal("access_log_info")
        screen.screenshot("auditor-access-log")
    }
}
