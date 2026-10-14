'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  correctnessTable, csv, loadTable, qualityRow, reuseTable, seatTable, stepsTable, timed,
} = require('./setup-analyze');

const step = (cell, officerSeat, auditorSeat, change = {}) => ({
  cell, setup: cell === 'MM' ? 'mac-only' : cell === 'PP' ? 'phone-only' : 'combined', officerSeat, auditorSeat,
  status: 'completed', followed: true, submitMs: 2000, recommendationMs: 9000, modelInferenceMs: 7000, queueMs: 40,
  reviewMs: 10, decisionMs: 2100, readbackMs: 10, endToEndMs: 13160, logMs: 100, outcomeMs: 50,
  quietBeforeRequestMs: 8000, quietBeforeDecisionMs: 4000, advice: 'DENY', policyAnswer: 'DENY', adviceMatchesPolicy: true,
  outcome: 'DENIED', ledgerOk: true, officerOk: true, checks: Array(9).fill({ ok: true }), ...change,
});

test('times use only workflows that completed, passed every check and had usable advice', () => {
  const rows = [step('MM', 'mac', 'mac'), step('MM', 'mac', 'mac', { status: 'check-failed' }),
    step('MM', 'mac', 'mac', { followed: false }), step('MM', 'mac', 'mac', { status: 'failed', endToEndMs: undefined })];
  assert.equal(timed(rows).length, 1);
});

test('the step table has one line per cell and per setup, with the stages of the end-to-end time', () => {
  const rows = [step('MM', 'mac', 'mac'), step('MM', 'mac', 'mac', { endToEndMs: 14160, submitMs: 3000 }),
    step('PP', 'phone', 'phone', { endToEndMs: 15000 }), step('MP', 'mac', 'phone'), step('PM', 'phone', 'mac', { endToEndMs: 12000 })];
  const table = stepsTable(rows);
  assert.deepEqual(table.map((line) => line.group), ['MM', 'PP', 'MP', 'PM', 'mac-only', 'phone-only', 'combined', 'all']);
  const mm = table[0];
  // The median of an even count averages the two middle values.
  assert.deepEqual([mm.n, mm.endToEndMedianMs, mm.endToEndMeanMs, mm.endToEndMaxMs], [2, 13660, 13660, 14160]);
  assert.equal(mm.submitMedianMs, 2500);
  assert.equal(mm.decisionMedianMs, 2110, 'the decision stage holds the readback');
  assert.equal(table.find((line) => line.group === 'combined').n, 2);
  assert.equal(table.find((line) => line.group === 'all').n, 5);
});

test('each seat is compared between the Mac and the phone on the steps that person makes', () => {
  const rows = [step('MM', 'mac', 'mac'), step('PM', 'phone', 'mac', { submitMs: 2300, outcomeMs: 250 }),
    step('MP', 'mac', 'phone', { queueMs: 560, decisionMs: 2140, readbackMs: 0, logMs: 170 }),
    step('PP', 'phone', 'phone', { submitMs: 2300, outcomeMs: 250, queueMs: 560, decisionMs: 2140, readbackMs: 0, logMs: 170 })];
  const table = seatTable(rows);
  const line = (person, stepName) => table.find((entry) => entry.person === person && entry.step === stepName);
  assert.deepEqual([line('officer', 'submit').macMedianMs, line('officer', 'submit').phoneMedianMs, line('officer', 'submit').differenceMs],
    [2000, 2300, 300]);
  assert.equal(line('officer', 'outcome').differenceMs, 200);
  assert.equal(line('auditor', 'queue').differenceMs, 520);
  assert.equal(line('auditor', 'decision').differenceMs, 30);
  assert.equal(line('auditor', 'all').macMedianMs, 2260);
  assert.deepEqual([line('auditor', 'all').macN, line('auditor', 'all').phoneN], [2, 2]);
});

