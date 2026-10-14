package org.dias.mobile.data

import org.dias.mobile.domain.AccessLog
import org.dias.mobile.domain.AccessLogEntry
import org.dias.mobile.domain.AccessRequestDraft
import org.dias.mobile.domain.AccessRequestStatus
import org.dias.mobile.domain.AuditorReview
import org.dias.mobile.domain.CasePage
import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.DecisionReceipt
import org.dias.mobile.domain.RemoteAccessLog
import org.dias.mobile.domain.RemoteAuditor
import org.dias.mobile.domain.RemoteCases
import org.dias.mobile.domain.RemoteRequests
import org.dias.mobile.domain.RequestProgress
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.committedRecommendation
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder

class ApiFailure(val status: Int, message: String) : IOException(message)

class ApiClient(val baseUrl: String) : RemoteCases, RemoteAuditor, RemoteAccessLog, RemoteRequests {
    override fun health() {
        check(request("/api/health").getString("data") == "ok") { "Unexpected host response" }
    }

    override fun login(username: String): Session {
        val data = request("/api/auth/login", body = JSONObject().put("username", username))
            .getJSONObject("data")
        val user = data.getJSONObject("user")
        return Session(baseUrl, user.getString("username"), user.getString("org"),
            data.getString("token"), user.getString("role"))
    }

    override fun cases(session: Session, cursor: String?, limit: Int): CasePage {
        require(session.baseUrl == baseUrl) { "Sign in again after changing host" }
        val suffix = cursor?.let { "&cursor=${URLEncoder.encode(it, "UTF-8")}" } ?: ""
        val data = request("/api/mobile/cases?limit=$limit$suffix", session.token).getJSONObject("data")
        val items = data.getJSONArray("items")
        val summaries = (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            CaseSummary(item.getString("caseId"), item.getString("owningAgency"),
                item.getString("jurisdiction"), item.getString("status"))
        }
        return CasePage(summaries, if (data.isNull("nextCursor")) null else data.getString("nextCursor"))
    }

    /**
     * The access log. Every enrolled officer reads the full workflow log: who asked for which case file,
     * what the LLM recommended and what the auditor decided.
     */
    override fun accessLog(session: Session, limit: Int): AccessLog {
        require(session.baseUrl == baseUrl) { "Sign in again after changing host" }
        require(limit in 1..500) { "The access log reads 1 to 500 requests" }
        try {
            return AccessLog(full = true, entries = logEntries("workflow-log", limit, session))
        } catch (error: ApiFailure) {
            if (error.status != 403) throw error
        }
        return AccessLog(full = false,
            entries = logEntries("decision-log", limit, session),
            mine = logEntries("requests/mine", limit, session, own = true))
    }

    private fun logEntries(log: String, limit: Int, session: Session, own: Boolean = false): List<AccessLogEntry> {
        val items = request("/api/access/$log?limit=$limit", session.token).getJSONObject("data")
            .getJSONArray("entries")
        return (0 until items.length()).map { items.getJSONObject(it).toAccessLogEntry(own) }
    }

    /** Raise an access request under the signed-in identity. */
    override fun submit(session: Session, draft: AccessRequestDraft): AccessRequestStatus {
        require(session.baseUrl == baseUrl) { "Sign in again after changing host" }
        draft.problem()?.let { throw IllegalArgumentException(it) }
        val body = JSONObject().put("recordId", draft.recordId).put("action", draft.action)
            .put("purpose", draft.purpose).put("justification", draft.reason)
        return request("/api/access/request", session.token, body).getJSONObject("data").toRequestStatus()
    }

    /** Where one of the caller's requests stands. */
    override fun progress(session: Session, requestId: String): RequestProgress {
        require(session.baseUrl == baseUrl) { "Sign in again after changing host" }
        requireSafeId(requestId)
        val status = request("/api/access/request/$requestId", session.token).getJSONObject("data")
            .toRequestStatus()
        if (!status.decidedByAuditor) return RequestProgress(status)
        val detail = request("/api/access/request/$requestId/recommendation", session.token)
            .getJSONObject("data").toDecisionDetail()
        return RequestProgress(status, detail)
    }

    override fun ownRequests(session: Session, limit: Int): List<AccessRequestStatus> {
        require(session.baseUrl == baseUrl) { "Sign in again after changing host" }
        require(limit in 1..500) { "The request list reads 1 to 500 requests" }
        val items = request("/api/access/requests/mine?limit=$limit", session.token).getJSONObject("data")
            .getJSONArray("entries")
        return (0 until items.length()).map { items.getJSONObject(it).toRequestStatus() }
    }

    override fun pendingReviews(session: Session): List<AuditorReview> {
        requireAuditor(session)
        val items = request("/api/access/auditor/pending", session.token).getJSONArray("data")
        return (0 until items.length()).map { parseReview(items.getJSONObject(it)) }
    }

    override fun review(session: Session, requestId: String): AuditorReview {
        requireAuditor(session)
        requireSafeId(requestId)
        return parseReview(request("/api/access/auditor/$requestId", session.token).getJSONObject("data"))
    }

