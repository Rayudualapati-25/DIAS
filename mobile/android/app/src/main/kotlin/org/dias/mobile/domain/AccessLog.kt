package org.dias.mobile.domain

/** How many requests one load reads from the ledger, and how many one screen page shows. */
const val ACCESS_LOG_LIMIT = 100
const val ACCESS_LOG_PAGE = 10

/** One request of the ledger's access log, as the signed-in identity may read it. */
data class AccessLogEntry(
    val requestId: String? = null,
    val recordId: String? = null,
    val action: String? = null,
    val purpose: String? = null,
    val status: String? = null,
    val requesterUsername: String? = null,
    val requesterRole: String? = null,
    val requesterOrganization: String? = null,
    val submittedAtUtc: String? = null,
    val decidedAtUtc: String? = null,
    val outcome: String? = null,
    val basis: String? = null,
    val auditorUsername: String? = null,
    val decision: String? = null,
    val llmRecommendation: String? = null,
    val llmAgreement: String? = null,
    val recommendationWithheld: Boolean = false,
    val authorizationId: String? = null,
    val createdAuthorizationId: String? = null,
    val redacted: Boolean = false,
) {
    /** When the request was settled, or raised while it still waits. */
    val time: String? get() = decidedAtUtc ?: submittedAtUtc
}

/**
 * What one sign-in read of the log. `full` is the log every officer reads: every request with names, case
 * files and requests still waiting.
 */
data class AccessLog(
    val full: Boolean,
    val entries: List<AccessLogEntry>,
    val mine: List<AccessLogEntry> = emptyList(),
)

/** A cell with a main line and, when there is one, a quieter second line. */
data class LogCell(val label: String, val detail: String? = null)

/** Who requested, what, what the LLM recommended, what the auditor decided, and the outcome. */
data class AccessLogRow(
    val requestId: String?,
    val time: String?,
    val who: LogCell,
    val what: LogCell,
    val llm: LogCell,
    val decision: LogCell,
    val outcome: LogCell,
)

data class LogPage(val rows: List<AccessLogRow>, val offset: Int, val total: Int) {
    val hasNewer: Boolean get() = offset > 0
    val hasOlder: Boolean get() = offset + rows.size < total
}

interface RemoteAccessLog {
    fun accessLog(session: Session, limit: Int = ACCESS_LOG_LIMIT): AccessLog
}

/** A read returns at most `limit` requests: a full list may have left older ones on the ledger. */
fun List<AccessLogEntry>.isCutOff(limit: Int = ACCESS_LOG_LIMIT): Boolean = size >= limit

/** "28 requests", or "the newest 100 requests" when the read was cut off at its limit. */
fun countedLog(count: Int, one: String, many: String, limit: Int = ACCESS_LOG_LIMIT): String =
    if (count >= limit) "the newest $count $many" else counted(count, one, many)

private const val AWAITING_AUDITOR = "awaiting-auditor"
private const val DYNAMIC_AUTHORIZATION = "DYNAMIC_AUTHORIZATION"
private val AUDITOR_DECISIONS = setOf("FORCE_ALLOW", "FORCE_DENY")

private fun joined(vararg parts: String?): String? =
    parts.filterNot { it.isNullOrBlank() }.joinToString(" · ").ifEmpty { null }

/**
 * What the LLM recommended for this request, or why there is nothing to show. Advice marked as withheld is
 * never shown, whatever value came with it.
 */
private fun AccessLogEntry.llmCell(): LogCell = when {
    recommendationWithheld && status == AWAITING_AUDITOR ->
        LogCell("Withheld until decision", "shown once the auditor has decided")
    recommendationWithheld -> LogCell("Not recorded", "the request ended without a decision")
    llmRecommendation == "ALLOW" || llmRecommendation == "DENY" -> LogCell(llmRecommendation)
    llmRecommendation == "UNAVAILABLE" -> LogCell("No recommendation", "the model produced none")
    basis == DYNAMIC_AUTHORIZATION -> LogCell("Not asked", "a reusable authorization matched")
    status == AWAITING_AUDITOR -> LogCell("Being prepared", "awaiting a committed recommendation")
    else -> LogCell("Not recorded", "the request ended without a decision")
}

