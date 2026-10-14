package org.dias.mobile.domain

import java.security.MessageDigest

data class CaseSummary(
    val caseId: String,
    val owningAgency: String,
    val jurisdiction: String,
    val status: String,
)

private val DISTRICT_HEAD_ROLES = setOf(
    "sp", "commissioner", "chief-forensic-officer", "director-of-prosecution", "district-judge")

/**
 * What an auditor decision is compared with: the value committed on the ledger before review, and only when
 * its generation succeeded.
 */
fun committedRecommendation(generationStatus: String?, recommendation: String?): String? =
    recommendation?.takeIf { generationStatus == "OK" && (it == "ALLOW" || it == "DENY") }

/**
 * After a decision could not be confirmed: may the same review stay open for another attempt? Only after a
 * refusal that certainly wrote nothing, because the host rejected the input or the caller.
 */
fun reviewStaysOpenAfter(httpStatus: Int?): Boolean = refusedWithoutWriting(httpStatus)

/** "1 request", "2 requests". */
fun counted(count: Int, one: String, many: String): String = "$count ${if (count == 1) one else many}"

data class CasePage(val items: List<CaseSummary>, val nextCursor: String?)
data class SyncState(val cursor: String?, val complete: Boolean, val fetchedAt: Long)
data class Session(
    val baseUrl: String, val username: String, val org: String, val token: String,
    val role: String = "",
) {
    val canAudit: Boolean get() = org == "audit" && role in DISTRICT_HEAD_ROLES
    // No bearer token or certificate is persisted in the cache scope.
    val scope: String get() = MessageDigest.getInstance("SHA-256")
        .digest("$baseUrl\n$org\n$username".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

data class AuditorReview(
    val requestId: String,
    val requesterUsername: String,
    val requesterRole: String?,
    val requesterOrganization: String?,
    val requesterClearance: String?,
    val credentialStatus: String?,
    val assignedToCase: Boolean?,
    val recordId: String,
    val caseId: String,
    val recordType: String?,
    val sensitivity: String?,
    val jurisdiction: String?,
    val owningAgency: String?,
    val sealed: Boolean?,
    val juvenile: Boolean?,
    val witness: Boolean?,
    val victimProtected: Boolean?,
    val action: String,
    val purpose: String,
    val justification: String?,
    val status: String,
    val recommendationState: String,
    val llmRecommendation: String?,
    val llmReason: String?,
    val generationStatus: String?,
    val integrityStatus: String,
    val integrityProblems: List<String>,
) {
    fun blockingReason(session: Session): String? = when {
        !session.canAudit -> "Only an audit-organisation district head may decide."
        requesterUsername == session.username -> "A requester cannot decide their own request."
        status != "awaiting-auditor" -> "This request is no longer awaiting an auditor."
        recommendationState == "pending" || recommendationState == "signed" ->
            "The LLM recommendation is still being prepared or committed. Refresh before deciding."
        integrityStatus != "verified" && integrityStatus != "no-commitment" ->
            "The recommendation cannot be verified against its ledger commitment."
        else -> null
    }

    fun requiresReason(decision: String): Boolean = when (llmRecommendation) {
        "ALLOW" -> decision != "FORCE_ALLOW"
        "DENY" -> decision != "FORCE_DENY"
        else -> true
    }

    fun createsAuthorization(decision: String): Boolean =
        decision == "FORCE_ALLOW" && llmRecommendation == "DENY"
}

data class DecisionReceipt(
    val decision: String,
    val outcome: String,
    val outcomeId: String,
    val authorizationId: String?,
    val confirmedFromLedger: Boolean,
)

interface RemoteAuditor {
    fun pendingReviews(session: Session): List<AuditorReview>
    fun review(session: Session, requestId: String): AuditorReview
    fun decide(session: Session, review: AuditorReview, decision: String, reason: String): DecisionReceipt
}

interface RemoteCases {
    fun health()
    fun login(username: String): Session
    fun cases(session: Session, cursor: String?, limit: Int): CasePage
}

interface LocalCases {
    fun read(scope: String, limit: Int, offset: Int): List<CaseSummary>
    fun count(scope: String): Int
    fun state(scope: String): SyncState?
    fun save(scope: String, page: CasePage, replace: Boolean)
    fun clear()
}

interface CasesRepository {
    fun cached(session: Session, limit: Int, offset: Int): List<CaseSummary>
    fun count(session: Session): Int
    fun state(session: Session): SyncState?
    fun fetchBatch(session: Session, restart: Boolean = false): Int
    fun clear()
}