    override fun decide(session: Session, review: AuditorReview, decision: String, reason: String): DecisionReceipt {
        requireAuditor(session)
        requireSafeId(review.requestId)
        require(decision == "FORCE_ALLOW" || decision == "FORCE_DENY") { "Choose Allow or Deny" }
        require(review.blockingReason(session) == null) { review.blockingReason(session)!! }
        val note = reason.trim()
        require(note.length <= 2000) { "The auditor reason must be 2000 characters or fewer" }
        require(!review.requiresReason(decision) || note.isNotEmpty()) {
            "Record a reason when your decision differs from the LLM or no recommendation exists"
        }
        val body = JSONObject().put("decision", decision).put("reason", note)
        val data = request("/api/access/auditor/${review.requestId}/decision", session.token, body)
            .getJSONObject("data")
        val outcome = data.getJSONObject("accessOutcome")
        val outcomeValue = outcome.getString("outcome")
        val outcomeId = outcome.getString("outcomeId")
        val expected = if (decision == "FORCE_ALLOW") "GRANTED" else "DENIED"
        check(outcomeValue == expected && outcomeId.isNotEmpty()) { "Decision response had no matching outcome" }
        val authorizationId = data.optJSONObject("dynamicAuthorization")?.optString("authorizationId")
            ?.takeIf { it.isNotBlank() }
        // A 201 response follows a Fabric write. Read that request back before displaying a confirmed
        // grant; never repeat the POST after an uncertain response.
        val ledgerRequest = try {
            request("/api/access/request/${review.requestId}", session.token).getJSONObject("data")
        } catch (error: Exception) {
            if (error is ApiFailure && error.status == 401) throw error
            null
        }
        val confirmed = ledgerRequest?.optString("status") ==
            (if (decision == "FORCE_ALLOW") "granted" else "denied") &&
            ledgerRequest.optString("outcomeId") == outcomeId &&
            ledgerRequest.optString("recordId") == review.recordId
        return DecisionReceipt(decision, outcomeValue, outcomeId, authorizationId, confirmed)
    }

    private fun requireAuditor(session: Session) {
        require(session.baseUrl == baseUrl && session.canAudit) { "Sign in as an audit-organisation district head" }
    }

    private fun requireSafeId(requestId: String) {
        require(Regex("^[A-Za-z0-9._-]{1,128}$").matches(requestId)) { "Invalid request ID" }
    }

    private fun parseReview(data: JSONObject): AuditorReview {
        val request = data.getJSONObject("request")
        val verified = request.optJSONObject("verifiedRequest")
        val requester = verified?.optJSONObject("requester")
        val resource = verified?.optJSONObject("resource")
        val commitment = data.optJSONObject("commitment")
        val recommendation = data.optJSONObject("recommendation")
        val integrity = data.optJSONObject("integrity")
        val problems = integrity?.optJSONArray("problems")
        return AuditorReview(
            requestId = request.getString("requestId"),
            requesterUsername = request.getJSONObject("requester").getString("username"),
            requesterRole = requester.text("role"),
            requesterOrganization = requester.text("organization"),
            requesterClearance = requester.text("clearance"),
            credentialStatus = requester.text("credentialStatus"),
            assignedToCase = requester.flag("assignedToRequestedCase"),
            recordId = request.getString("recordId"), caseId = request.getString("caseId"),
            recordType = resource.text("recordType"), sensitivity = resource.text("sensitivityLevel"),
            jurisdiction = resource.text("jurisdiction"), owningAgency = resource.text("owningAgency"),
            sealed = resource.flag("sealed"), juvenile = resource.flag("juvenileFlag"),
            witness = resource.flag("witnessFlag"), victimProtected = resource.flag("victimProtectionFlag"),
            action = request.getString("action"), purpose = request.getString("purpose"),
            justification = data.text("justification"), status = request.getString("status"),
            recommendationState = data.optString("recommendationState", "not-generated"),
            // The decision is compared with the ledger commitment alone, never with an off-chain value that
            // was not committed.
            llmRecommendation = committedRecommendation(
                commitment.text("generationStatus"), commitment.text("recommendation")),
            llmReason = recommendation.text("reason"),
            generationStatus = commitment.text("generationStatus") ?: recommendation.text("generationStatus"),
            integrityStatus = integrity?.optString("status") ?: "unknown",
            integrityProblems = if (problems == null) emptyList() else
                (0 until problems.length()).map { problems.optString(it) },
        )
    }

    private fun request(path: String, token: String? = null, body: JSONObject? = null): JSONObject {
        val connection = URI(baseUrl + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            // A redirect must never forward a bearer token to another host.
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "DIAS-Mobile/0.1")
            connection.setRequestProperty("ngrok-skip-browser-warning", "true")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val result = StringBuilder()
                val buffer = CharArray(4096)
                var length = reader.read(buffer)
                while (length >= 0) {
                    result.append(buffer, 0, length)
                    if (result.length > 1_048_576) throw IOException("Host response is too large")
                    length = reader.read(buffer)
                }
                result.toString()
            } ?: ""
            val response = try { JSONObject(raw) } catch (_: Exception) {
                throw ApiFailure(status, "Host returned a non-JSON response. Check the URL and tunnel.")
            }
            if (status !in 200..299 || !response.optBoolean("success")) {
                throw ApiFailure(status, response.optString("error", "Host request failed"))
            }
            return response
        } finally { connection.disconnect() }
    }
}
