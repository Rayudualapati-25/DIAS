#!/usr/bin/env node
'use strict';

/** Tables for the three-setup experiment of one model, from what its runners wrote. */

const fs = require('fs');
const path = require('path');
const { describe, round } = require('./lib');
const { CELLS, SETUPS } = require('./setup-plan');
const { generator } = require('./plan');

const sum = (...values) => (values.every((value) => Number.isFinite(value)) ? values.reduce((a, b) => a + b, 0) : null);
const median = (values) => { const stats = describe(values); return stats ? stats.median : null; };
const mean = (values) => { const stats = describe(values); return stats ? stats.mean : null; };
const difference = (phone, mac) => (phone === null || mac === null ? null : round(phone - mac));
const count = (rows, test) => rows.filter(test).length;

/** Workflows whose times are used. */
const timed = (rows) => rows.filter((row) => row.status === 'completed' && row.followed === true);

/** The decision as the auditor's screen confirms it: the write and the read back from the ledger. */
const decisionOf = (row) => sum(row.decisionMs, row.readbackMs);
/** Everything the auditor does for one request. */
const auditorWork = (row) => sum(row.queueMs, row.reviewMs, row.decisionMs, row.readbackMs, row.logMs);

function stepsLine(group, rows) {
  const used = timed(rows);
  const endToEnd = describe(used.map((row) => row.endToEndMs));
  return {
    group, n: used.length,
    endToEndMedianMs: endToEnd && endToEnd.median, endToEndMeanMs: endToEnd && endToEnd.mean,
    endToEndP95Ms: endToEnd && endToEnd.p95, endToEndMinMs: endToEnd && endToEnd.min, endToEndMaxMs: endToEnd && endToEnd.max,
    submitMedianMs: median(used.map((row) => row.submitMs)),
    recommendationMedianMs: median(used.map((row) => row.recommendationMs)),
    inferenceMedianMs: median(used.map((row) => row.modelInferenceMs)),
    queueMedianMs: median(used.map((row) => row.queueMs)),
    reviewMedianMs: median(used.map((row) => row.reviewMs)),
    decisionMedianMs: median(used.map(decisionOf)),
    logMedianMs: median(used.map((row) => row.logMs)),
    outcomeMedianMs: median(used.map((row) => row.outcomeMs)),
    quietBeforeRequestMedianMs: median(used.map((row) => row.quietBeforeRequestMs)),
    quietBeforeDecisionMedianMs: median(used.map((row) => row.quietBeforeDecisionMs)),
  };
}

/** One line per cell, per setup, and for all workflows together. */
function stepsTable(rows) {
  return [
    ...CELLS.map(({ cell }) => stepsLine(cell, rows.filter((row) => row.cell === cell))),
    ...SETUPS.map((setup) => stepsLine(setup, rows.filter((row) => row.setup === setup))),
    stepsLine('all', rows),
  ];
}

/**
 * The difference of two medians, b minus a, with a 95% percentile bootstrap interval: both groups are
 * resampled with replacement, `draws` times, from a seeded generator, so the interval is the same on every
 * run.
 */
function bootstrapDifference(a, b, { draws = 10000, seed = 20261014 } = {}) {
  const first = a.filter(Number.isFinite);
  const second = b.filter(Number.isFinite);
  if (first.length === 0 || second.length === 0) return { differenceMs: null, lowMs: null, highMs: null };
  const random = generator(seed);
  const resample = (values) => Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
  const differences = Array.from({ length: draws }, () => median(resample(second)) - median(resample(first)))
    .sort((x, y) => x - y);
  const at = (q) => differences[Math.min(draws - 1, Math.max(0, Math.round(q * (draws - 1))))];
  return { differenceMs: round(median(second) - median(first)), lowMs: round(at(0.025)), highMs: round(at(0.975)) };
}

/** The end-to-end time of each setup and each mixed cell against the Mac alone. */
function setupDifferences(rows, options = {}) {
  const used = timed(rows);
  const times = (test) => used.filter(test).map((row) => row.endToEndMs);
  const mac = times((row) => row.setup === 'mac-only');
  const line = (comparison, values) => ({ comparison, ...bootstrapDifference(mac, values, options) });
  return [
    line('phone-only vs mac-only', times((row) => row.setup === 'phone-only')),
    line('combined vs mac-only', times((row) => row.setup === 'combined')),
    ...['PP', 'MP', 'PM'].map((cell) => line(`${cell} vs MM`, times((row) => row.cell === cell))),
  ];
}

