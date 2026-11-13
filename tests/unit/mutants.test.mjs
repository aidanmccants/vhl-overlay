// The mutation check (scripts/mutation-check.mjs) plants each bug by finding a piece of
// code. If that code changes, the mutant can't be planted; catch that here in
// milliseconds instead of halfway through the long mutation run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from '../../scripts/mutation-check.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

test('every planted bug still finds its code exactly once', () => {
  const stale = [];
  for (const m of MUTANTS) {
    const src = fs.readFileSync(path.join(EXT, m.file), 'utf8');
    for (const [find] of [[m.find], ...(m.also || [])]) {
      const n = src.split(find).length - 1;
      if (n !== 1) stale.push(`${m.id} (${m.file}: found ${n} times)`);
    }
  }
  assert.deepEqual(stale, [], 'update these mutants in scripts/mutation-check.mjs');
});
