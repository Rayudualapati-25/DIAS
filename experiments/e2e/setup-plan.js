'use strict';

/** The pre-registered plan of the three-setup experiment. */

const crypto = require('crypto');
const {
  ACTIONS, PURPOSES, REASONS, RECORDS, REQUESTERS, generator, scopeOf, shuffled, spread,
} = require('./plan');

const CELLS = Object.freeze([
  Object.freeze({ cell: 'MM', officer: 'mac', auditor: 'mac', setup: 'mac-only' }),
  Object.freeze({ cell: 'PP', officer: 'phone', auditor: 'phone', setup: 'phone-only' }),
  Object.freeze({ cell: 'MP', officer: 'mac', auditor: 'phone', setup: 'combined' }),
  Object.freeze({ cell: 'PM', officer: 'phone', auditor: 'mac', setup: 'combined' }),
]);
const SETUPS = Object.freeze(['mac-only', 'phone-only', 'combined']);
const REPEATS_PER_BASE = 3;

/**
 * Requests the written policy denies and the untuned model denied every time in the runs of 2026-10-13
 * (who, which file, which operation).
 */
const DENIED_BASES = Object.freeze([
  ['const.verma', 'REC-FIR-001', 'export'], ['insp.rathore', 'REC-FIR-001', 'export'],
  ['insp.singh', 'REC-EVIDENCE-001', 'annotate'], ['sho.reddy', 'REC-JUVENILE-001', 'view'],
  ['analyst.rao', 'REC-FIR-001', 'annotate'], ['dir.iyer', 'REC-JUVENILE-001', 'annotate'],
  ['dc.nair', 'REC-EVIDENCE-001', 'annotate'], ['pp.mehta', 'REC-FIR-001', 'export'],
  ['clerk.das', 'REC-JUVENILE-001', 'export'], ['judge.rana', 'REC-JUVENILE-001', 'annotate'],
  ['insp.sharma', 'REC-EVIDENCE-001', 'export'], ['sho.reddy', 'REC-EVIDENCE-001', 'annotate'],
]);

const USERNAMES = REQUESTERS.map((requester) => requester.username);
const padded = (number) => String(number).padStart(2, '0');
const reasonFor = (purpose, id) => `${REASONS[purpose]} Synthetic three-setup experiment request ${id}.`;

/** `count` request scopes with every attribute as evenly spread as the count allows, none in `taken`. */
function balancedScopes(count, random, taken) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const users = spread(USERNAMES, count, random);
    const records = spread(RECORDS, count, random);
    const actions = spread(ACTIONS, count, random);
    const purposes = spread(PURPOSES, count, random);
    const scopes = users.map((username, index) => ({
      username, recordId: records[index], action: actions[index], purpose: purposes[index],
    }));
    const keys = scopes.map(scopeOf);
    if (new Set(keys).size === keys.length && keys.every((key) => !taken.has(key))) return scopes;
  }
  throw new Error('could not draw distinct request scopes for this plan');
}

/** The step experiment: every cell once per block, in a seeded order inside the block. */
function stepsPart(perCell, random, taken) {
  const items = [];
  for (const cell of CELLS) {
    balancedScopes(perCell, random, taken).forEach((scope, index) => {
      taken.add(scopeOf(scope));
      const id = `S-${cell.cell}-${padded(index + 1)}`;
      items.push({ id, ...cell, ...scope, justification: reasonFor(scope.purpose, id) });
    });
  }
  const order = [];
  for (let block = 0; block < perCell; block += 1) {
    order.push(...shuffled(CELLS.map((cell) => `S-${cell.cell}-${padded(block + 1)}`), random));
  }
  return { perCell, items, order };
}

/**
 * The reuse experiment: denied requests, dealt to the cells, each with its repeats and its two
 * counter-checks.
 */
function reusePart(basesPerCell, random, taken) {
  const wanted = basesPerCell * CELLS.length;
  if (wanted > DENIED_BASES.length) throw new Error(`a plan has at most ${DENIED_BASES.length / CELLS.length} reuse requests per cell`);
  const dealt = shuffled(DENIED_BASES, random).slice(0, wanted);
  const bases = dealt.map(([username, recordId, action], index) => {
    const cell = CELLS[index % CELLS.length];
    const free = shuffled(PURPOSES, random).filter((purpose) => !taken.has(scopeOf({ username, recordId, action, purpose })));
    if (free.length < 2) throw new Error(`no free purposes left for ${username} ${recordId} ${action}`);
    const [purpose, otherPurpose] = free;
    const scope = { username, recordId, action, purpose };
    const nearMiss = { ...scope, purpose: otherPurpose };
    taken.add(scopeOf(scope));
    taken.add(scopeOf(nearMiss));
    const id = `R-${cell.cell}-${padded(Math.floor(index / CELLS.length) + 1)}`;
    const request = (suffix, body) => ({ id: `${id}-${suffix}`, ...body, justification: reasonFor(body.purpose, `${id}-${suffix}`) });
    return {
      id, ...cell, ...scope,
      first: request('first', scope),
      repeats: Array.from({ length: REPEATS_PER_BASE }, (_, repeat) => request(`repeat${repeat + 1}`, scope)),
      nearMiss: request('nearmiss', nearMiss),
      afterRevoke: request('afterrevoke', scope),
    };
  });
  return { basesPerCell, repeatsPerBase: REPEATS_PER_BASE, bases, order: bases.map((base) => base.id) };
}