/** The steps each person makes, on the Mac against on the phone. */
function seatTable(rows) {
  const used = timed(rows);
  const line = (person, step, seat, value) => {
    const mac = used.filter((row) => row[seat] === 'mac').map(value).filter(Number.isFinite);
    const phone = used.filter((row) => row[seat] === 'phone').map(value).filter(Number.isFinite);
    const interval = bootstrapDifference(mac, phone);
    return {
      person, step, macN: mac.length, macMedianMs: median(mac), macMeanMs: mean(mac),
      phoneN: phone.length, phoneMedianMs: median(phone), phoneMeanMs: mean(phone),
      differenceMs: difference(median(phone), median(mac)), differenceLowMs: interval.lowMs, differenceHighMs: interval.highMs,
    };
  };
  return [
    line('officer', 'submit', 'officerSeat', (row) => row.submitMs),
    line('officer', 'outcome', 'officerSeat', (row) => row.outcomeMs),
    line('auditor', 'queue', 'auditorSeat', (row) => row.queueMs),
    line('auditor', 'review', 'auditorSeat', (row) => row.reviewMs),
    line('auditor', 'decision', 'auditorSeat', decisionOf),
    line('auditor', 'log', 'auditorSeat', (row) => row.logMs),
    line('auditor', 'all', 'auditorSeat', auditorWork),
  ];
}

/** Every workflow that ran, per cell: what was checked and what the model advised. */
function correctnessTable(rows, { planned = {} } = {}) {
  const line = (group, own) => {
    const checks = own.flatMap((row) => row.checks || []);
    return {
      group, planned: planned[group] === undefined ? null : planned[group], ran: own.length,
      completed: count(own, (row) => row.status === 'completed'),
      ledgerChecksPassed: count(checks, (check) => check.ok), ledgerChecksMade: checks.length,
      officerViewOk: count(own, (row) => row.officerOk === true),
      adviceAllow: count(own, (row) => row.advice === 'ALLOW'), adviceDeny: count(own, (row) => row.advice === 'DENY'),
      // Only workflows that reached the auditor: one that failed earlier had no advice to judge.
      noUsableAdvice: count(own, (row) => row.queueMs !== undefined && (row.advice === null || row.advice === undefined)),
      adviceMatchesPolicy: count(own, (row) => row.adviceMatchesPolicy === true),
      adviceAllowWherePolicyDenies: count(own, (row) => row.advice === 'ALLOW' && row.policyAnswer === 'DENY'),
      adviceDenyWherePolicyAllows: count(own, (row) => row.advice === 'DENY' && row.policyAnswer === 'ALLOW'),
      granted: count(own, (row) => row.outcome === 'GRANTED'), denied: count(own, (row) => row.outcome === 'DENIED'),
    };
  };
  const cells = CELLS.map(({ cell }) => cell).filter((cell) => rows.some((row) => row.cell === cell) || planned[cell] !== undefined);
  const lines = cells.map((cell) => line(cell, rows.filter((row) => row.cell === cell)));
  if (lines.length > 1) {
    const total = line('all', rows);
    total.planned = lines.every((entry) => entry.planned !== null) ? lines.reduce((all, entry) => all + entry.planned, 0) : null;
    lines.push(total);
  }
  return lines;
}

const officerSeatOf = (cell) => (String(cell).startsWith('M') ? 'mac' : 'phone');

/** A reviewed first request against the repeats that its authorization granted. */
function reuseTable(rows, states) {
  const line = (group, ownRows, ownStates) => {
    const firsts = ownRows.filter((row) => row.kind === 'first' && row.overridden === true && row.status === 'completed');
    const repeats = ownRows.filter((row) => row.kind === 'repeat');
    const reused = repeats.filter((row) => row.status === 'completed' && row.automatic === true);
    const first = median(firsts.map((row) => row.endToEndMs));
    const again = median(reused.map((row) => row.submitMs));
    const saved = first === null || again === null ? null : round(first - again);
    return {
      group, bases: ownStates.length,
      exercised: count(ownStates, (state) => state.status === 'done'),
      notExercised: count(ownStates, (state) => state.status === 'not-exercised'),
      failed: count(ownStates, (state) => state.status === 'failed'),
      firstRequestMedianMs: first, reusedRequestMedianMs: again, reusedOutcomeReadMedianMs: median(reused.map((row) => row.outcomeMs)),
      savedMs: saved, savedPercent: saved === null ? null : round((saved / first) * 100),
      repeatsGrantedAtOnce: count(repeats, (row) => row.reusedOk === true), repeats: repeats.length,
      nearMissGrantedAtOnce: count(ownRows, (row) => row.kind === 'nearMiss' && row.automatic === true),
      afterRevokeGrantedAtOnce: count(ownRows, (row) => row.kind === 'afterRevoke' && row.automatic === true),
    };
  };
  const bySeat = ['mac', 'phone'].map((seat) => line(`officer on ${seat}`,
    rows.filter((row) => row.officerSeat === seat), states.filter((state) => officerSeatOf(state.cell) === seat)));
  const byCell = CELLS.map(({ cell }) => cell).filter((cell) => states.some((state) => state.cell === cell))
    .map((cell) => line(cell, rows.filter((row) => row.cell === cell), states.filter((state) => state.cell === cell)));
  return [...bySeat, ...byCell, line('all', rows, states)];
}

