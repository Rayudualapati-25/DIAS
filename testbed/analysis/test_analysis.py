"""Unit tests for the testbed analysis helpers (run: python3 -m pytest testbed/analysis)."""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from accuracy import mcnemar_exact, score, wilson  # noqa: E402
from analyze_e5 import pct  # noqa: E402
from components import split  # noqa: E402
from make_report import linear_fit  # noqa: E402


def test_percentile_nearest_rank():
    values = list(range(1, 101))
    assert pct(values, 0.5) == 50
    assert pct(values, 0.95) == 95
    assert pct([7.0], 0.95) == 7.0
    assert pct([], 0.5) is None


def test_wilson_interval_known_value():
    low, high = wilson(6, 204)
    assert math.isclose(low, 0.0135, abs_tol=5e-4)
    assert math.isclose(high, 0.0627, abs_tol=5e-4)


def test_mcnemar_exact_symmetric_and_extreme():
    assert mcnemar_exact(0, 0) == 1.0
    assert math.isclose(mcnemar_exact(5, 5), 1.0)
    # 0 vs 10 discordant pairs: 2 * 0.5**10
    assert math.isclose(mcnemar_exact(0, 10), 2 * 0.5 ** 10)


def test_score_counts_unusable_answers_separately():
    rows = [
        {"expected": {"recommendation": "ALLOW", "reason_code": "POLICY_SATISFIED", "policy_refs": ["A"]},
         "predicted": {"recommendation": "ALLOW", "reason_code": "POLICY_SATISFIED", "policy_refs": ["A"]}, "status": "OK"},
        {"expected": {"recommendation": "ALLOW", "reason_code": "POLICY_SATISFIED", "policy_refs": ["A"]},
         "predicted": None, "status": "INVALID_OUTPUT"},
        {"expected": {"recommendation": "DENY", "reason_code": "NOT_ASSIGNED", "policy_refs": ["B"]},
         "predicted": {"recommendation": "ALLOW", "reason_code": "POLICY_SATISFIED", "policy_refs": ["A"]}, "status": "OK"},
    ]
    s = score(rows)
    assert s["cases"] == 3 and s["usable"] == 2 and s["unusable"] == 1
    assert s["ALLOW_to_ALLOW"] == 1 and s["ALLOW_unusable"] == 1
    assert s["wrongly_granted"] == 1 and s["correct"] == 1


def test_split_adds_up_to_end_to_end():
    row = {"status": "completed", "startedAt": 0.0, "submitMs": 120.0, "recommendationReadyMs": 9050.0,
           "decisionWaitMs": 30.0, "decisionMs": 2040.0, "endToEndMs": 120.0 + 9050.0 + 30.0 + 2040.0}
    events = {
        "request_commit": {"totalMs": 100.0, "endorseMs": 40.0, "ordererSubmitMs": 5.0, "commitWaitMs": 55.0},
        "decision_commit": {"totalMs": 2030.0, "endorseMs": 15.0, "ordererSubmitMs": 3.0, "commitWaitMs": 2012.0},
        "recommendation.enqueued": {"at": 1000.0, "queued": 3},
        "recommendation.started": {"at": 2000.0},
        "recommendation.ready": {"at": 10000.0},
        "model.response": {"inferenceMs": 7990.0, "promptTokens": 1900, "completionTokens": 80, "cachedPromptTokens": 300},
    }
    parts = split(row, events)
    assert math.isclose(parts["queue_wait"], 1.0)
    assert math.isclose(parts["llm_inference"], 7.99)
    assert math.isclose(parts["notify_delay"], 0.05)
    assert abs(parts["split_check"]) < 1e-9


def test_linear_fit_exact_line():
    slope, intercept, r2 = linear_fit([10, 25, 50, 75, 100], [2 * x + 5 for x in [10, 25, 50, 75, 100]])
    assert math.isclose(slope, 2.0) and math.isclose(intercept, 5.0) and math.isclose(r2, 1.0)
