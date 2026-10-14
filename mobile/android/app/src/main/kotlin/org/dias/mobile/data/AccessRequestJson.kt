package org.dias.mobile.data

import org.dias.mobile.domain.AccessRequestStatus
import org.dias.mobile.domain.DecisionDetail
import org.json.JSONArray
import org.json.JSONObject

/** The ledger's request record, as the host returns it to the officer who made the request. */
internal fun JSONObject.toRequestStatus(): AccessRequestStatus {
    val check = optJSONObject("dynamicAuthorizationCheck")
    val automatic = text("processingPath") == "dynamic-authorization"
    return AccessRequestStatus(
        requestId = getString("requestId"), recordId = getString("recordId"),
        action = getString("action"), purpose = getString("purpose"), status = getString("status"),
        automatic = automatic,
        authorizationId = check.text("authorizationId").takeIf { automatic && check?.optBoolean("matched") == true },
        submittedAtUtc = text("submittedAtUtc"),
    )
}

/** What the host lets this officer read of the auditor's decision and the LLM's account. */
internal fun JSONObject.toDecisionDetail(): DecisionDetail {
    val decision = optJSONObject("decision")
    return DecisionDetail(
        decision = decision.text("decision"),
        auditorUsername = decision?.optJSONObject("auditor").text("username"),
        llmRecommendation = decision.text("llmRecommendation"),
        llmAgreement = decision.text("llmAgreement"),
        explanationVisible = optBoolean("explanationVisible", false),
        explanationAvailable = optBoolean("available", false),
        reason = text("reason"), reasonCode = text("reasonCode"),
        policyRefs = optJSONArray("policyRefs").strings(),
        missingEvidence = optJSONArray("missingEvidence").strings(),
        reviewFlags = optJSONArray("reviewFlags").strings(),
    )
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
