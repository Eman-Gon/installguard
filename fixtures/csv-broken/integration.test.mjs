import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCsv } from './import.mjs';
test('imports a valid CSV row', () => {
  assert.deepEqual(importCsv('name,email\nAda,ada@example.com\n'), [{ name: 'Ada', email: 'ada@example.com' }]);
});
test('rejects a row missing a required email', () => {
  assert.throws(() => importCsv('name,email\nAda,\n'), /required/);
});
test('rejects a missing required header', () => {
  assert.throws(() => importCsv('name\nAda\n'), /required/);
});
