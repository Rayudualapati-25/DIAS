/**
 * The auditor screen's automatic "is the recommendation ready" watch.
 *
 * It must tell the screen the moment a recommendation is ready, and it must
 * never run away: every way it can end is tested here, because a check that
 * keeps repeating is a request to the backend every few seconds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WATCH_INTERVAL_MS, WATCH_LIMIT_MS, WATCH_MAX_FAILURES, WATCH_MAX_IDS, WATCH_STOPPED,
  createRecommendationWatch, preparingRequestIds,
} from '../js/shared/recommendation-watch.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const status = (answers) => Object.entries(answers).map(([requestId, preparing]) => ({ requestId, preparing }));
const allPreparing = (ids) => ids.map((requestId) => ({ requestId, preparing: true }));
/** No answer at all: the network, not a refusal. */
const networkFailure = () => new Error('cannot reach the server');
/** An answer that refuses: it carries the HTTP status. */
const refusal = (httpStatus) => Object.assign(new Error('refused'), { status: httpStatus });

/**
 * A watch on hand-driven timers and a scripted backend. `answers` are used one
 * per call: a status list, an Error to reject with, or a function of the ids.
 */
function harness({ answers = [], isActive = () => true, limitMs = WATCH_LIMIT_MS } = {}) {
  const timers = new Map();
  const asked = [];
  const ready = [];
  const stopped = [];
  const script = [...answers];
  let nextTimer = 1;
  let clock = 0;
  const watch = createRecommendationWatch({
    check: (ids) => {
      asked.push(ids);
      const answer = script.length > 1 ? script.shift() : script[0];
      if (typeof answer === 'function') return Promise.resolve(answer(ids));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    onReady: (ids) => ready.push(ids),
    onStopped: (reason) => stopped.push(reason),
    isActive,
    limitMs,
    setTimer: (fn, ms) => {
      assert.equal(ms, WATCH_INTERVAL_MS);
      timers.set(nextTimer, fn);
      nextTimer += 1;
      return nextTimer - 1;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => clock,
  });
  /** Let the interval pass and run the one pending check. */
  const tick = () => {
    assert.equal(timers.size, 1, 'exactly one check must be scheduled');
    const [[id, fn]] = [...timers.entries()];
    timers.delete(id);
    clock += WATCH_INTERVAL_MS;
    return fn();
  };
  return { watch, asked, ready, stopped, timers, tick };
}

test('finds the requests whose recommendation is still being prepared or committed', () => {
  const review = (requestId, recommendationState) => ({ request: { requestId }, recommendationState });
  assert.deepEqual(preparingRequestIds([
    review('REQ-1', 'pending'), review('REQ-2', 'signed'), review('REQ-3', 'committed'),
    review('REQ-4', 'failed'), review('REQ-5', 'not-generated'), { recommendationState: 'pending' },
  ]), ['REQ-1', 'REQ-2']);
  assert.deepEqual(preparingRequestIds(undefined), []);
});

test('reports a recommendation the moment it is ready and keeps waiting for the rest', async () => {
  const h = harness({
    answers: [status({ 'REQ-1': true, 'REQ-2': true }), status({ 'REQ-1': false, 'REQ-2': true })],
  });
  h.watch.watch(['REQ-1', 'REQ-2', 'REQ-1']);
  await h.tick();
  assert.deepEqual(h.ready, []);
  await h.tick();
  assert.deepEqual(h.asked, [['REQ-1', 'REQ-2'], ['REQ-1', 'REQ-2']]);
  assert.deepEqual(h.ready, [['REQ-1']]);
  assert.deepEqual(h.watch.watching(), ['REQ-2']);
  assert.equal(h.timers.size, 1);
});

test('stops by itself once nothing is left to wait for, without a notice', async () => {
  const h = harness({ answers: [status({ 'REQ-1': false })] });
  h.watch.watch(['REQ-1']);
  await h.tick();
  assert.deepEqual(h.ready, [['REQ-1']]);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, []);
});

test('never waits again for a request it already reported, so a stuck view cannot loop', async () => {
  const h = harness({ answers: [status({ 'REQ-1': false })] });
  h.watch.watch(['REQ-1']);
  await h.tick();
  h.watch.watch(['REQ-1']);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.asked.length, 1);
});

