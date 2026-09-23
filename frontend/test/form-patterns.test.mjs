/**
 * HTML `pattern` attributes are compiled by current browsers with the RegExp `v`
 * flag. A pattern that is valid without it — an unescaped `-` at the end of a
 * character class, for example — is then invalid, the browser logs an error on
 * every submit, and the field silently loses its validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|html)$/.test(entry.name) ? [full] : [];
  });
}

test('every form pattern compiles the way browsers compile it', () => {
  const patterns = [];
  for (const file of sourceFiles(path.join(FRONTEND, 'js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, literal] of source.matchAll(/pattern:\s*'((?:[^'\\]|\\.)*)'/g)) {
      patterns.push({ file: path.relative(FRONTEND, file), value: literal.replace(/\\\\/g, '\\') });
    }
  }
  assert.ok(patterns.length > 0, 'no form patterns found; the scan is broken');
  for (const { file, value } of patterns) {
    assert.doesNotThrow(() => new RegExp(`^(?:${value})$`, 'v'), `${file}: pattern ${value}`);
  }
});