/** Unused scopes of each officer, in a seeded order, to deal the load bursts from. */
function scopePool(random, taken) {
  const pool = new Map();
  for (const username of USERNAMES) {
    const scopes = [];
    for (const recordId of RECORDS) {
      for (const action of ACTIONS) {
        for (const purpose of PURPOSES) {
          const scope = { username, recordId, action, purpose };
          if (!taken.has(scopeOf(scope))) scopes.push(scope);
        }
      }
    }
    pool.set(username, shuffled(scopes, random));
  }
  return pool;
}

/**
 * The load experiment: for each repeat, one burst per setup and level, in a seeded order. A burst's
 * officers are spread as evenly as its size allows.
 */
function loadPart(levels, repeats, random, taken) {
  const pool = scopePool(random, taken);
  const bursts = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const kinds = shuffled(SETUPS.flatMap((setup) => levels.map((level) => ({ setup, level }))), random);
    for (const { setup, level } of kinds) {
      const id = `L-${setup}-${padded(level)}-r${repeat}`;
      const requests = spread(USERNAMES, level, random).map((username, index) => {
        const scope = pool.get(username).pop();
        if (!scope) throw new Error(`no unused request scope left for ${username}`);
        taken.add(scopeOf(scope));
        const requestId = `${id}-${padded(index + 1)}`;
        const surface = setup === 'mac-only' ? 'mac' : setup === 'phone-only' ? 'phone' : (index % 2 === 0 ? 'mac' : 'phone');
        return { id: requestId, officer: surface, ...scope, justification: reasonFor(scope.purpose, requestId) };
      });
      bursts.push({ id, setup, level, repeat, requests });
    }
  }
  return { levels, repeats, bursts, order: bursts.map((burst) => burst.id) };
}

const digestOf = ({ seed, steps, reuse, load }) =>
  crypto.createHash('sha256').update(JSON.stringify({ seed, steps, reuse, load })).digest('hex');

function buildSetupPlan({ seed, perCell = 24, basesPerCell = 3, loadLevels = [5, 10, 25], loadRepeats = 2 }) {
  if (![perCell, basesPerCell, loadRepeats, ...loadLevels].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('a plan needs positive whole numbers');
  }
  const random = generator(seed);
  const taken = new Set();
  // The denied requests of the reuse experiment are set aside first, with all their purposes, so that no
  // other experiment asks for one of them while its authorization is active.
  DENIED_BASES.forEach(([username, recordId, action]) => PURPOSES.forEach(
    (purpose) => taken.add(scopeOf({ username, recordId, action, purpose }))));
  const steps = stepsPart(perCell, random, taken);
  const load = loadPart(loadLevels, loadRepeats, random, taken);
  DENIED_BASES.forEach(([username, recordId, action]) => PURPOSES.forEach(
    (purpose) => taken.delete(scopeOf({ username, recordId, action, purpose }))));
  const reuse = reusePart(basesPerCell, random, taken);
  const plan = { seed, steps, reuse, load };
  return { schema: 'dias-setup-plan-v1', seed, auditor: 'sp.north', steps, reuse, load, sha256: digestOf(plan) };
}

/** Every request the plan sends, with the experiment it belongs to. */
function plannedRequests(plan) {
  return [
    ...plan.steps.items.map((item) => ({ experiment: 'steps', ...item })),
    ...plan.reuse.bases.flatMap((base) => [base.first, ...base.repeats, base.nearMiss, base.afterRevoke]
      .map((item) => ({ experiment: 'reuse', ...item }))),
    ...plan.load.bursts.flatMap((burst) => burst.requests.map((item) => ({ experiment: 'load', ...item }))),
  ];
}

module.exports = { CELLS, DENIED_BASES, REPEATS_PER_BASE, SETUPS, buildSetupPlan, digestOf, plannedRequests };

// Usage: setup-plan.js SEED OUT [PER_CELL] [BASES_PER_CELL] [LOAD_REPEATS] [LEVELS, comma-separated]
if (require.main === module) {
  const fs = require('fs');
  const [seed, out, perCell, basesPerCell, loadRepeats, levels] = process.argv.slice(2);
  const plan = buildSetupPlan({
    seed: Number(seed), perCell: Number(perCell || 24), basesPerCell: Number(basesPerCell || 3),
    loadRepeats: Number(loadRepeats || 2), loadLevels: (levels || '5,10,25').split(',').map(Number),
  });
  fs.writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
  console.log(`${plan.steps.items.length} step workflows, ${plan.reuse.bases.length} reuse requests with repeats, `
    + `${plan.load.bursts.length} load bursts; sha256 ${plan.sha256} -> ${out}`);
}
