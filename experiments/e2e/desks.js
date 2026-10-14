'use strict';

/**
 * The two surfaces an officer or an auditor can sit at in the three-setup experiment, behind one interface
 * each.
 */

const path = require('path');
const { execFile, spawn } = require('child_process');
const { adviceDecision, now, parseInstrumentation, round, sleep } = require('./lib');

const ADB = process.env.ADB || path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const PHONE_API = process.env.DIAS_PHONE_API_URL || 'http://10.0.2.2:3001';
const APP_ID = 'org.dias.mobile.dev';
const PHONE_TEST = 'org.dias.mobile.screen.PhoneSessionTest#aPersonServesTheExperimentFromThePhone';
const RUNNER = `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;
/** What the phone app sends with every call (`ApiClient.kt`). */
const PHONE_HEADERS = Object.freeze({
  Accept: 'application/json', 'User-Agent': 'DIAS-Mobile/0.1', 'ngrok-skip-browser-warning': 'true',
});

/** Free text for a phone command: URL-safe base64, so it survives the shell untouched. */
const encoded = (text) => Buffer.from(String(text), 'utf8').toString('base64url');

const adb = (serial, args, timeout = 30000) => new Promise((resolve) => {
  execFile(ADB, ['-s', serial, ...args], { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => resolve({ error, stdout: stdout || '' }));
});

/**
 * One phone: an instrumented session on one emulator, commanded through small files in the app's own
 * folder.
 */
function phoneSession({ serial, username, label = 'phone' }) {
  const name = `${label}-${Date.now()}`;
  const folder = `cache/evidence/session-${name}`;
  let child = null;
  let output = '';
  let exited = null;
  let sent = 0;
  let turn = Promise.resolve();

  async function read(file, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const result = await adb(serial, ['exec-out', 'run-as', APP_ID, 'cat', `${folder}/${file}`]);
      if (result.stdout.trim().startsWith('{')) return JSON.parse(result.stdout);
      if (exited !== null) throw new Error(`the ${label} session ended: ${parseInstrumentation(output).detail}`);
      if (now() > deadline) throw new Error(`no ${file} from the ${label} within ${timeoutMs} ms`);
      await sleep(120);
    }
  }

  const write = async (text) => {
    sent += 1;
    const file = `${folder}/cmd-${sent}`;
    const result = await adb(serial, ['shell', 'run-as', APP_ID, 'sh', '-c', `'echo ${text} > ${file}.tmp && mv ${file}.tmp ${file}'`]);
    // A command that never reached the phone would leave every later answer one step behind.
    if (result.error) throw new Error(`the ${label} did not receive command ${sent}: ${result.error.message}`);
    return sent;
  };

  return {
    serial, label,
    async start() {
      child = spawn(ADB, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', PHONE_TEST,
        '-e', 'apiBase', PHONE_API, '-e', 'username', username, '-e', 'experimentSession', name, RUNNER]);
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      exited = null;
      child.on('exit', (code) => { exited = code; });
      return read('ready.json', 90000);
    },
    /**
     * Send one command and wait for its answer; commands of one phone never overlap. An answer with an
     * error is thrown.
     */
    command(text, timeoutMs = 240000) {
      if (!/^[A-Za-z0-9 ._-]+$/.test(text)) return Promise.reject(new Error(`unsafe phone command: ${text}`));
      const run = turn.then(async () => {
        const number = await write(text);
        const answer = await read(`res-${number}.json`, timeoutMs);
        if (answer.error) throw new Error(`${label}: ${answer.error}`);
        return answer;
      });
      turn = run.catch(() => {});
      return run;
    },
    async stop() {
      if (!child || exited !== null) return parseInstrumentation(output);
      await turn;
      await write('stop');
      const deadline = now() + 30000;
      while (exited === null && now() < deadline) await sleep(200);
      if (exited === null) child.kill();
      return parseInstrumentation(output);
    },
  };
}

/** What a submitted request tells the officer, whichever surface sent it. */
function submission({ httpStatus, data, error, ms }) {
  const accepted = (httpStatus === 201 || httpStatus === 202) && data && data.requestId;
  if (!accepted) throw new Error(`submit ${httpStatus}: ${error || (data && data.message) || 'no request id'}`);
  const check = data.dynamicAuthorizationCheck || {};
  const automatic = data.processingPath === 'dynamic-authorization';
  return {
    submitMs: round(ms), submitStatus: httpStatus, requestId: data.requestId, automatic,
    authorizationId: automatic && check.matched ? check.authorizationId : null,
  };
}

/** An officer at the Mac: the portal's calls. Every officer is signed in before the run starts. */
function macOfficer(client) {
  return {
    surface: 'mac-api',
    async prepare(username) { await client.login(username); return {}; },
    async submit(item) {
      const sent = await client.post('/access/request', item.username, {
        recordId: item.recordId, action: item.action, purpose: item.purpose, justification: item.justification,
      });
      return submission({ httpStatus: sent.status, data: sent.data, error: sent.error, ms: sent.ms });
    },
    /**
     * What the portal reads to show a settled request: the request, its decision record, what this officer
     * may read of the auditor's decision, and, after a granted view, the case-file metadata that grant
     * releases.
     */
    async outcome(item, requestId) {
      const calls = [await client.get(`/access/request/${requestId}`, item.username)];
      const request = calls[0].data || {};
      const state = String(request.status || '').toUpperCase();
      let explanationShown = false;
      if (calls[0].status === 200 && request.outcomeId) {
        calls.push(await client.get(`/access/decision/${request.recordId}/${request.outcomeId}`, item.username));
        if (request.processingPath !== 'dynamic-authorization') {
          const detail = await client.get(`/access/request/${requestId}/recommendation`, item.username);
          calls.push(detail);
          explanationShown = Boolean(detail.data && detail.data.explanationVisible && detail.data.reason);
        }
        if (request.status === 'granted' && request.action === 'view') {
          calls.push(await client.get(`/records/${request.recordId}/metadata/${request.outcomeId}`, item.username));
        }
      }
      const failed = calls.find((call) => call.status !== 200);
      if (failed) throw new Error(`outcome read ${failed.status}: ${failed.error}`);
      return {
        outcomeMs: round(calls.reduce((sum, call) => sum + call.ms, 0)), outcomeCalls: calls.length,
        officerSees: state, explanationShown,
      };
    },
  };
}

/**
 * An officer at the phone. The phone signs in as the workflow's officer before the step is timed;
 * `signedInAs` is who the session signed in when it started.
 */
function phoneOfficer(phone, signedInAs = null) {
  let signedIn = signedInAs;
  return {
    surface: 'phone-ui',
    async prepare(username) {
      if (signedIn === username) return {};
      const answer = await phone.command(`signin ${username}`);
      signedIn = username;
      return { officerSignInMs: round(answer.signInMs) };
    },
    async submit(item) {
      const sent = await phone.command(
        `request ${item.recordId} ${item.action} ${item.purpose} ${encoded(item.justification)}`);
      const automatic = sent.automatic === true;
      const authorization = automatic ? /reusable authorization (\S+?)\. /.exec(sent.message) : null;
      return {
        submitMs: round(sent.submitMs), submitStatus: automatic ? 201 : 202, requestId: sent.requestId, automatic,
        authorizationId: authorization ? authorization[1] : null,
      };
    },
    async outcome(_item, requestId) {
      const seen = await phone.command(`status ${requestId}`);
      return {
        outcomeMs: round(seen.statusMs), outcomeCalls: null,
        officerSees: String(seen.state || '').toUpperCase(), explanationShown: seen.explanationShown === true,
      };
    },
  };
}

/** The newest entry as the access log orders it: by decision time, then by request number. */
function newestEntry(entries) {
  const time = (entry) => String(entry.decidedAtUtc || entry.submittedAtUtc);
  return [...entries].sort((a, b) => time(b).localeCompare(time(a))
    || String(b.requestId).localeCompare(String(a.requestId)))[0] || {};
}

/** An auditor at the Mac: the calls the portal's auditor screen makes, each timed. */
function macAuditor(client, auditor) {
  const reviews = new Map();

  async function send(requestId, decision, reason, { readLog }) {
    const decided = await client.post(`/access/auditor/${requestId}/decision`, auditor, { decision, reason });
    if (decided.status !== 201) throw new Error(`decision ${decided.status}: ${decided.error}`);
    const outcome = decided.data.accessOutcome || {};
    // The auditor's screen reads the request back before it shows the result as confirmed.
    const readback = await client.get(`/access/request/${requestId}`, auditor);
    const result = {
      auditorSurface: 'mac-api', decisionMs: round(decided.ms), readbackMs: round(readback.ms),
      decision, outcome: outcome.outcome, outcomeId: outcome.outcomeId,
      authorizationId: (decided.data.dynamicAuthorization && decided.data.dynamicAuthorization.authorizationId) || null,
      readbackOk: readback.status === 200 && readback.data.outcomeId === outcome.outcomeId,
    };
    if (!readLog) return result;
    const log = await client.get('/access/workflow-log?limit=100', auditor);
    const newest = log.status === 200 ? newestEntry(log.data.entries) : {};
    return {
      ...result, logMs: round(log.ms),
      logOk: newest.requestId === requestId && newest.decision === decision && newest.outcome === outcome.outcome
        && Boolean(newest.auditor) && newest.auditor.username === auditor,
    };
  }

  const adviceOf = (review) => {
    const commitment = review.commitment || {};
    return {
      recommendationState: review.recommendationState, integrity: review.integrity && review.integrity.status,
      generationStatus: commitment.generationStatus, recommendation: commitment.recommendation,
    };
  };

  return {
    surface: 'mac-api',
    async open(requestId) {
      const queue = await client.get('/access/auditor/pending', auditor);
      if (queue.status !== 200) throw new Error(`queue ${queue.status}: ${queue.error}`);
      const review = await client.get(`/access/auditor/${requestId}`, auditor);
      if (review.status !== 200) throw new Error(`review ${review.status}: ${review.error}`);
      reviews.set(requestId, review.data);
      const advice = adviceOf(review.data);
      return {
        queueMs: round(queue.ms), reviewMs: round(review.ms), pendingShown: queue.data.length,
        adviceShown: adviceDecision(advice).followed ? advice.recommendation : null,
      };
    },
    /** Follow the advice of the open review. */
    async decide(requestId, { readLog = true } = {}) {
      const chosen = adviceDecision(adviceOf(reviews.get(requestId)));
      reviews.delete(requestId);
      return { ...await send(requestId, chosen.decision, chosen.reason || '', { readLog }), followed: chosen.followed };
    },
    /** Grant against a committed DENY: this creates the exact-scope reusable authorization. */
    async override(requestId, reason) {
      const advice = adviceOf(reviews.get(requestId));
      if (!adviceDecision(advice).followed || advice.recommendation !== 'DENY') {
        throw new Error('an override needs a committed and verified DENY');
      }
      reviews.delete(requestId);
      return { ...await send(requestId, 'FORCE_ALLOW', reason, { readLog: true }), followed: false };
    },
  };
}

/** An auditor at the phone: the same steps on the screen. Its decision time holds the readback. */
function phoneAuditor(phone) {
  const shaped = (requestId, answer) => {
    if (answer.requestId !== requestId) throw new Error('the phone answered for another request');
    const result = {
      auditorSurface: 'phone-ui', decisionMs: round(answer.decisionMs), readbackMs: 0,
      decision: answer.decision, outcome: answer.outcome, outcomeId: answer.outcomeId || null,
      authorizationId: answer.authorizationId || null, followed: answer.followed === true,
      readbackOk: Boolean(answer.outcomeId),
    };
    if (answer.logMs === undefined) return result;
    return {
      ...result, logMs: round(answer.logMs),
      logOk: Boolean(answer.logFirstRowIsThisRequest && answer.logShowsDecision && answer.logShowsOutcome),
    };
  };
  return {
    surface: 'phone-ui',
    async open(requestId) {
      const opened = await phone.command(`open ${requestId}`);
      return {
        queueMs: round(opened.queueMs), reviewMs: round(opened.reviewMs), pendingShown: opened.pendingShown,
        adviceShown: ['ALLOW', 'DENY'].includes(opened.advice) ? opened.advice : null,
      };
    },
    async decide(requestId, { readLog = true } = {}) {
      return shaped(requestId, await phone.command(`decide ${requestId}${readLog ? '' : ' nolog'}`));
    },
    async override(requestId, reason) {
      return shaped(requestId, await phone.command(`override ${requestId} ${encoded(reason)}`));
    },
  };
}

module.exports = {
  PHONE_HEADERS, encoded, macAuditor, macOfficer, newestEntry, phoneAuditor, phoneOfficer, phoneSession, submission,
};
