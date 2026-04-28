import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireSlotLease,
  isSlotLeasedByOtherTerminal,
  reapStaleLeases,
  releaseSlotLease
} from '../src/core/runtime-lease.js';

function baseState() {
  return {
    schema_version: 2,
    active_slot: 'main',
    slots: {
      main: { status: 'ready', blocked_until: null },
      alt: { status: 'ready', blocked_until: null }
    }
  };
}

test('acquireSlotLease stores lease metadata', () => {
  const state = baseState();
  const out = acquireSlotLease(state, {
    slotId: 'main',
    terminalId: 't1',
    pid: 111
  }, { isProcessAlive: () => true });

  assert.equal(out.acquired, true);
  assert.equal(typeof out.lease_id, 'string');
  assert.equal(state.leases.main.terminal_id, 't1');
  assert.equal(state.leases.main.pid, 111);
});

test('acquireSlotLease rejects occupied slot', () => {
  const state = baseState();
  acquireSlotLease(state, { slotId: 'main', terminalId: 't1', pid: 111 }, { isProcessAlive: () => true });
  const out = acquireSlotLease(state, { slotId: 'main', terminalId: 't2', pid: 222 }, { isProcessAlive: () => true });

  assert.equal(out.acquired, false);
  assert.equal(out.reason, 'occupied');
});

test('releaseSlotLease enforces lease id', () => {
  const state = baseState();
  const lease = acquireSlotLease(state, {
    slotId: 'main',
    terminalId: 't1',
    pid: 111
  }, { isProcessAlive: () => true });

  const wrong = releaseSlotLease(state, { slotId: 'main', leaseId: 'wrong' });
  assert.equal(wrong.released, false);
  assert.ok(state.leases.main);

  const ok = releaseSlotLease(state, { slotId: 'main', leaseId: lease.lease_id });
  assert.equal(ok.released, true);
  assert.equal(state.leases.main, undefined);
});

test('reapStaleLeases removes stale entries', () => {
  const state = baseState();
  acquireSlotLease(state, { slotId: 'main', terminalId: 't1', pid: 111 }, { isProcessAlive: () => true });
  acquireSlotLease(state, { slotId: 'alt', terminalId: 't2', pid: 222 }, { isProcessAlive: () => true });

  const out = reapStaleLeases(state, {
    isProcessAlive: (pid) => pid === 222
  });

  assert.equal(out.reaped.length, 1);
  assert.equal(state.leases.main, undefined);
  assert.ok(state.leases.alt);
});

test('isSlotLeasedByOtherTerminal honors same-owner leases', () => {
  const state = baseState();
  acquireSlotLease(state, { slotId: 'main', terminalId: 't1', pid: 111 }, { isProcessAlive: () => true });

  assert.equal(
    isSlotLeasedByOtherTerminal(state, 'main', 't1', { isProcessAlive: () => true }),
    false
  );
  assert.equal(
    isSlotLeasedByOtherTerminal(state, 'main', 't2', { isProcessAlive: () => true }),
    true
  );
});
