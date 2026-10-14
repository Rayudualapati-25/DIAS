package org.dias.mobile.domain

import org.junit.Assert.*
import org.junit.Test

class AccessLogRulesTest {
    private val decided = AccessLogEntry(
        requestId = "REQ-1", recordId = "REC-FIR-001", action = "view", purpose = "investigation",
        status = "granted", requesterUsername = "insp.sharma", requesterRole = "inspector",
        requesterOrganization = "police", submittedAtUtc = "2026-10-12T07:18:04.240Z",
        decidedAtUtc = "2026-10-12T07:23:41.063Z", outcome = "GRANTED", basis = "AUDITOR_DECISION",
        auditorUsername = "sp.north", decision = "FORCE_ALLOW", llmRecommendation = "ALLOW",
        llmAgreement = "AGREED")
    private val waiting = AccessLogEntry(
        requestId = "REQ-2", recordId = "REC-FIR-001", action = "export", purpose = "prosecution",
        status = "awaiting-auditor", requesterUsername = "const.verma", requesterRole = "constable",
        requesterOrganization = "police", submittedAtUtc = "2026-10-12T08:00:00.000Z")

    @Test fun aDecidedRequestStatesTheDecisionTogetherWithTheLlmRecommendation() {
        val row = decided.toRow()
        assertEquals("REQ-1", row.requestId)
        assertEquals("2026-10-12T07:23:41.063Z", row.time)
        assertEquals(LogCell("insp.sharma", "inspector · police"), row.who)
        assertEquals(LogCell("REC-FIR-001", "view · investigation"), row.what)
        assertEquals(LogCell("ALLOW"), row.llm)
        assertEquals(LogCell("FORCE ALLOW", "agreed with the LLM's ALLOW · by sp.north"), row.decision)
        assertEquals(LogCell("GRANTED"), row.outcome)
    }

    @Test fun anOverrideNamesTheRecommendationItWentAgainstAndTheAuthorizationItCreated() {
        val row = decided.copy(llmRecommendation = "DENY", llmAgreement = "NOT_AGREED",
            createdAuthorizationId = "AUTH-9").toRow()
        assertEquals(LogCell("DENY"), row.llm)
        assertEquals(LogCell("FORCE ALLOW", "against the LLM's DENY · by sp.north"), row.decision)
        assertEquals(LogCell("GRANTED", "created authorization AUTH-9"), row.outcome)
    }

    @Test fun aMissingRecommendationIsStatedNotLeftBlank() {
        val row = decided.copy(decision = "FORCE_DENY", outcome = "DENIED", status = "denied",
            llmRecommendation = "UNAVAILABLE", llmAgreement = "NO_RECOMMENDATION").toRow()
        assertEquals(LogCell("No recommendation", "the model produced none"), row.llm)
        assertEquals(LogCell("FORCE DENY", "decided without an LLM recommendation · by sp.north"), row.decision)
        assertEquals(LogCell("DENIED"), row.outcome)
    }

    @Test fun aReusedAuthorizationShowsThatNeitherTheLlmNorAnAuditorWasAsked() {
        val reused = decided.copy(basis = "DYNAMIC_AUTHORIZATION", auditorUsername = null, decision = null,
            llmRecommendation = null, llmAgreement = null, authorizationId = "AUTH-7")
        assertEquals(LogCell("Not asked", "a reusable authorization matched"), reused.toRow().llm)
        assertEquals(LogCell("Not needed", "granted by reusable authorization AUTH-7"), reused.toRow().decision)
        assertEquals(LogCell("Not needed", "granted by a reusable authorization"),
            reused.copy(authorizationId = null).toRow().decision)
    }

