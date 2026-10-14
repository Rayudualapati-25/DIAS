package org.dias.mobile.domain

import org.junit.Assert.*
import org.junit.Test

class AccessRequestRulesTest {
    private val draft = AccessRequestDraft("REC-FIR-001", "view", "investigation",
        "  I am the investigating officer on this case.  ")
    private val waiting = AccessRequestStatus("REQ-1", "REC-FIR-001", "view", "investigation", "awaiting-auditor")
    private val denial = DecisionDetail(decision = "FORCE_DENY", auditorUsername = "sp.north",
        llmRecommendation = "DENY", llmAgreement = "AGREED", explanationVisible = true,
        explanationAvailable = true, reason = "The role has no export permission on a FIR.",
        reasonCode = "RBAC_NO_PERMISSION", policyRefs = listOf("GP-RBAC:C2@v1"),
        missingEvidence = emptyList(), reviewFlags = listOf("check-assignment"))

    @Test fun aCompleteDraftIsSentWithItsReasonTrimmed() {
        assertNull(draft.problem())
        assertEquals("I am the investigating officer on this case.", draft.reason)
    }

    @Test fun anIncompleteDraftSaysWhatIsMissing() {
        assertEquals("Enter a case-file identifier, for example REC-FIR-001.", draft.copy(recordId = " ").problem())
        assertEquals("Enter a case-file identifier, for example REC-FIR-001.",
            draft.copy(recordId = "REC FIR/001").problem())
        assertEquals("Choose an operation.", draft.copy(action = "delete").problem())
        assertEquals("Choose a purpose.", draft.copy(purpose = "curiosity").problem())
        assertEquals("Say why you need it, in at least 3 characters.", draft.copy(justification = "  ab ").problem())
        assertEquals("The reason must be 2000 characters or fewer.",
            draft.copy(justification = "x".repeat(2001)).problem())
        assertNull(draft.copy(justification = "x".repeat(2000)).problem())
    }

    @Test fun everyOperationAndPurposeOfThePolicyHasALabel() {
        assertEquals(listOf("View", "Export", "Annotate"), REQUEST_ACTIONS.map(::actionLabel))
        assertEquals(6, REQUEST_PURPOSES.size)
        assertEquals("Defence preparation", purposeLabel("defense-preparation"))
        assertTrue(REQUEST_PURPOSES.none { purposeLabel(it) == it })
    }

    @Test fun aWaitingRequestShowsNothingFromTheLlm() {
        val progress = RequestProgress(waiting)
        assertEquals("Request REQ-1 is waiting for an auditor.", progress.message())
        assertEquals(listOf(
            "Request: REQ-1",
            "Case file: REC-FIR-001 · view · investigation",
            "Status: Waiting for the auditor",
            "Nothing from the LLM is shown to you before the auditor decides."), progress.lines())
        // Even a detail a faulty host sent is not shown while the request waits.
        assertEquals(progress.lines(), RequestProgress(waiting, denial).lines())
        assertFalse(waiting.decidedByAuditor)
    }

    @Test fun aDenialShowsTheDecisionAndTheLlmExplanation() {
        val denied = waiting.copy(status = "denied")
        assertTrue(denied.decidedByAuditor)
        val progress = RequestProgress(denied, denial)
        assertEquals("Request REQ-1: DENIED by sp.north.", progress.message())
        assertEquals(listOf(
            "Request: REQ-1",
            "Case file: REC-FIR-001 · view · investigation",
            "Outcome: DENIED",
            "Auditor decision: FORCE DENY by sp.north",
            "LLM recommendation: DENY",
            "Decision against the LLM: agreed",
            "LLM explanation (advisory): The role has no export permission on a FIR.",
            "Reason code: RBAC_NO_PERMISSION",
            "Policy clauses cited: GP-RBAC:C2@v1",
            "What the LLM said was missing: nothing",
            "Review flags: check-assignment"), progress.lines())
    }

    @Test fun aDenialWithoutAnAccountSaysWhy() {
        val denied = waiting.copy(status = "denied")
        val missing = denial.copy(explanationAvailable = false, reason = null)
        assertTrue(RequestProgress(denied, missing).lines()
            .contains("The LLM explanation is not available on this host."))
        val none = missing.copy(llmRecommendation = "UNAVAILABLE", llmAgreement = "NO_RECOMMENDATION")
        val lines = RequestProgress(denied, none).lines()
        assertTrue(lines.containsAll(listOf("LLM recommendation: none was available",
            "Decision against the LLM: decided without a recommendation",
            "There was no LLM recommendation; the auditor decided without one.")))
    }

    @Test fun aGrantNamesTheRecommendationButNeverItsExplanation() {
        val granted = waiting.copy(status = "granted")
        // The host applies this rule; the phone applies it again to whatever arrives.
        val detail = denial.copy(decision = "FORCE_ALLOW", llmRecommendation = "DENY", llmAgreement = "NOT_AGREED",
            explanationVisible = false, reason = "LEAK", reasonCode = "LEAK", policyRefs = listOf("LEAK"),
            missingEvidence = listOf("LEAK"), reviewFlags = listOf("LEAK"))
        val progress = RequestProgress(granted, detail)
        assertEquals("Request REQ-1: GRANTED by sp.north.", progress.message())
        assertEquals(listOf(
            "Request: REQ-1",
            "Case file: REC-FIR-001 · view · investigation",
            "Outcome: GRANTED",
            "Auditor decision: FORCE ALLOW by sp.north",
            "LLM recommendation: DENY",
            "Decision against the LLM: not agreed"), progress.lines())
        assertTrue(progress.lines().none { it.contains("LEAK") })
    }

    @Test fun aReusableAuthorizationGrantsWithoutLlmOrAuditor() {
        val automatic = waiting.copy(status = "granted", automatic = true, authorizationId = "AUTH-7")
        assertFalse(automatic.decidedByAuditor)
        val progress = RequestProgress(automatic)
        assertEquals("Request REQ-1: GRANTED by reusable authorization AUTH-7.", progress.message())
        assertEquals(listOf(
            "Request: REQ-1",
            "Case file: REC-FIR-001 · view · investigation",
            "Outcome: GRANTED",
            "Granted by reusable authorization AUTH-7",
            "Neither the LLM nor an auditor was asked."), progress.lines())
        assertEquals("Request REQ-1 was granted at once by reusable authorization AUTH-7. " +
            "No auditor review was needed.", automatic.submittedMessage())
        assertEquals("Request REQ-1 is on the ledger. An auditor will make the final decision.",
            waiting.submittedMessage())
    }

    @Test fun aRequestThatEndedWithoutADecisionSaysSo() {
        assertEquals("Request REQ-1: cancelled.", RequestProgress(waiting.copy(status = "cancelled")).message())
        assertTrue(RequestProgress(waiting.copy(status = "cancelled")).lines().contains("Outcome: CANCELLED"))
        assertEquals("Request REQ-1: expired.", RequestProgress(waiting.copy(status = "expired")).message())
        // A decided request whose detail could not be read still states its outcome.
        assertEquals("Request REQ-1: DENIED by an auditor.", RequestProgress(waiting.copy(status = "denied")).message())
    }

    @Test fun onlyADefiniteRefusalMeansNothingWasRecorded() {
        assertTrue(listOf(400, 403, 422).all(::refusedWithoutWriting))
        // A timeout or lost reply (no status), a conflict or a server error may follow a commit.
        assertTrue(listOf(null, 409, 500, 502, 504, 200).none(::refusedWithoutWriting))
    }
}
