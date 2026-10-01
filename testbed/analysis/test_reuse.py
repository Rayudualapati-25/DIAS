"""Unit tests for the reuse analysis (run: python3 -m pytest testbed/analysis/test_reuse.py)."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analyze_reuse import (  # noqa: E402
    check_ledger, conditions, exact_live, fingerprint, inference_s, queue_s, replay_fingerprint, timing)

REQUESTER = {"mspId": "PoliceMSP", "organization": "police", "role": "inspector", "rank": "3", "station": "PS-Central",
             "jurisdiction": "district-north", "clearance": "high", "credentialStatus": "active",
             "assignedToRequestedCase": False}
RESOURCE = {"recordType": "fir", "caseId": "C1", "sensitivityLevel": "medium", "jurisdiction": "district-north",
            "owningAgency": "police", "owningStation": "PS-Central", "sealed": False, "juvenileFlag": False,
            "witnessFlag": False, "victimProtectionFlag": False}


def stream(stream_id, case_id="C1", requester=None, action="view"):
    return {"streamId": stream_id, "action": action, "purpose": "investigation",
            "verifiedRequest": {"requester": requester or REQUESTER, "resource": {**RESOURCE, "caseId": case_id},
                                "request": {"action": action, "purpose": "investigation", "emergencyFlag": False,
                                            "approvalTokenPresent": False}}}


def row(rid, rnd, stream_id, base, user, path, recommendation=None, created=None, checked=None, at=0.0, case="C1"):
    return {"id": rid, "round": rnd, "streamId": stream_id, "base": base, "username": user, "recordId": stream_id,
            "caseId": case, "path": path, "status": "completed", "submittedAt": at, "startedAt": at,
            "validRecommendation": recommendation is not None, "recommendation": recommendation,
            "createdAuthorizationId": created, "checkedAuthorizationId": checked}


def test_siblings_share_a_fingerprint_but_other_properties_do_not():
    assert fingerprint(stream("A-BASE", "C1")) == fingerprint(stream("A-SIB1", "C1-SIB1"))
    assert fingerprint(stream("A-BASE")) != fingerprint(stream("B-BASE", requester={**REQUESTER, "rank": "1"}))
    assert fingerprint(stream("A-BASE")) != fingerprint(stream("A-BASE", action="export"))


def test_fingerprint_replay_grants_siblings_and_repeats_from_one_approval():
    keys = {s: fingerprint(stream(s, c)) for s, c in [("A-BASE", "C1"), ("A-SIB1", "C1-SIB1")]}
    rows = [
        row("R0-A-BASE", 0, "A-BASE", "A", "u1", "reviewed", "DENY", created="auth-1", at=1),
        row("R0-A-SIB1", 0, "A-SIB1", "A", "u1", "reviewed", "DENY", created="auth-2", at=2, case="C1-SIB1"),
        row("R1-A-BASE", 1, "A-BASE", "A", "u1", "reused", checked="auth-1", at=3),
        row("R1-A-SIB1", 1, "A-SIB1", "A", "u1", "reused", checked="auth-2", at=4, case="C1-SIB1"),
    ]
    counts = replay_fingerprint(rows, keys, {"A": True})
    assert counts["reviews"] == 1 and counts["automatic_grants"] == 3
    assert counts["grants_on_a_different_record"] == 2  # the sibling in rounds 0 and 1
    assert counts["authorizations_created"] == 1
    assert replay_fingerprint(rows[:2], keys, {"A": False})["automatic_grants"] == 0


def test_fingerprint_replay_refuses_a_stream_the_ledger_granted_but_it_would_review():
    keys = {"A-BASE": fingerprint(stream("A-BASE"))}
    with pytest.raises(ValueError):
        replay_fingerprint([row("R1-A-BASE", 1, "A-BASE", "A", "u1", "reused", checked="auth-1")], keys, {"A": True})


def test_exact_live_counts_grants_against_the_authorization_they_matched():
    rows = [
        row("R0-A-BASE", 0, "A-BASE", "A", "u1", "reviewed", "DENY", created="auth-1", at=1),
        row("R1-A-BASE", 1, "A-BASE", "A", "u1", "reused", checked="auth-1", at=2),
        row("R1-B-BASE", 1, "B-BASE", "B", "u2", "reviewed", "ALLOW", at=3),
    ]
    counts = exact_live(rows)
    assert counts["reviews"] == 2 and counts["automatic_grants"] == 1
    assert counts["grants_on_approved_record"] == 1 and counts["grants_on_a_different_record"] == 0
    with pytest.raises(ValueError):
        exact_live([row("R1-C-BASE", 1, "C-BASE", "C", "u3", "reused", checked="auth-9")])


def test_conditions_are_cumulative_over_rounds():
    keys = {"A-BASE": fingerprint(stream("A-BASE"))}
    rows = [row("R0-A-BASE", 0, "A-BASE", "A", "u1", "reviewed", "DENY", created="auth-1", at=1),
            row("R1-A-BASE", 1, "A-BASE", "A", "u1", "reused", checked="auth-1", at=2)]
    cells = {(c["repeats"], c["design"]): c for c in conditions(rows, keys, {"A": True}, 2)}
    assert cells[(0, "exact-record")]["requests"] == 1 and cells[(0, "exact-record")]["reviews"] == 1
    assert cells[(1, "exact-record")]["reviews_avoided"] == 1
    assert cells[(1, "exact-record")]["review_savings_pct"] == 50.0
    assert cells[(1, "no-reuse")]["reviews"] == 2


def test_ledger_check_matches_scope_user_record_and_origin():
    creating = {**row("R0-A-BASE", 0, "A-BASE", "A", "u1", "reviewed", "DENY", created="auth-1"),
                "action": "view", "purpose": "investigation", "requestId": "REQ-1"}
    scope = {"scopeVersion": "dias-authorization-scope-exact-record-v1", "stableUserId": "PoliceMSP::u1",
             "recordId": "A-BASE", "caseId": "C1", "action": "view", "purpose": "investigation"}
    good = {"planAuthorizationList": [{"authorizationId": "auth-1", "status": "active", "scope": scope,
                                       "originatingRequestId": "REQ-1"}]}
    assert check_ledger([creating], good)["pass"] is True
    for change in [{"stableUserId": "PoliceMSP::u2"}, {"recordId": "A-SIB1"}, {"purpose": "audit-review"}]:
        altered = {"planAuthorizationList": [{**good["planAuthorizationList"][0], "scope": {**scope, **change}}]}
        assert check_ledger([creating], altered)["pass"] is False
    other_origin = {"planAuthorizationList": [{**good["planAuthorizationList"][0], "originatingRequestId": "REQ-2"}]}
    assert check_ledger([creating], other_origin)["pass"] is False


def test_inference_time_is_read_from_the_backend_latency_breakdown():
    breakdown = {"contextAssembly": 0.2, "inference": 7350.0, "validation": 0.8, "total": 7351.0}
    assert inference_s({"modelLatencyMs": breakdown}) == 7.35
    assert inference_s({"modelLatencyMs": 7350.0}) == 7.35
    assert inference_s({}) is None
    reviewed = {**row("R0-A-BASE", 0, "A-BASE", "A", "u1", "reviewed", "ALLOW"), "endToEndMs": 9000.0,
                "submitMs": 100.0, "recommendationReadyMs": 7500.0, "decisionMs": 1400.0, "modelLatencyMs": breakdown}
    assert timing([reviewed])["reviewed_model_inference"]["p50_s"] == 7.35


def test_queue_wait_is_the_recommendation_wait_minus_the_model_call():
    breakdown = {"contextAssembly": 0.2, "inference": 7500.0, "validation": 0.8, "total": 7501.0}
    assert queue_s({"recommendationReadyMs": 567500.0, "modelLatencyMs": breakdown}) == 560.0
    assert queue_s({"recommendationReadyMs": 9000.0}) is None
    assert queue_s({"modelLatencyMs": breakdown}) is None