test('correctness counts every workflow, also those left out of the times', () => {
  const rows = [step('MM', 'mac', 'mac'), step('MM', 'mac', 'mac', { status: 'check-failed', ledgerOk: false,
    checks: [...Array(8).fill({ ok: true }), { ok: false }] }),
  step('MM', 'mac', 'mac', { advice: 'ALLOW', policyAnswer: 'DENY', adviceMatchesPolicy: false, outcome: 'GRANTED' }),
  step('MM', 'mac', 'mac', { advice: null, adviceMatchesPolicy: null, followed: false })];
  const [mm] = correctnessTable(rows, { planned: { MM: 5 } });
  assert.deepEqual([mm.planned, mm.ran, mm.completed, mm.ledgerChecksPassed, mm.ledgerChecksMade], [5, 4, 3, 35, 36]);
  assert.deepEqual([mm.adviceAllow, mm.adviceDeny, mm.noUsableAdvice], [1, 2, 1]);
  const early = correctnessTable([step('MM', 'mac', 'mac', { status: 'failed', advice: undefined, queueMs: undefined })]);
  assert.equal(early[0].noUsableAdvice, 0, 'a workflow that failed before the auditor is not counted as without advice');
  assert.deepEqual([mm.adviceMatchesPolicy, mm.adviceAllowWherePolicyDenies, mm.granted], [2, 1, 1]);
});

test('the reuse table sets a reviewed first request against its repeats, per officer seat', () => {
  const request = (kind, officerSeat, change = {}) => ({
    kind, officerSeat, cell: officerSeat === 'mac' ? 'MM' : 'PP', status: 'completed', baseId: `R-${officerSeat}`, ...change,
  });
  const rows = [
    request('first', 'mac', { endToEndMs: 13000, overridden: true, authorizationId: 'AUTH-1' }),
    request('repeat', 'mac', { submitMs: 2000, automatic: true, reusedOk: true }),
    request('repeat', 'mac', { submitMs: 2200, automatic: true, reusedOk: true }),
    request('nearMiss', 'mac', { automatic: false }), request('afterRevoke', 'mac', { automatic: false }),
    request('first', 'phone', { endToEndMs: 14000, overridden: false }),
  ];
  const states = [{ id: 'R-mac', cell: 'MM', status: 'done' }, { id: 'R-phone', cell: 'PP', status: 'not-exercised' }];
  const table = reuseTable(rows, states);
  const mac = table.find((line) => line.group === 'officer on mac');
  assert.deepEqual([mac.bases, mac.exercised, mac.notExercised], [1, 1, 0]);
  assert.deepEqual([mac.firstRequestMedianMs, mac.reusedRequestMedianMs, mac.savedMs, mac.savedPercent], [13000, 2100, 10900, 83.8]);
  assert.deepEqual([mac.repeatsGrantedAtOnce, mac.repeats, mac.nearMissGrantedAtOnce, mac.afterRevokeGrantedAtOnce], [2, 2, 0, 0]);
  const phone = table.find((line) => line.group === 'officer on phone');
  assert.deepEqual([phone.exercised, phone.notExercised, phone.reusedRequestMedianMs, phone.savedMs], [0, 1, null, null]);
  assert.equal(table.find((line) => line.group === 'all').repeats, 2);
});

test('the load table keeps the burst times per burst and pools the per-request times', () => {
  const burst = (setup, level, repeat, makespanMs) => ({
    setup, level, repeat, requested: level, decided: level, verified: level, failed: 0, makespanMs,
    decisionsPerMinute: Math.round((level / makespanMs) * 600000) / 10, drainMs: 30000,
  });
  const row = (setup, level, submitMs, decidedAfterMs, status = 'completed') => ({
    setup, level, status, submitMs, decidedAfterMs, adviceReadyAfterMs: decidedAfterMs - 2000 });
  const rows = [row('mac-only', 5, 2000, 10000), row('mac-only', 5, 2200, 20000), row('mac-only', 5, 2400, 30000),
    row('mac-only', 5, 2600, 40000), row('mac-only', 5, 9999, 99999, 'check-failed'), row('phone-only', 5, 2100, 15000)];
  const table = loadTable([burst('mac-only', 5, 1, 50000), burst('mac-only', 5, 2, 54000), burst('phone-only', 5, 1, 60000)], rows);
  assert.deepEqual(table.map((line) => `${line.setup}/${line.level}`), ['mac-only/5', 'phone-only/5']);
  const mac = table[0];
  assert.deepEqual([mac.bursts, mac.requested, mac.verified, mac.failed], [2, 10, 10, 0]);
  assert.deepEqual([mac.makespanMeanMs, mac.makespanMinMs, mac.makespanMaxMs], [52000, 50000, 54000]);
  assert.equal(mac.secondsPerRequest, 10.4);
  assert.equal(mac.pooledRequests, 4, 'a request that failed its check is not pooled');
  assert.deepEqual([mac.submitMedianMs, mac.submitMaxMs, mac.decidedAfterMedianMs, mac.decidedAfterMaxMs], [2300, 2600, 25000, 40000]);
  assert.equal(table[1].decidedAfterMedianMs, 15000);
  // Rows without a burst id give no interval; the lag is decided minus advice ready.
  assert.equal(mac.decisionLagMedianMs, 2000);
  const withBursts = loadTable([{ ...burst('mac-only', 5, 1, 50000), id: 'B1' }],
    [10000, 19000, 29000].map((advice) => ({ ...row('mac-only', 5, 2000, advice + 2000), adviceReadyAfterMs: advice, burstId: 'B1' })));
  assert.equal(withBursts[0].adviceIntervalMedianMs, 9500);
});

