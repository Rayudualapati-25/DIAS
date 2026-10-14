'use strict';

/**
 * Encrypted staging of application events; Fabric remains the final access log. A file is removed only
 * after a confirmed idempotent submit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createAccessEventOutbox({ dir, cipher, ledger, log = console }) {
  if (!dir || !cipher || !ledger) throw new Error('access event outbox requires directory, cipher and ledger');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let running = null;
  let timer = null;

  function stage(event) {
    const id = `ACCESS-EVENT-${crypto.randomUUID()}`;
    const file = path.join(dir, `${id}.json`);
    const temporary = `${file}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(cipher.seal(id, { ...event, eventId: id })));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    return id;
  }

  async function drain() {
    for (const name of fs.readdirSync(dir).filter((name) => /^ACCESS-EVENT-[A-Za-z0-9-]+\.json$/.test(name)).sort()) {
      try {
        const id = name.slice(0, -5);
        const event = cipher.open(id, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
        await ledger.submit(event.org, event.fabricUser, 'AuditContract', 'RecordAccessEventOnce',
          id, event.action, JSON.stringify(event.target), event.outcome, String(event.status));
        fs.unlinkSync(path.join(dir, name));
      } catch (error) {
        log.error(`[accessLogger] retained ${name} for retry: ${error.message}`);
      }
    }
  }

  function flush() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }

  function start(intervalMs = 15_000) {
    if (timer) return;
    timer = setInterval(() => flush().catch((error) => log.error(`[accessLogger] retry failed: ${error.message}`)), intervalMs);
    timer.unref?.();
    flush().catch((error) => log.error(`[accessLogger] resume failed: ${error.message}`));
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return Object.freeze({ stage, flush, start, stop });
}

let shared;
function getAccessEventOutbox() {
  if (!shared) {
    const config = require('../config');
    shared = createAccessEventOutbox({ dir: path.join(config.DIAS_REVIEW_STORE_DIR, 'access-events'),
      cipher: require('./reviewCipher').loadReviewCipher(config), ledger: require('../fabric/gateway') });
  }
  return shared;
}
module.exports = { createAccessEventOutbox, getAccessEventOutbox };
