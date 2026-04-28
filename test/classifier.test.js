import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/core/classifier.js';

test('classifier detects limit errors', () => {
  const result = classifyFailure({
    exitCode: 1,
    signal: null,
    stderrTail: 'Error: rate limit reached for current workspace',
    elapsedSeconds: 60
  });
  assert.equal(result, 'limit_exhausted');
});

test('classifier detects auth errors', () => {
  const result = classifyFailure({
    exitCode: 1,
    signal: null,
    stderrTail: 'authentication failed: not logged in',
    elapsedSeconds: 10
  });
  assert.equal(result, 'auth_invalid');
});

test('classifier returns interrupt for signal/130', () => {
  assert.equal(
    classifyFailure({ exitCode: 130, signal: null, stderrTail: '', elapsedSeconds: 2 }),
    'interrupt'
  );
  assert.equal(
    classifyFailure({ exitCode: 1, signal: 'SIGINT', stderrTail: '', elapsedSeconds: 2 }),
    'interrupt'
  );
});