test('asks in calls of at most WATCH_MAX_IDS requests, which is the limit the backend accepts', async () => {
  const backend = fs.readFileSync(path.join(REPO, 'backend/src/routes/access.js'), 'utf8');
  assert.equal(Number(/const MAX_STATUS_IDS = (\d+);/.exec(backend)[1]), WATCH_MAX_IDS);

  const ids = Array.from({ length: 2 * WATCH_MAX_IDS + 20 }, (_, index) => `REQ-${index}`);
  const h = harness({ answers: [allPreparing] });
  h.watch.watch(ids);
  await h.tick();
  assert.deepEqual(h.asked.map((call) => call.length), [WATCH_MAX_IDS, WATCH_MAX_IDS, 20]);
  assert.deepEqual(h.asked.flat(), ids);
  // Nothing was mistaken for ready just because one call could not carry it.
  assert.deepEqual(h.ready, []);
  assert.equal(h.watch.watching().length, ids.length);
});

test('stops at once when the backend refuses, and says so', async () => {
  const h = harness({ answers: [refusal(404)] });
  h.watch.watch(['REQ-1']);
  await h.tick();
  assert.deepEqual(h.ready, []);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, [WATCH_STOPPED.FAILED]);
});

test('tries again after a network failure and reports once the backend answers', async () => {
  const h = harness({ answers: [networkFailure(), status({ 'REQ-1': false })] });
  h.watch.watch(['REQ-1']);
  await h.tick();
  assert.deepEqual(h.watch.watching(), ['REQ-1']);
  assert.deepEqual(h.stopped, []);
  await h.tick();
  assert.deepEqual(h.ready, [['REQ-1']]);
});

test('gives up after repeated network failures, and says so', async () => {
  const h = harness({ answers: [networkFailure()] });
  h.watch.watch(['REQ-1']);
  for (let attempt = 1; attempt < WATCH_MAX_FAILURES; attempt += 1) await h.tick();
  assert.deepEqual(h.stopped, []);
  await h.tick();
  assert.equal(h.asked.length, WATCH_MAX_FAILURES);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, [WATCH_STOPPED.FAILED]);
});

test('stops without asking once the screen is gone, without a notice', async () => {
  let onScreen = true;
  const h = harness({ answers: [status({ 'REQ-1': true })], isActive: () => onScreen });
  h.watch.watch(['REQ-1']);
  await h.tick();
  onScreen = false;
  await h.tick();
  assert.equal(h.asked.length, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, []);
});

test('reports nothing when the screen was left while a check was in flight', async () => {
  let onScreen = true;
  const h = harness({
    answers: [() => { onScreen = false; return status({ 'REQ-1': false }); }],
    isActive: () => onScreen,
  });
  h.watch.watch(['REQ-1']);
  await h.tick();
  assert.deepEqual(h.ready, []);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
});

test('gives up after the time limit, and says so', async () => {
  const h = harness({ answers: [status({ 'REQ-1': true })], limitMs: WATCH_INTERVAL_MS + 1 });
  h.watch.watch(['REQ-1']);
  await h.tick();
  await h.tick();
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, [WATCH_STOPPED.LIMIT]);
});

test('a new watch replaces a check in flight without doubling the checks', async () => {
  let answerFirst;
  const h = harness({
    answers: [() => new Promise((resolve) => { answerFirst = resolve; }), status({ 'REQ-1': true, 'REQ-2': true })],
  });
  h.watch.watch(['REQ-1']);
  const inFlight = h.tick();
  h.watch.watch(['REQ-1', 'REQ-2']);
  answerFirst(status({ 'REQ-1': false }));
  await inFlight;
  // The stale answer is ignored: the newer watch decides what is ready.
  assert.deepEqual(h.ready, []);
  assert.deepEqual(h.watch.watching(), ['REQ-1', 'REQ-2']);
  await h.tick();
  assert.equal(h.timers.size, 1);
});

test('stop ends the watch at once', () => {
  const h = harness();
  h.watch.watch(['REQ-1']);
  h.watch.stop();
  assert.deepEqual(h.watch.watching(), []);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.stopped, []);
});