/** How the auditor's decision stands against the LLM recommendation. */
private fun AccessLogEntry.agreementText(): String = when (llmAgreement) {
    "AGREED" -> "agreed with the LLM's $llmRecommendation"
    "NOT_AGREED" -> "against the LLM's $llmRecommendation"
    else -> "decided without an LLM recommendation"
}

/** What the auditor decided, always stated together with the LLM recommendation. */
private fun AccessLogEntry.decisionCell(): LogCell = when {
    decision in AUDITOR_DECISIONS -> LogCell(decision!!.replace('_', ' '),
        joined(agreementText(), auditorUsername?.takeUnless { redacted }?.let { "by $it" }))
    basis == DYNAMIC_AUTHORIZATION -> LogCell("Not needed",
        authorizationId?.takeUnless { redacted }?.let { "granted by reusable authorization $it" }
            ?: "granted by a reusable authorization")
    outcome == "CANCELLED" -> LogCell("No decision", "cancelled by the requester")
    outcome == "EXPIRED" -> LogCell("No decision", "the request expired")
    status == AWAITING_AUDITOR -> LogCell("Waiting for auditor", "no final decision committed")
    else -> LogCell("No decision")
}

/**
 * One row of the access log. A reduced entry is shown without a name, a case file or a request number,
 * whatever the host sent with it.
 */
fun AccessLogEntry.toRow(): AccessLogRow {
    val operation = joined(action, purpose)
    return AccessLogRow(
        requestId = requestId.takeUnless { redacted },
        time = time,
        who = if (redacted) LogCell("Name hidden", requesterOrganization)
            else LogCell(requesterUsername ?: "—", joined(requesterRole, requesterOrganization)),
        what = if (redacted) LogCell("Case file hidden", operation) else LogCell(recordId ?: "—", operation),
        llm = llmCell(),
        decision = decisionCell(),
        outcome = LogCell(outcome ?: if (status == AWAITING_AUDITOR) "Waiting" else "—",
            createdAuthorizationId?.takeUnless { redacted }?.let { "created authorization $it" }),
    )
}

/**
 * The caller's own request as a log entry. The ledger's request record names its status, review status and
 * processing path; the log speaks of the outcome, the decision and its basis.
 */
fun AccessLogEntry.asOwnRequest(reviewStatus: String?, processingPath: String?): AccessLogEntry {
    val waiting = status == AWAITING_AUDITOR
    return copy(
        decision = reviewStatus?.takeIf { it in AUDITOR_DECISIONS },
        outcome = when (status) {
            "granted" -> "GRANTED"
            "denied" -> "DENIED"
            "expired" -> "EXPIRED"
            "cancelled" -> "CANCELLED"
            else -> null
        },
        basis = if (processingPath == "dynamic-authorization") DYNAMIC_AUTHORIZATION else null,
        llmRecommendation = llmRecommendation.takeUnless { waiting },
        llmAgreement = llmAgreement.takeUnless { waiting },
        recommendationWithheld = waiting,
    )
}

/** One screen page of the log, newest first. An offset off the list is brought back onto it. */
fun List<AccessLogEntry>.logPage(offset: Int, size: Int = ACCESS_LOG_PAGE): LogPage {
    require(size > 0) { "page size must be positive" }
    val lastStart = if (isEmpty()) 0 else (this.size - 1) / size * size
    val start = offset.coerceIn(0, lastStart)
    val newestFirst = sortedWith(compareByDescending<AccessLogEntry> { it.time ?: "" }
        .thenByDescending { it.requestId ?: "" })
    return LogPage(newestFirst.drop(start).take(size).map { it.toRow() }, start, this.size)
}
