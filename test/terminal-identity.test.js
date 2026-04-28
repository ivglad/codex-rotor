import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalId } from '../src/core/terminal-identity.js';

test('resolveTerminalId keeps explicit override as-is', () => {
  const got = resolveTerminalId({ CODEX_ROTOR_TERMINAL_ID: 'my-term' });
  assert.equal(got, 'my-term');
});

test('resolveTerminalId uses TMUX_PANE when present', () => {
  const got = resolveTerminalId({ TMUX_PANE: '%18' });
  assert.equal(got, 'TMUX_PANE:%18');
});

test('resolveTerminalId differentiates terminal env values', () => {
  const a = resolveTerminalId({ TMUX_PANE: '%1' });
  const b = resolveTerminalId({ TMUX_PANE: '%2' });
  assert.notEqual(a, b);
});

test('resolveTerminalId fallback is deterministic for same env', () => {
  const env = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    SHELL: '/bin/bash',
    PWD: '/tmp/work'
  };
  const a = resolveTerminalId(env);
  const b = resolveTerminalId(env);
  assert.equal(a, b);
  assert.match(a, /^fallback:[a-f0-9]{12}$/);
});