/**
 * Every setup and level, with its repeats put together. The time until all were decided is per burst; the
 * per-request times pool every verified request of the repeats.
 */
function loadTable(bursts, rows = []) {
  const lines = [];
  const levels = [...new Set(bursts.map((burst) => burst.level))].sort((a, b) => a - b);
  for (const setup of SETUPS) {
    for (const level of levels) {
      const own = bursts.filter((burst) => burst.setup === setup && burst.level === level);
      if (own.length === 0) continue;
      const total = (name) => own.reduce((all, burst) => all + burst[name], 0);
      const makespans = own.map((burst) => burst.makespanMs).filter(Number.isFinite);
      const verified = rows.filter((row) => row.setup === setup && row.level === level && row.status === 'completed');
      // The LLM answers one request at a time: the gap between two advice commits of a burst is one
      // request's model time. The lag after it is the auditor's part.
      const gaps = own.flatMap((burst) => {
        const times = rows.filter((row) => row.burstId === burst.id && Number.isFinite(row.adviceReadyAfterMs))
          .map((row) => row.adviceReadyAfterMs).sort((a, b) => a - b);
        return times.slice(1).map((time, index) => time - times[index]);
      });
      const lag = describe(verified.map((row) => row.decidedAfterMs - row.adviceReadyAfterMs));
      const gap = describe(gaps);
      const pooled = (name) => describe(verified.map((row) => row[name]));
      const submit = pooled('submitMs');
      const decided = pooled('decidedAfterMs');
      const advice = pooled('adviceReadyAfterMs');
      const makespanMean = mean(makespans);
      lines.push({
        setup, level, bursts: own.length, requested: total('requested'), decided: total('decided'),
        verified: total('verified'), failed: total('failed'),
        makespanMeanMs: makespanMean, makespanMinMs: makespans.length ? Math.min(...makespans) : null,
        makespanMaxMs: makespans.length ? Math.max(...makespans) : null,
        secondsPerRequest: makespanMean === null ? null : round(makespanMean / level / 1000),
        decisionsPerMinuteMean: mean(own.map((burst) => burst.decisionsPerMinute)),
        pooledRequests: verified.length,
        submitMedianMs: submit && submit.median, submitP95Ms: submit && submit.p95, submitMaxMs: submit && submit.max,
        adviceReadyMedianMs: advice && advice.median, adviceReadyMaxMs: advice && advice.max,
        decidedAfterMedianMs: decided && decided.median, decidedAfterP95Ms: decided && decided.p95,
        decidedAfterMaxMs: decided && decided.max,
        adviceIntervalMedianMs: gap && gap.median, decisionLagMedianMs: lag && lag.median, decisionLagMaxMs: lag && lag.max,
        drainMeanMs: mean(own.map((burst) => burst.drainMs)),
      });
    }
  }
  return lines;
}

