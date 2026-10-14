package org.dias.mobile.domain

/** The operations and purposes of the governance policy, as the contract names them. */
val REQUEST_ACTIONS = listOf("view", "export", "annotate")
val REQUEST_PURPOSES = listOf("investigation", "forensic-analysis", "prosecution", "judicial-proceeding",
    "audit-review", "defense-preparation")

/** How many of the officer's own requests the request card lists. */
const val OWN_REQUESTS_SHOWN = 10
const val JUSTIFICATION_MAX = 2000
private const val JUSTIFICATION_MIN = 3

private val ACTION_LABELS = mapOf("view" to "View", "export" to "Export", "annotate" to "Annotate")
private val PURPOSE_LABELS = mapOf(
    "investigation" to "Investigation", "forensic-analysis" to "Forensic analysis",
    "prosecution" to "Prosecution", "judicial-proceeding" to "Judicial proceeding",
    "audit-review" to "Audit review", "defense-preparation" to "Defence preparation")
private val SAFE_ID = Regex("^[A-Za-z0-9._-]{1,128}$")

fun actionLabel(value: String): String = ACTION_LABELS[value] ?: value
fun purposeLabel(value: String): String = PURPOSE_LABELS[value] ?: value

/**
 * After a write could not be confirmed: did the host certainly record nothing? Only after a refusal of the
 * input or of the caller.
 */
fun refusedWithoutWriting(httpStatus: Int?): Boolean = httpStatus in DEFINITE_REFUSALS

private val DEFINITE_REFUSALS = setOf(400, 403, 422)

/** What an officer asks for. The reason is free text; the ledger keeps only its digest. */
data class AccessRequestDraft(
    val recordId: String,
    val action: String,
    val purpose: String,
    val justification: String,
) {
    val reason: String get() = justification.trim()

    /** Why this draft is not sent, or null. The host and the contract check it again. */
    fun problem(): String? = when {
        !SAFE_ID.matches(recordId) -> "Enter a case-file identifier, for example REC-FIR-001."
        action !in REQUEST_ACTIONS -> "Choose an operation."
        purpose !in REQUEST_PURPOSES -> "Choose a purpose."
        reason.length < JUSTIFICATION_MIN -> "Say why you need it, in at least $JUSTIFICATION_MIN characters."
        reason.length > JUSTIFICATION_MAX -> "The reason must be $JUSTIFICATION_MAX characters or fewer."
        else -> null
    }
}

/** One request as the ledger holds it, for the officer who made it. */
data class AccessRequestStatus(
    val requestId: String,
    val recordId: String,
    val action: String,
    val purpose: String,
    val status: String,
    /** Granted by an exact reusable authorization: no LLM and no auditor. */
    val automatic: Boolean = false,
    val authorizationId: String? = null,
    val submittedAtUtc: String? = null,
) {
    val waiting: Boolean get() = status == AWAITING
    val decidedByAuditor: Boolean get() = !automatic && (status == "granted" || status == "denied")

    /** What the screen says once the ledger has recorded this request. */
    fun submittedMessage(): String = if (automatic && status == "granted")
        "Request $requestId was granted at once by ${authorizationText()}. No auditor review was needed."
    else "Request $requestId is on the ledger. An auditor will make the final decision."

    internal fun authorizationText(): String =
        authorizationId?.let { "reusable authorization $it" } ?: "a reusable authorization"
}

/** What the officer who made a request may read of the auditor's decision and of the LLM's account. */
data class DecisionDetail(
    val decision: String? = null,
    val auditorUsername: String? = null,
    val llmRecommendation: String? = null,
    val llmAgreement: String? = null,
    val explanationVisible: Boolean = false,
    val explanationAvailable: Boolean = false,
    val reason: String? = null,
    val reasonCode: String? = null,
    val policyRefs: List<String> = emptyList(),
    val missingEvidence: List<String> = emptyList(),
    val reviewFlags: List<String> = emptyList(),
)

/** A request and, once an auditor has decided it, what its officer may read of that decision. */
data class RequestProgress(val request: AccessRequestStatus, val detail: DecisionDetail? = null) {
    private val decided: DecisionDetail? get() = detail?.takeIf { request.decidedByAuditor && it.decision != null }

    /** One line for the screen's message, always naming the request. */
    fun message(): String = with(request) {
        when {
            waiting -> "Request $requestId is waiting for an auditor."
            automatic && status == "granted" -> "Request $requestId: GRANTED by ${authorizationText()}."
            decidedByAuditor ->
                "Request $requestId: ${status.uppercase()} by ${decided?.auditorUsername ?: "an auditor"}."
            else -> "Request $requestId: $status."
        }
    }

    /** Everything the request card shows for this request, top to bottom. */
    fun lines(): List<String> {
        val head = listOf("Request: ${request.requestId}",
            "Case file: ${request.recordId} · ${request.action} · ${request.purpose}")
        return head + when {
            request.waiting -> listOf("Status: Waiting for the auditor",
                "Nothing from the LLM is shown to you before the auditor decides.")
            request.automatic && request.status == "granted" -> listOf("Outcome: GRANTED",
                "Granted by ${request.authorizationText()}", "Neither the LLM nor an auditor was asked.")
            else -> listOf("Outcome: ${request.status.uppercase()}") + (decided?.let(::decisionLines) ?: emptyList())
        }
    }

    private fun decisionLines(detail: DecisionDetail): List<String> {
        val recommended = detail.llmRecommendation?.takeIf { it == "ALLOW" || it == "DENY" }
        val lines = mutableListOf(
            "Auditor decision: ${detail.decision!!.replace('_', ' ')} by ${detail.auditorUsername ?: "an auditor"}",
            "LLM recommendation: ${recommended ?: "none was available"}",
            "Decision against the LLM: " + when (detail.llmAgreement) {
                "AGREED" -> "agreed"
                "NOT_AGREED" -> "not agreed"
                else -> "decided without a recommendation"
            })
        // The account is the officer's to read only after a denial; the host says when.
        if (!detail.explanationVisible || detail.decision != "FORCE_DENY") return lines
        if (!detail.explanationAvailable) {
            return lines + if (recommended == null) "There was no LLM recommendation; the auditor decided without one."
                else "The LLM explanation is not available on this host."
        }
        return lines + listOf(
            "LLM explanation (advisory): ${detail.reason ?: "—"}",
            "Reason code: ${detail.reasonCode ?: "—"}",
            "Policy clauses cited: ${listed(detail.policyRefs, "—")}",
            "What the LLM said was missing: ${listed(detail.missingEvidence, "nothing")}",
            "Review flags: ${listed(detail.reviewFlags, "none")}")
    }

    private fun listed(values: List<String>, none: String): String =
        values.filter { it.isNotBlank() }.joinToString(", ").ifEmpty { none }
}

interface RemoteRequests {
    fun submit(session: Session, draft: AccessRequestDraft): AccessRequestStatus
    fun progress(session: Session, requestId: String): RequestProgress
    fun ownRequests(session: Session, limit: Int = OWN_REQUESTS_SHOWN): List<AccessRequestStatus>
}

private const val AWAITING = "awaiting-auditor"