    @Test fun requestsThatEndedWithoutADecisionSayWhy() {
        val ended = decided.copy(auditorUsername = null, decision = null, llmRecommendation = null,
            llmAgreement = null, basis = "REQUESTER_CANCELLED", outcome = "CANCELLED", status = "cancelled")
        assertEquals(LogCell("Not recorded", "the request ended without a decision"), ended.toRow().llm)
        assertEquals(LogCell("No decision", "cancelled by the requester"), ended.toRow().decision)
        assertEquals(LogCell("CANCELLED"), ended.toRow().outcome)
        val expired = ended.copy(basis = "REVIEW_EXPIRED", outcome = "EXPIRED", status = "expired")
        assertEquals(LogCell("No decision", "the request expired"), expired.toRow().decision)
    }

    @Test fun aWaitingRequestShowsPreparedWithheldOrCommittedAdvice() {
        val row = waiting.toRow()
        assertEquals("2026-10-12T08:00:00.000Z", row.time)
        assertEquals(LogCell("Being prepared", "awaiting a committed recommendation"), row.llm)
        assertEquals(LogCell("Waiting for auditor", "no final decision committed"), row.decision)
        assertEquals(LogCell("Waiting"), row.outcome)
        assertEquals(LogCell("Withheld until decision", "shown once the auditor has decided"),
            waiting.copy(recommendationWithheld = true).toRow().llm)
        // A reviewer who is not the requester receives the committed advice while it waits.
        assertEquals(LogCell("DENY"), waiting.copy(llmRecommendation = "DENY").toRow().llm)
    }

    @Test fun adviceMarkedAsWithheldIsNeverShownWhateverValueCameWithIt() {
        val faulty = waiting.copy(recommendationWithheld = true, llmRecommendation = "DENY", llmAgreement = "AGREED")
        assertEquals(LogCell("Withheld until decision", "shown once the auditor has decided"), faulty.toRow().llm)
        // A request that ended without a decision shows no advice either.
        val ended = faulty.copy(status = "cancelled", outcome = "CANCELLED", basis = "REQUESTER_CANCELLED")
        assertEquals(LogCell("Not recorded", "the request ended without a decision"), ended.toRow().llm)
        assertFalse(listOf(faulty, ended).any { it.toRow().toString().contains("DENY") })
    }

    @Test fun theReducedEntryNeverShowsANameOrACaseFile() {
        val reduced = AccessLogEntry(redacted = true, action = "annotate", purpose = "investigation",
            requesterOrganization = "police", decidedAtUtc = "2026-10-12T07:23:41.063Z",
            outcome = "GRANTED", basis = "AUDITOR_DECISION", decision = "FORCE_ALLOW",
            llmRecommendation = "ALLOW", llmAgreement = "AGREED",
            // Even if a host sent them, a reduced entry is shown without them.
            requestId = "REQ-LEAK", recordId = "REC-LEAK", requesterUsername = "leak.name",
            requesterRole = "leak-role", auditorUsername = "leak.auditor",
            authorizationId = "AUTH-LEAK", createdAuthorizationId = "AUTH-LEAK-NEW")
        val row = reduced.toRow()
        assertNull(row.requestId)
        assertEquals(LogCell("Name hidden", "police"), row.who)
        assertEquals(LogCell("Case file hidden", "annotate · investigation"), row.what)
        assertEquals(LogCell("FORCE ALLOW", "agreed with the LLM's ALLOW"), row.decision)
        assertEquals(LogCell("GRANTED"), row.outcome)
        assertFalse(row.toString().contains("LEAK", ignoreCase = true))

        val reused = reduced.copy(basis = "DYNAMIC_AUTHORIZATION", decision = null,
            llmRecommendation = null, llmAgreement = null).toRow()
        assertEquals(LogCell("Not needed", "granted by a reusable authorization"), reused.decision)
        assertFalse(reused.toString().contains("LEAK", ignoreCase = true))
    }

