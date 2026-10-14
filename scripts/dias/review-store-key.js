#!/usr/bin/env node
'use strict';

/** Generate a key for the encrypted off-chain review store. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const keyId = `review-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
const lines = [
  `DIAS_REVIEW_STORE_KEY=${crypto.randomBytes(32).toString('base64')}`,
  `DIAS_REVIEW_STORE_KEY_ID=${keyId}`,
];

const index = process.argv.indexOf('--append');
if (index === -1) {
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  const target = path.resolve(process.argv[index + 1] || '');
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (/^DIAS_REVIEW_STORE_KEY=/m.test(current)) {
    process.stderr.write(`${target} already sets DIAS_REVIEW_STORE_KEY; rotate it by hand so the old key is kept\n`);
    process.exit(1);
  }
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(target, `${separator}${lines.join('\n')}\n`, { mode: 0o600 });
  process.stdout.write(`added DIAS_REVIEW_STORE_KEY and DIAS_REVIEW_STORE_KEY_ID (${keyId}) to ${target}\n`);
}