/** The hour of 100 officers in one line: every request, and the reads around them. */
function hourSummary(rows, reads = []) {
  const done = rows.filter((row) => row.status === 'completed');
  const pick = (value) => describe(done.map(value));
  const endToEnd = pick((row) => row.decidedAfterMs - row.sentAfterMs);
  const logReads = describe(reads.filter((read) => read.kind === 'access-log' && read.httpStatus === 200).map((read) => read.ms));
  return {
    requests: rows.length, completed: done.length, failed: rows.length - done.length,
    submitMedianMs: (pick((row) => row.submitMs) || {}).median,
    adviceWaitMedianMs: (pick((row) => row.adviceReadyAfterMs - row.sentAfterMs) || {}).median,
    inferenceMedianMs: (pick((row) => row.modelInferenceMs) || {}).median,
    decisionLagMedianMs: (pick((row) => row.decidedAfterMs - row.adviceReadyAfterMs) || {}).median,
    endToEndMedianMs: endToEnd && endToEnd.median, endToEndP95Ms: endToEnd && endToEnd.p95, endToEndMaxMs: endToEnd && endToEnd.max,
    outcomeReadMedianMs: (pick((row) => row.outcomeMs) || {}).median,
    accessLogReads: logReads ? logReads.n : 0, accessLogReadMedianMs: logReads && logReads.median,
    accessLogReadP95Ms: logReads && logReads.p95,
  };
}

/** The hour in windows of `windowMs`, by the moment each request was sent. */
function hourWindows(rows, windowMs = 600000) {
  const last = Math.max(0, ...rows.map((row) => row.sentAfterMs || 0));
  return Array.from({ length: Math.floor(last / windowMs) + 1 }, (_, index) => {
    const own = rows.filter((row) => Math.floor((row.sentAfterMs || 0) / windowMs) === index);
    const done = own.filter((row) => row.status === 'completed');
    const endToEnd = describe(done.map((row) => row.decidedAfterMs - row.sentAfterMs));
    return {
      fromMinute: (index * windowMs) / 60000, sent: own.length, completed: done.length,
      endToEndMedianMs: endToEnd && endToEnd.median, endToEndMaxMs: endToEnd && endToEnd.max,
    };
  });
}

/** Which part of the system a sampled container or process is. */
function partOf(sample) {
  if (sample.kind === 'host') return 'Mac (whole machine)';
  if (sample.kind === 'process') return sample.name.startsWith('emulator') ? 'phone emulators' : sample.name.replace('-', ' ');
  if (sample.name.startsWith('dev-peer')) return 'chaincode';
  if (sample.name.startsWith('peer')) return 'peers';
  if (sample.name.startsWith('couchdb')) return 'CouchDB';
  if (sample.name.startsWith('orderer')) return 'orderer';
  if (sample.name.startsWith('ca_')) return 'certificate authorities';
  return 'other containers';
}

/** CPU and memory of each part over a run: the parts' samples are added up per moment first. */
function resourceSummary(samples) {
  const byPart = new Map();
  for (const sample of samples) {
    const part = partOf(sample);
    const moments = byPart.get(part) || new Map();
    const moment = moments.get(sample.t) || { cpu: 0, memory: 0 };
    // The whole machine is sampled as its load average, the parts as % of one core.
    const cpu = sample.kind === 'host' ? sample.loadAverage1m : sample.cpuPercent;
    moment.cpu += Number.isFinite(cpu) ? cpu : 0;
    moment.memory += Number.isFinite(sample.memoryMiB) ? sample.memoryMiB : 0;
    moments.set(sample.t, moment);
    byPart.set(part, moments);
  }
  return [...byPart.entries()].map(([part, moments]) => {
    const cpu = describe([...moments.values()].map((moment) => moment.cpu));
    const memory = describe([...moments.values()].map((moment) => moment.memory));
    return {
      part, samples: moments.size, cpuMeanPercent: cpu && cpu.mean, cpuP95Percent: cpu && cpu.p95, cpuMaxPercent: cpu && cpu.max,
      memoryMeanMiB: memory && memory.mean, memoryMaxMiB: memory && memory.max,
      cpuUnit: part === 'Mac (whole machine)' ? 'load average (1 min)' : '% of one core',
    };
  });
}

/** The balanced decision test of one model, as one line. */
function qualityRow(metrics, set = 'test-decision-balanced') {
  const result = metrics.sets[set];
  return {
    label: metrics.label, modelId: metrics.model.modelId, adapterId: metrics.model.adapterId,
    promptVersion: metrics.promptVersion, examples: result.examples, validAnswers: result.schemaValid,
    decisionAccuracy: result.decisionAccuracy, accuracyLow: result.decisionAccuracyCI.low,
    accuracyHigh: result.decisionAccuracyCI.high, balancedAccuracy: result.balancedAccuracy, macroF1: result.macroF1,
    falseAllow: result.falseAllow.count, falseAllowRate: result.falseAllow.ofDenyExamples,
    falseDeny: result.falseDeny.count, falseDenyRate: result.falseDeny.ofAllowExamples,
    reasonCodeAccuracy: result.reasonCodeAccuracy, latencyMedianMs: result.latencyMs.median, latencyP95Ms: result.latencyMs.p95,
  };
}

