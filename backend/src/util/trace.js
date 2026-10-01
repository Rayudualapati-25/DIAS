'use strict';

/**
 * Experiment timing trace.
 *
 * Off unless DIAS_TRACE_FILE names a file. When it is on, each traced step
 * appends one JSON line saying what ran, for which request, when, and how long
 * each of its stages took. The multi-machine testbed reads these lines to split
 * the end-to-end workflow time into its components. Nothing in the application
 * reads them back, and no request payload, justification or token is written:
 * only identifiers, stage names and durations.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

let traceFile = process.env.DIAS_TRACE_FILE || '';
let stream = null;

const round = (value) => Math.round(value * 1000) / 1000;

function enabled() {
  return traceFile !== '';
}

/** Epoch milliseconds with sub-millisecond resolution, monotonic within the process. */
function now() {
  return performance.timeOrigin + performance.now();
}

function open() {
  if (!stream) {
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    stream = fs.createWriteStream(traceFile, { flags: 'a' });
    stream.on('error', (error) => {
      // A broken trace must never break a request: report it once and stop tracing.
      console.error(`[trace] disabled after write error: ${error.message}`);
      traceFile = '';
      stream = null;
    });
  }
  return stream;
}

/** Append one event. Durations are rounded to microseconds. */
function emit(event, fields = {}) {
  if (!enabled()) return;
  const record = { event, at: round(now()), pid: process.pid };
  for (const [key, value] of Object.entries(fields)) {
    record[key] = typeof value === 'number' ? round(value) : value;
  }
  open().write(`${JSON.stringify(record)}\n`);
}

/** Flush and close the trace; used by tests and on shutdown. */
function close() {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    const closing = stream;
    stream = null;
    closing.end(resolve);
  });
}

/** Point the trace at another file; tests only. */
function configure(file) {
  traceFile = file || '';
  stream = null;
}

module.exports = { enabled, now, emit, close, configure };
