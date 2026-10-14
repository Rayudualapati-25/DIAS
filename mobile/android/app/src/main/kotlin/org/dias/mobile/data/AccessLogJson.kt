package org.dias.mobile.data

import org.dias.mobile.domain.AccessLogEntry
import org.dias.mobile.domain.asOwnRequest
import org.json.JSONObject

/** A field as text, or null when it is absent, JSON null or blank. */
internal fun JSONObject?.text(key: String): String? = if (this == null || isNull(key)) null
    else optString(key).takeIf { it.isNotBlank() }

/** A field as a flag, or null when it is absent or JSON null. */
internal fun JSONObject?.flag(key: String): Boolean? = if (this?.has(key) == true && !isNull(key))
    optBoolean(key) else null

/**
 * One entry of the ledger's access log: the reviewer's workflow log, the reduced decision log, or (`own`)
 * the caller's request record from `requests/mine`.
 */
internal fun JSONObject.toAccessLogEntry(own: Boolean = false): AccessLogEntry {
    val requester = optJSONObject("requester")
    val matched = optJSONObject("dynamicAuthorizationCheck")?.takeIf { it.optBoolean("matched") }
    // Advice marked as withheld is dropped here, so no later code can show it.
    val withheld = optBoolean("recommendationWithheld", false)
    val entry = AccessLogEntry(
        requestId = text("requestId"), recordId = text("recordId"),
        action = text("action"), purpose = text("purpose"), status = text("status"),
        requesterUsername = requester.text("username"), requesterRole = requester.text("role"),
        requesterOrganization = requester.text("organization"),
        submittedAtUtc = text("submittedAtUtc"), decidedAtUtc = text("decidedAtUtc"),
        outcome = text("outcome"), basis = text("basis"),
        auditorUsername = optJSONObject("auditor").text("username"),
        decision = text("decision"), llmRecommendation = text("llmRecommendation").takeUnless { withheld },
        llmAgreement = text("llmAgreement").takeUnless { withheld },
        recommendationWithheld = withheld,
        authorizationId = text("authorizationId") ?: matched.text("authorizationId"),
        createdAuthorizationId = text("createdAuthorizationId"),
        redacted = optBoolean("redacted", false),
    )
    return if (own) entry.asOwnRequest(text("auditorReviewStatus"), text("processingPath")) else entry
}
