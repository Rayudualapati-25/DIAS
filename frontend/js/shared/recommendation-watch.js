/**
 * Watching for LLM recommendations that are still being prepared.
 *
 * The auditor screen shows "Being prepared" while the backend asks the LLM. This
 * watch asks the backend every few seconds whether those recommendations are
 * ready and tells the screen the moment one is, so the auditor does not have to
 * press Refresh. The check reads no case data and is not written to the access
 * log; the queue itself is loaded again only when something became ready.
 *
 * It ends by itself when nothing is left to wait for or the screen is gone. It
 * gives up, and tells the screen so, when the backend refuses a check, when the
 * network fails several times in a row, or after WATCH_LIMIT_MS. The Refresh
 * buttons keep working in every one of those cases.
 */

import { isRecommendationPreparing } from './dias.js';

export const WATCH_INTERVAL_MS = 3000;
export const WATCH_LIMIT_MS = 10 * 60 * 1000;
/** The most request ids one status call may carry; the backend refuses more (MAX_STATUS_IDS). */
export const WATCH_MAX_IDS = 50;
/** Checks in a row that got no answer at all before the watch gives up. */
export const WATCH_MAX_FAILURES = 3;
/** Why a watch gave up while requests were still being prepared. */
export const WATCH_STOPPED = Object.freeze({ FAILED: 'failed', LIMIT: 'limit' });

/** The requests among these reviews whose recommendation is still being prepared. */
export function preparingRequestIds(reviews) {
  return (reviews || [])
    .filter(isRecommendationPreparing)
    .map((review) => review?.request?.requestId)
    .filter((requestId) => typeof requestId === 'string' && requestId !== '');
}

const chunked = (items, size) => Array.from(
  { length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/**
 * @param {object} options
 * @param {(ids: string[]) => Promise<{requestId: string, preparing: boolean}[]>} options.check
 *   asked with at most WATCH_MAX_IDS ids per call
 * @param {(readyIds: string[]) => void} options.onReady watched requests stopped being prepared
 * @param {(reason: string) => void} [options.onStopped] the watch gave up (a WATCH_STOPPED value)
 * @param {() => boolean} [options.isActive] false once the screen has been left
 */
export function createRecommendationWatch({
  check,
  onReady,
  onStopped = () => {},
  isActive = () => true,
  intervalMs = WATCH_INTERVAL_MS,
  limitMs = WATCH_LIMIT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
}) {
  let watched = [];
  let deadline = 0;
  let failures = 0;
  let timer = null;
  // Every watch() and stop() starts a new generation, so the answer to a check
  // that was already in flight is ignored instead of scheduling a second chain.
  let generation = 0;
  // A request reported ready is never waited for again, so a view that still
  // calls it pending cannot make this watch reload the queue in a loop.
  const reported = new Set();

  function cancel() {
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function stop() {
    cancel();
    watched = [];
  }

  function giveUp(reason) {
    stop();
    onStopped(reason);
  }

  function schedule() {
    const mine = generation;
    timer = setTimer(() => tick(mine), intervalMs);
  }

  /** A refusal is final; no answer at all is tried again a few times. */
  function checkFailed(error) {
    failures += 1;
    const refused = Boolean(error) && error.status !== undefined;
    if (refused || failures >= WATCH_MAX_FAILURES) giveUp(WATCH_STOPPED.FAILED);
    else schedule();
  }

  function settle(statuses) {
    const preparing = new Set(statuses
      .filter((item) => item && item.preparing === true)
      .map((item) => item.requestId));
    const ready = watched.filter((requestId) => !preparing.has(requestId));
    watched = watched.filter((requestId) => preparing.has(requestId));
    ready.forEach((requestId) => reported.add(requestId));
    if (watched.length > 0) schedule();
    if (ready.length > 0) onReady(ready);
  }

  async function tick(mine) {
    if (mine !== generation) return;
    timer = null;
    if (watched.length === 0 || !isActive()) {
      stop();
      return;
    }
    if (now() > deadline) {
      giveUp(WATCH_STOPPED.LIMIT);
      return;
    }
    let answers;
    try {
      // Every watched id is asked about, so one missing from the answers is ready.
      answers = await Promise.all(chunked(watched, WATCH_MAX_IDS).map((ids) => check(ids)));
    } catch (error) {
      if (mine === generation) checkFailed(error);
      return;
    }
    if (mine !== generation) return;
    if (!isActive()) {
      stop();
      return;
    }
    failures = 0;
    settle(answers.flat().filter(Boolean));
  }

  /** Wait for exactly these requests; an empty list ends the watch. */
  function watch(requestIds) {
    cancel();
    failures = 0;
    watched = [...new Set(requestIds || [])].filter((requestId) => !reported.has(requestId));
    if (watched.length === 0) return;
    deadline = now() + limitMs;
    schedule();
  }

  return Object.freeze({ watch, stop, watching: () => [...watched] });
}