/** A table as CSV: one header line from the first row, text quoted where it must be. */
function csv(rows) {
  if (rows.length === 0) return '';
  const names = Object.keys(rows[0]);
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${[names.join(','), ...rows.map((row) => names.map((name) => cell(row[name])).join(','))].join('\n')}\n`;
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : null);

function main() {
  const argv = process.argv.slice(2);
  const read = (name) => (argv.indexOf(`--${name}`) === -1 ? undefined : argv[argv.indexOf(`--${name}`) + 1]);
  const opts = { run: read('run'), plan: read('plan'), tables: read('tables'), date: read('date'), label: read('label') };
  if (Object.values(opts).some((value) => !value)) {
    throw new Error('usage: setup-analyze.js --run DIR --plan plan.json --tables DIR --date YYYYMMDD --label NAME');
  }
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  const analysis = { label: opts.label, planSha256: plan.sha256, analyzedAtUtc: new Date().toISOString() };
  const tables = {};

  const steps = readRows(path.join(opts.run, 'steps', 'rows.jsonl'));
  if (steps) {
    const planned = Object.fromEntries(CELLS.map(({ cell }) => [cell, plan.steps.items.filter((item) => item.cell === cell).length]));
    tables.steps_by_cell = stepsTable(steps);
    tables.steps_by_seat = seatTable(steps);
    tables.steps_setup_differences = setupDifferences(steps);
    tables.steps_correctness = correctnessTable(steps, { planned });
    analysis.steps = { run: readJson(path.join(opts.run, 'steps', 'run.json')), usedForTimes: timed(steps).length, ran: steps.length };
  }
  const reuse = readRows(path.join(opts.run, 'reuse', 'rows.jsonl'));
  const reuseRun = readJson(path.join(opts.run, 'reuse', 'run.json'));
  if (reuse && reuseRun && reuseRun.bases) {
    tables.reuse = reuseTable(reuse, reuseRun.bases);
    analysis.reuse = { run: reuseRun };
  }
  const bursts = readJson(path.join(opts.run, 'load', 'bursts.json'));
  if (bursts) {
    tables.load = loadTable(bursts, readRows(path.join(opts.run, 'load', 'rows.jsonl')) || []);
    analysis.load = { run: readJson(path.join(opts.run, 'load', 'run.json')), bursts };
  }
  const hour = readRows(path.join(opts.run, 'hour', 'rows.jsonl'));
  if (hour) {
    const reads = readRows(path.join(opts.run, 'hour', 'reads.jsonl')) || [];
    tables.hour_summary = [hourSummary(hour, reads)];
    tables.hour_windows = hourWindows(hour);
    const samples = readRows(path.join(opts.run, 'hour', 'resources.jsonl'));
    if (samples) tables.hour_resources = resourceSummary(samples);
    analysis.hour = { run: readJson(path.join(opts.run, 'hour', 'run.json')) };
  }
  const bursts100 = readJson(path.join(opts.run, 'bursts100', 'bursts.json'));
  if (bursts100) {
    tables.bursts100 = loadTable(bursts100, readRows(path.join(opts.run, 'bursts100', 'rows.jsonl')) || []);
    const samples = readRows(path.join(opts.run, 'bursts100', 'resources.jsonl'));
    if (samples) tables.bursts100_resources = resourceSummary(samples);
  }
  const quality = readJson(path.join(opts.run, 'quality', 'metrics.json'));
  if (quality) tables.model_quality = [qualityRow(quality)];

  fs.mkdirSync(opts.tables, { recursive: true });
  for (const [name, rows] of Object.entries(tables)) {
    fs.writeFileSync(path.join(opts.tables, `${opts.date}_setups_${opts.label}_${name}.csv`), csv(rows));
  }
  fs.writeFileSync(path.join(opts.run, 'analysis.json'), `${JSON.stringify({ ...analysis, tables }, null, 1)}\n`);
  for (const [name, rows] of Object.entries(tables)) {
    console.log(`\n${name}`);
    console.table(rows);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {
  bootstrapDifference, correctnessTable, csv, hourSummary, hourWindows, loadTable, qualityRow, resourceSummary, reuseTable,
  seatTable, setupDifferences, stepsTable, timed,
};
