import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEligibleSlot, pickNextSlot } from '../src/core/selector.js';
import { applyFailurePolicy } from '../src/core/rotation.js';

function sampleConfig() {
  return {
    default_slot: 'main',
    slots: [
      { id: 'main', label: 'Main', codex_home: '/tmp/main', priority: 100, enabled: true },
      { id: 'alt', label: 'Alt', codex_home: '/tmp/alt', priority: 90, enabled: true }
    ],
    rotation: {
      limit_block_seconds: 1000,
      auth_block_seconds: 100,
      unknown_block_seconds: 10
    }
  };
}

function sampleState() {
  return {
    active_slot: 'main',
    slots: {
      main: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null },
      alt: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null }
    },
    last_rotation_at: null,
    last_rotation_reason: null
  };
}

test('selector picks highest-priority available slot', () => {
  const config = sampleConfig();
  const state = sampleState();
  const picked = pickEligibleSlot(config, state, null, new Date());
  assert.equal(picked?.id, 'main');
});

test('selector skips pending_auth slots', () => {
  const config = sampleConfig();
  const state = sampleState();
  state.slots.main.status = 'pending_auth';
  const picked = pickEligibleSlot(config, state, null, new Date());
  assert.equal(picked?.id, 'alt');
});

test('pickNextSlot rotates to next available slot', () => {
  const config = sampleConfig();
  const state = sampleState();
  const next = pickNextSlot(config, state, 'main', new Date());
  assert.equal(next?.id, 'alt');
});

test('limit failure blocks current and rotates to next', () => {
  const config = sampleConfig();
  const state = sampleState();
  const res = applyFailurePolicy({
    config,
    state,
    slotId: 'main',
    failureType: 'limit_exhausted',
    now: new Date()
  });

  assert.equal(res.action, 'rotated_after_limit');
  assert.equal(res.rotatedTo, 'alt');
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
});

test('auth failure blocks auth and rotates to next', () => {
  const config = sampleConfig();
  const state = sampleState();
  const res = applyFailurePolicy({
    config,
    state,
    slotId: 'main',
    failureType: 'auth_invalid',
    now: new Date()
  });

  assert.equal(res.action, 'rotated_after_auth_invalid');
  assert.equal(state.slots.main.status, 'blocked_auth');
  assert.equal(state.active_slot, 'alt');
});

test('unknown failure does not block or rotate', () => {
  const config = sampleConfig();
  const state = sampleState();
  const res = applyFailurePolicy({
    config,
    state,
    slotId: 'main',
    failureType: 'unknown_failure',
    now: new Date()
  });

  assert.equal(res.action, 'no_policy_change');
  assert.equal(res.changed, false);
  assert.equal(state.slots.main.status, 'ready');
  assert.equal(state.active_slot, 'main');
});
