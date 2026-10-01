"""Join client rows with the backend trace to split each workflow into components.

Components of one approval/deny workflow (all in seconds):
  request_commit     ledger write 1: CreateAccessRequest (endorse + order + commit)
  request_api        rest of the submit call (API checks, review-store write, network)
  queue_wait         waiting for the single recommendation worker
  llm_inference      model server time for this prompt (Mac GPU, via HTTP)
  llm_prompt_check   building the prompt and checking the model's answer
  auditor_pickup     recommendation ready -> auditor view loaded (polling <= 0.1 s + view)
  decision_commit    ledger write 2: SubmitAuditorDecision (endorse + order + commit)
  decision_api       rest of the decision call
The components add up to the client's end-to-end time by construction; the
notification delay inside auditor_pickup is reported so the split can be checked.
"""

import json
from collections import defaultdict

COMPONENTS = [
    "request_commit", "request_api", "queue_wait", "llm_inference",
    "llm_prompt_check", "auditor_pickup", "decision_commit", "decision_api",
]
LABELS = {
    "request_commit": "Request commit (ledger)",
    "request_api": "Request API",
    "queue_wait": "Queue wait",
    "llm_inference": "LLM inference",
    "llm_prompt_check": "Prompt + output check",
    "auditor_pickup": "Auditor pickup",
    "decision_commit": "Decision commit (ledger)",
    "decision_api": "Decision API",
}


def load_jsonl(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def index_trace(trace_rows):
    """Per requestId: the trace events the backend wrote for it."""
    by_request = defaultdict(dict)
    others = []
    for event in trace_rows:
        kind = event.get("event")
        if kind == "fabric.submit" and event.get("fn") == "CreateAccessRequest" and event.get("txId"):
            by_request[f"REQ-{event['txId'][:16]}"]["request_commit"] = event
        elif kind == "fabric.submit" and event.get("fn") == "SubmitAuditorDecision":
            by_request[event.get("arg0")]["decision_commit"] = event
        elif kind in ("recommendation.enqueued", "recommendation.started", "recommendation.ready", "model.response"):
            by_request[event.get("requestId")][kind] = event
        else:
            others.append(event)
    return by_request, others


def split(row, events):
    """Seconds per component for one completed client row, or None if the trace is incomplete.

    Only durations are combined, never absolute times from two processes, so a
    clock offset between the backend and the load generator cannot leak into the
    split. By construction the components add up to the client's end-to-end time.
    """
    need = ["request_commit", "decision_commit", "recommendation.enqueued", "recommendation.started",
            "recommendation.ready", "model.response"]
    if row.get("status") != "completed" or any(key not in events for key in need):
        return None
    req = events["request_commit"]
    dec = events["decision_commit"]
    ready = events["recommendation.ready"]
    started = events["recommendation.started"]
    enqueued = events["recommendation.enqueued"]
    model = events["model.response"]
    inference_ms = model["inferenceMs"]
    queue_ms = started["at"] - enqueued["at"]
    worker_ms = ready["at"] - started["at"]
    # Client-observed wait for the recommendation minus the backend's own
    # enqueue-to-ready time: the review-store polling delay (<= 0.1 s) and the
    # few milliseconds between enqueueing and the HTTP response.
    notify_ms = row["recommendationReadyMs"] - (ready["at"] - enqueued["at"])
    parts_ms = {
        "request_commit": req["totalMs"],
        "request_api": row["submitMs"] - req["totalMs"],
        "queue_wait": queue_ms,
        "llm_inference": inference_ms,
        "llm_prompt_check": worker_ms - inference_ms,
        "auditor_pickup": notify_ms + row["decisionWaitMs"],
        "decision_commit": dec["totalMs"],
        "decision_api": row["decisionMs"] - dec["totalMs"],
    }
    out = {key: value / 1000.0 for key, value in parts_ms.items()}
    out["end_to_end"] = row["endToEndMs"] / 1000.0
    out["split_check"] = (row["endToEndMs"] - sum(parts_ms.values())) / 1000.0
    out["notify_delay"] = notify_ms / 1000.0
    out["request_endorse"] = req["endorseMs"] / 1000.0
    out["request_order_submit"] = req["ordererSubmitMs"] / 1000.0
    out["request_commit_wait"] = req["commitWaitMs"] / 1000.0
    out["decision_endorse"] = dec["endorseMs"] / 1000.0
    out["decision_order_submit"] = dec["ordererSubmitMs"] / 1000.0
    out["decision_commit_wait"] = dec["commitWaitMs"] / 1000.0
    out["prompt_tokens"] = model.get("promptTokens")
    out["completion_tokens"] = model.get("completionTokens")
    out["cached_prompt_tokens"] = model.get("cachedPromptTokens")
    out["queue_depth_at_enqueue"] = enqueued.get("queued")
    return out