test('the quality row reads the balanced decision test of one model', () => {
  const metrics = { label: 'untuned', promptVersion: 'dias-recommendation-prompt-v2', model: { modelId: 'm', adapterId: null },
    sets: { 'test-decision-balanced': { examples: 600, schemaValid: 598, decisionAccuracy: 0.9, balancedAccuracy: 0.91, macroF1: 0.9,
      decisionAccuracyCI: { low: 0.87, high: 0.92 }, falseAllow: { count: 4, ofDenyExamples: 0.013 },
      falseDeny: { count: 55, ofAllowExamples: 0.18 }, reasonCodeAccuracy: 0.5, latencyMs: { median: 8000, p95: 11000 } } } };
  assert.deepEqual(qualityRow(metrics), { label: 'untuned', modelId: 'm', adapterId: null,
    promptVersion: 'dias-recommendation-prompt-v2', examples: 600, validAnswers: 598, decisionAccuracy: 0.9,
    accuracyLow: 0.87, accuracyHigh: 0.92, balancedAccuracy: 0.91, macroF1: 0.9, falseAllow: 4, falseAllowRate: 0.013,
    falseDeny: 55, falseDenyRate: 0.18, reasonCodeAccuracy: 0.5, latencyMedianMs: 8000, latencyP95Ms: 11000 });
});

test('a table is written as CSV with a header and quoted text', () => {
  assert.equal(csv([{ group: 'MM', n: 2, note: 'a, b' }, { group: 'PP', n: null, note: 'say "x"' }]),
    'group,n,note\nMM,2,"a, b"\nPP,,"say ""x"""\n');
  assert.equal(csv([]), '');
});

const { bootstrapDifference, setupDifferences } = require('./setup-analyze');

test('the difference of two medians comes with a seeded 95% bootstrap interval', () => {
  const mac = [100, 102, 98, 101, 99, 100, 103, 97, 100, 101];
  const phone = mac.map((value) => value + 60);
  const shifted = bootstrapDifference(mac, phone, { draws: 2000, seed: 1 });
  assert.equal(shifted.differenceMs, 60);
  assert.ok(shifted.lowMs <= 60 && shifted.highMs >= 60 && shifted.highMs - shifted.lowMs < 10);
  assert.deepEqual(bootstrapDifference(mac, phone, { draws: 2000, seed: 1 }), shifted, 'the same seed gives the same interval');
  const same = bootstrapDifference(mac, mac, { draws: 2000, seed: 1 });
  assert.equal(same.differenceMs, 0);
  assert.ok(same.lowMs <= 0 && same.highMs >= 0);
  assert.equal(bootstrapDifference([], phone).differenceMs, null);
});

test('each setup is compared with the Mac alone on the end-to-end time', () => {
  const row = (cell, setup, endToEndMs) => ({ cell, setup, endToEndMs, status: 'completed', followed: true });
  const rows = [row('MM', 'mac-only', 13000), row('MM', 'mac-only', 13100), row('PP', 'phone-only', 13300),
    row('PP', 'phone-only', 13400), row('MP', 'combined', 13100), row('PM', 'combined', 13200)];
  const table = setupDifferences(rows, { draws: 500, seed: 3 });
  assert.deepEqual(table.map((line) => line.comparison), ['phone-only vs mac-only', 'combined vs mac-only',
    'PP vs MM', 'MP vs MM', 'PM vs MM']);
  assert.equal(table[0].differenceMs, 300);
  assert.equal(table[1].differenceMs, 100);
});

const { adviceAgreement, pairSteps, pairedDifference } = require('./setup-compare');

