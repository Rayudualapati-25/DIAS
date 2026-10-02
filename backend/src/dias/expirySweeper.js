'use strict';

/**
 * Pending-request expiry sweeper (design §8).
 *
 * A rejected Fabric transaction writes nothing, so a request that passes its
 * review deadline stays "awaiting" until an ExpirePendingRequest transaction
 * records the expiry. This sweeper submits that transaction for every pending
 * request whose deadline has passed. The contract re-checks the deadline against
 * committed state, so an early or repeated call is refused there and changes
 * nothing.
 */

const CONTRACT = 'AccessContract';

function createExpirySweeper({
  ledger, identity, now = () => Date.now(), intervalMs = 0, log = console,
}) {
  if (!ledger || !identity || !identity.org || !identity.fabricUser) {
    throw new Error('expiry sweeper requires a ledger and an identity');
  }
  let timer = null;

  async function sweepOnce() {
    const pending = await ledger.evaluate(
      identity.org, identity.fabricUser, CONTRACT, 'QueryPendingAuditorRequests');
    const due = pending
      .map((entry) => entry.request)
      .filter((request) => request && request.reviewDeadlineUtc
        && Date.parse(request.reviewDeadlineUtc) <= now());
    const results = [];
    for (const request of due) {
      try {
        await ledger.submit(identity.org, identity.fabricUser, CONTRACT, 'ExpirePendingRequest', request.requestId);
        results.push({ requestId: request.requestId, expired: true });
      } catch (error) {
        const message = error && Array.isArray(error.details) && error.details.length > 0
          ? String(error.details[0].message) : error.message;
        results.push({ requestId: request.requestId, expired: false, error: message });
      }
    }
    if (results.length > 0) {
      log.log(`[dias] expiry sweep: ${results.filter((r) => r.expired).length}/${results.length} expired`);
    }
    return results;
  }

  function start() {
    if (!intervalMs || intervalMs <= 0) return null;
    timer = setInterval(() => {
      sweepOnce().catch((error) => log.error(`[dias] expiry sweep failed: ${error.message}`));
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ sweepOnce, start, stop });
}

module.exports = { createExpirySweeper };
