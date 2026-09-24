import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditorRequestFromSearch, auditorReviewUrl, prepareAuditorHandoff,
  completeAuditorHandoff, closeAuditorHandoff,
} from '../js/shared/auditor-handoff.js';

const location = { origin: 'http://localhost:3001' };

test('builds and reads a safe direct auditor-review link', () => {
  const url = auditorReviewUrl('REQ-2026_09.14', location);
  assert.equal(url, 'http://localhost:3001/?auditorRequest=REQ-2026_09.14#/auditor-review');
  assert.equal(auditorRequestFromSearch('?auditorRequest=REQ-2026_09.14'), 'REQ-2026_09.14');
  assert.equal(auditorRequestFromSearch('?auditorRequest=%3Cscript%3E'), null);
  assert.throws(() => auditorReviewUrl('../bad/request', location), /invalid format/);
});

test('clears the cloned requester session before showing the waiting page', () => {
  const calls = [];
  const popup = {
    sessionStorage: { clear: () => calls.push('clear') },
    location: { replace: (url) => calls.push(url) },
    close: () => calls.push('close'),
    opener: {},
  };
  const browserWindow = {
    location,
    open: (...args) => { calls.push(args); return popup; },
  };
  assert.equal(prepareAuditorHandoff(browserWindow), popup);
  assert.equal(popup.opener, null);
  assert.equal(calls[1], 'clear');
  assert.equal(calls[2], 'http://localhost:3001/auditor-handoff.html');
});

test('routes a prepared popup to the exact request and can close it', () => {
  const calls = [];
  const popup = {
    closed: false,
    location: { replace: (url) => calls.push(url) },
    focus: () => calls.push('focus'),
    close: () => calls.push('close'),
  };
  assert.equal(completeAuditorHandoff(popup, 'REQ-1', { location }), true);
  assert.deepEqual(calls.slice(0, 2), [
    'http://localhost:3001/?auditorRequest=REQ-1#/auditor-review', 'focus',
  ]);
  closeAuditorHandoff(popup);
  assert.equal(calls.at(-1), 'close');
});

test('reports a blocked or closed popup without throwing', () => {
  assert.equal(prepareAuditorHandoff({ open: () => null }), null);
  assert.equal(completeAuditorHandoff({ closed: true }, 'REQ-1', { location }), false);
});

