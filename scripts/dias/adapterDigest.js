'use strict';

/**
 * The digest of a LoRA adapter directory.
 *
 * A registration pins an adapter by hash so the ledger can say exactly which
 * weights produced a recommendation. Hashing the whole directory rather than one
 * file means a changed config, a swapped checkpoint or an added file all change
 * the digest. Entries are sorted so the digest does not depend on the filesystem
 * listing order, and each file's path is mixed in so moving bytes between files
 * changes the result.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Files that describe the adapter itself. Training logs and run records are excluded. */
const INCLUDED = /\.(safetensors|json)$/;

function adapterFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && INCLUDED.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} dir adapter directory
 * @returns {{digest: string, files: Array<{name: string, bytes: number, sha256: string}>}}
 */
function adapterDigest(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`adapter directory does not exist: ${dir}`);
  }
  const names = adapterFiles(dir);
  if (names.length === 0) throw new Error(`adapter directory holds no adapter files: ${dir}`);
  const overall = crypto.createHash('sha256');
  const files = names.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    overall.update(name).update('\0').update(sha256).update('\n');
    return { name, bytes: bytes.length, sha256 };
  });
  return { digest: overall.digest('hex'), files };
}

module.exports = { INCLUDED, adapterDigest, adapterFiles };