    @Test fun aReadCutOffAtItsLimitSaysItHoldsOnlyTheNewest() {
        assertEquals("0 requests", countedLog(0, "request", "requests"))
        assertEquals("1 request", countedLog(1, "request", "requests"))
        assertEquals("28 decisions", countedLog(28, "decision", "decisions"))
        assertEquals("the newest 100 requests", countedLog(ACCESS_LOG_LIMIT, "request", "requests"))
        assertEquals("the newest 5 requests", countedLog(5, "request", "requests", limit = 5))
        val few = (1..3).map { decided.copy(requestId = "REQ-$it") }
        assertFalse(few.isCutOff())
        assertTrue(few.isCutOff(limit = 3))
        assertTrue((1..ACCESS_LOG_LIMIT).map { decided.copy(requestId = "REQ-$it") }.isCutOff())
    }

    @Test fun anOwnRequestRecordReadsAsALogEntry() {
        val record = AccessLogEntry(requestId = "REQ-3", recordId = "REC-FIR-001", action = "view",
            purpose = "investigation", status = "denied", requesterUsername = "insp.sharma",
            requesterRole = "inspector", requesterOrganization = "police",
            submittedAtUtc = "2026-10-12T06:00:00.000Z", llmRecommendation = "ALLOW",
            llmAgreement = "NOT_AGREED")
        val denied = record.asOwnRequest(reviewStatus = "FORCE_DENY", processingPath = "auditor-review").toRow()
        assertEquals(LogCell("FORCE DENY", "against the LLM's ALLOW"), denied.decision)
        assertEquals(LogCell("DENIED"), denied.outcome)

        val reused = record.copy(status = "granted", llmRecommendation = null, llmAgreement = null,
            authorizationId = "AUTH-7").asOwnRequest("SKIPPED", "dynamic-authorization").toRow()
        assertEquals(LogCell("Not asked", "a reusable authorization matched"), reused.llm)
        assertEquals(LogCell("Not needed", "granted by reusable authorization AUTH-7"), reused.decision)
        assertEquals(LogCell("GRANTED"), reused.outcome)

        // Nothing from the LLM reaches the requester before the auditor decides.
        val pending = record.copy(status = "awaiting-auditor", llmRecommendation = "ALLOW", llmAgreement = null)
            .asOwnRequest("PENDING", "auditor-review").toRow()
        assertEquals(LogCell("Withheld until decision", "shown once the auditor has decided"), pending.llm)
        assertEquals(LogCell("Waiting"), pending.outcome)
        assertEquals(LogCell("CANCELLED"),
            record.copy(status = "cancelled").asOwnRequest("PENDING", "auditor-review").toRow().outcome)
        assertEquals(LogCell("EXPIRED"),
            record.copy(status = "expired").asOwnRequest("PENDING", "auditor-review").toRow().outcome)
    }

    @Test fun pagesAreNewestFirstAndBounded() {
        val entries = (1..23).map {
            decided.copy(requestId = "REQ-%02d".format(it), decidedAtUtc = null,
                submittedAtUtc = "2026-10-12T07:%02d:00.000Z".format(it))
        }.shuffled(java.util.Random(7))
        val first = entries.logPage(0)
        assertEquals(10, first.rows.size)
        assertEquals("REQ-23", first.rows.first().requestId)
        assertEquals("REQ-14", first.rows.last().requestId)
        assertEquals(23, first.total)
        assertFalse(first.hasNewer); assertTrue(first.hasOlder)
        val last = entries.logPage(20)
        assertEquals(listOf("REQ-03", "REQ-02", "REQ-01"), last.rows.map { it.requestId })
        assertTrue(last.hasNewer); assertFalse(last.hasOlder)
        // An offset past the end, or a negative one, is brought back onto a page.
        assertEquals(20, entries.logPage(99).offset)
        assertEquals(0, entries.logPage(-5).offset)
        assertEquals(LogPage(emptyList(), 0, 0), emptyList<AccessLogEntry>().logPage(0))
        // The decision time, where there is one, orders the entry.
        val late = decided.copy(requestId = "REQ-LATE", submittedAtUtc = "2026-10-12T07:00:00.000Z",
            decidedAtUtc = "2026-10-12T09:00:00.000Z")
        assertEquals("REQ-LATE", (entries + late).logPage(0).rows.first().requestId)
    }
}
