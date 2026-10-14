package org.dias.mobile.domain

import org.junit.Assert.*
import org.junit.Test

class AuditorReviewRulesTest {
    private val auditor = Session("https://host", "sp.north", "audit", "memory-only", "sp")
    private fun review(recommendation: String? = "DENY") = AuditorReview(
        requestId = "REQ-1", requesterUsername = "insp.sharma", requesterRole = "inspector",
        requesterOrganization = "police", requesterClearance = "confidential",
        credentialStatus = "active", assignedToCase = true,
        recordId = "REC-FIR-001", caseId = "CASE-2026-001", recordType = "FIR",
        sensitivity = "confidential", jurisdiction = "district-north", owningAgency = "police",
        sealed = false, juvenile = false, witness = false, victimProtected = false,
        action = "view", purpose = "investigation", justification = "Assigned investigation",
        status = "awaiting-auditor", recommendationState = "committed",
        llmRecommendation = recommendation, llmReason = "Policy explanation", generationStatus = "OK",
        integrityStatus = "verified", integrityProblems = emptyList())

    @Test fun onlyAuditDistrictHeadsCanUseTheMobileReview() {
        assertTrue(auditor.canAudit)
        assertTrue(auditor.copy(role = "district-judge").canAudit)
        assertFalse(auditor.copy(org = "police").canAudit)
        assertFalse(auditor.copy(role = "inspector").canAudit)
        assertNull(review().blockingReason(auditor))
        assertNotNull(review().blockingReason(auditor.copy(username = "insp.sharma")))
    }

    @Test fun pendingOrUnverifiedAdviceCannotBeDecided() {
        assertNotNull(review().copy(recommendationState = "pending").blockingReason(auditor))
        assertNotNull(review().copy(recommendationState = "signed").blockingReason(auditor))
        assertNotNull(review().copy(integrityStatus = "mismatch").blockingReason(auditor))
        assertNotNull(review().copy(status = "granted").blockingReason(auditor))
        assertNull(review(null).copy(integrityStatus = "no-commitment").blockingReason(auditor))
    }

    @Test fun onlyTheCommittedSuccessfulGenerationCountsAsTheRecommendation() {
        assertEquals("ALLOW", committedRecommendation("OK", "ALLOW"))
        assertEquals("DENY", committedRecommendation("OK", "DENY"))
        // A failed generation is committed with its status; the ledger records UNAVAILABLE.
        assertNull(committedRecommendation("INVALID_OUTPUT", "ALLOW"))
        // No commitment on the ledger: an off-chain value alone is never the recommendation.
        assertNull(committedRecommendation(null, "ALLOW"))
        assertNull(committedRecommendation("OK", null))
        assertNull(committedRecommendation("OK", "MAYBE"))
        val uncommitted = review(committedRecommendation(null, "DENY")).copy(integrityStatus = "no-commitment")
        assertTrue(uncommitted.requiresReason("FORCE_DENY"))
        assertFalse(uncommitted.createsAuthorization("FORCE_ALLOW"))
    }

    @Test fun onlyARefusalThatWroteNothingLeavesTheReviewOpenForAnotherAttempt() {
        // The host rejected the input or the caller: nothing reached the ledger.
        for (status in listOf(400, 403, 422)) assertTrue(reviewStaysOpenAfter(status))
        // A conflict, a server error or a reply that cannot be read may follow a committed decision.
        for (status in listOf(200, 201, 409, 500, 502, 503)) assertFalse(reviewStaysOpenAfter(status))
        // No HTTP status at all: a timeout or a lost connection.
        assertFalse(reviewStaysOpenAfter(null))
    }

    @Test fun anAllowOverrideRequiresAReasonAndCreatesOnlyTheScopedAuthorization() {
        val deniedByModel = review("DENY")
        assertTrue(deniedByModel.requiresReason("FORCE_ALLOW"))
        assertTrue(deniedByModel.createsAuthorization("FORCE_ALLOW"))
        assertFalse(deniedByModel.requiresReason("FORCE_DENY"))
        assertFalse(deniedByModel.createsAuthorization("FORCE_DENY"))
        val allowedByModel = review("ALLOW")
        assertFalse(allowedByModel.requiresReason("FORCE_ALLOW"))
        assertFalse(allowedByModel.createsAuthorization("FORCE_ALLOW"))
        assertTrue(allowedByModel.requiresReason("FORCE_DENY"))
        assertTrue(review(null).requiresReason("FORCE_ALLOW"))
    }
}