test('the two models are compared request by request on the same plan', () => {
  const untuned = [{ id: 'S-1', modelInferenceMs: 7000, advice: 'DENY', adviceMatchesPolicy: true, policyAnswer: 'DENY' },
    { id: 'S-2', modelInferenceMs: 6000, advice: 'ALLOW', adviceMatchesPolicy: false, policyAnswer: 'DENY' },
    { id: 'S-3', modelInferenceMs: 6500, advice: null, policyAnswer: 'ALLOW' }];
  const v7 = [{ id: 'S-2', modelInferenceMs: 8000, advice: 'DENY', adviceMatchesPolicy: true, policyAnswer: 'DENY' },
    { id: 'S-1', modelInferenceMs: 8500, advice: 'DENY', adviceMatchesPolicy: true, policyAnswer: 'DENY' }];
  const pairs = pairSteps(untuned, v7);
  assert.deepEqual(pairs.map(([a, b]) => [a.id, b.id]), [['S-1', 'S-1'], ['S-2', 'S-2']], 'a request only one model ran is left out');
  const inference = pairedDifference(pairs, (row) => row.modelInferenceMs, { draws: 500, seed: 2 });
  assert.equal(inference.n, 2);
  assert.equal(inference.median, 1750);
  assert.ok(inference.low <= 1750 && inference.high >= 1750);
  assert.deepEqual(adviceAgreement(pairs), { requests: 2, bothAnswered: 2, sameAdvice: 1, untunedMatchesPolicy: 1,
    v7MatchesPolicy: 2, untunedAllowWherePolicyDenies: 1, v7AllowWherePolicyDenies: 0, untunedNoUsableAdvice: 0, v7NoUsableAdvice: 0 });
  assert.equal(pairedDifference([], (row) => row.x).median, null);
});

const { hourSummary, hourWindows, resourceSummary } = require('./setup-analyze');

test('the hour is summarized per request and per ten-minute window', () => {
  const row = (sentAfterMs, adviceReadyAfterMs, decidedAfterMs, status = 'completed') => ({ status, sentAfterMs,
    submitMs: 2100, adviceReadyAfterMs, decidedAfterMs, outcomeMs: 40, recommendationMs: adviceReadyAfterMs - sentAfterMs - 2100,
    modelInferenceMs: 7000 });
  const rows = [row(0, 11000, 13300), row(60000, 71000, 73200), row(700000, 711000, 713300), row(710000, 0, 0, 'failed')];
  const summary = hourSummary(rows, [{ kind: 'access-log', httpStatus: 200, ms: 150 }, { kind: 'access-log', httpStatus: 200, ms: 250 }]);
  assert.deepEqual([summary.requests, summary.completed, summary.failed], [4, 3, 1]);
  assert.equal(summary.endToEndMedianMs, 13300, 'from sending to the committed decision');
  assert.equal(summary.decisionLagMedianMs, 2300);
  assert.equal(summary.accessLogReadMedianMs, 200);
  const windows = hourWindows(rows, 600000);
  assert.deepEqual(windows.map((window) => [window.fromMinute, window.sent, window.completed]), [[0, 2, 2], [10, 2, 1]]);
});

test('resources are summarized per part, with the components of the Fabric network grouped', () => {
  const sample = (t, name, cpuPercent, memoryMiB, kind = 'container') => ({ t, kind, name, cpuPercent, memoryMiB });
  const samples = [sample(1, 'peer0.police.example.com', 10, 100), sample(1, 'peer0.court.example.com', 20, 120),
    sample(2, 'peer0.police.example.com', 30, 110), sample(2, 'peer0.court.example.com', 40, 130),
    sample(1, 'model-server', 50, 8000, 'process'), sample(2, 'model-server', 70, 8100, 'process')];
  const table = resourceSummary(samples);
  const peers = table.find((line) => line.part === 'peers');
  assert.deepEqual([peers.samples, peers.cpuMeanPercent, peers.cpuMaxPercent, peers.memoryMaxMiB], [2, 50, 70, 240]);
  assert.equal(table.find((line) => line.part === 'model server').cpuMeanPercent, 60);
  const host = resourceSummary([{ t: 1, kind: 'host', name: 'mac', loadAverage1m: 4, memoryMiB: 40000 },
    { t: 2, kind: 'host', name: 'mac', loadAverage1m: 6, memoryMiB: 41000 }])[0];
  assert.deepEqual([host.part, host.cpuMeanPercent, host.cpuUnit], ['Mac (whole machine)', 5, 'load average (1 min)']);
});
