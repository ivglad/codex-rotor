import crypto from 'node:crypto';
import { iso } from './time.js';
import { ensureRuntimeState } from './state-store.js';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function makeLeaseId(slotId, terminalId, pid, nowIso) {
  const seed = `${slotId}|${terminalId}|${pid}|${nowIso}|${Math.random()}`;
  return crypto.createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 16);
}

function parseLeasePid(lease) {
  const pid = Number(lease?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function reapStaleLeases(state, options = {}) {
  ensureRuntimeState(state);
  const alive = options.isProcessAlive || isProcessAlive;
  const reaped = [];

  for (const [slotId, lease] of Object.entries(state.leases)) {
    const pid = parseLeasePid(lease);
    if (!pid || !alive(pid)) {
      delete state.leases[slotId];
      reaped.push({ slot_id: slotId, lease_id: lease?.lease_id || null, pid: pid || null });
    }
  }

  return { reaped };
}

export function isSlotLeasedByOtherTerminal(state, slotId, terminalId, options = {}) {
  ensureRuntimeState(state);
  const alive = options.isProcessAlive || isProcessAlive;
  const lease = state.leases[slotId];
  if (!lease) return false;
  const pid = parseLeasePid(lease);
  if (!pid || !alive(pid)) {
    delete state.leases[slotId];
    return false;
  }
  if (!terminalId) return true;
  return lease.terminal_id !== terminalId;
}

export function acquireSlotLease(state, { slotId, terminalId, pid }, options = {}) {
  ensureRuntimeState(state);
  const alive = options.isProcessAlive || isProcessAlive;
  const nowIso = iso(options.now || new Date());
  const normalizedPid = Number(pid);

  if (!slotId) {
    return { acquired: false, reason: 'missing_slot_id' };
  }

  const existing = state.leases[slotId];
  if (existing) {
    const existingPid = parseLeasePid(existing);
    const stale = !existingPid || !alive(existingPid);
    if (stale) {
      delete state.leases[slotId];
    } else if (existing.terminal_id === terminalId && existingPid === normalizedPid) {
      existing.heartbeat_at = nowIso;
      return {
        acquired: true,
        reused: true,
        lease: existing,
        lease_id: existing.lease_id
      };
    } else {
      return {
        acquired: false,
        reason: 'occupied',
        occupied_by: {
          terminal_id: existing.terminal_id,
          pid: existingPid,
          lease_id: existing.lease_id
        }
      };
    }
  }

  const lease = {
    lease_id: makeLeaseId(slotId, terminalId || '-', normalizedPid || '-', nowIso),
    slot_id: slotId,
    terminal_id: terminalId || null,
    pid: Number.isInteger(normalizedPid) && normalizedPid > 0 ? normalizedPid : null,
    acquired_at: nowIso,
    heartbeat_at: nowIso
  };

  state.leases[slotId] = lease;
  return {
    acquired: true,
    reused: false,
    lease,
    lease_id: lease.lease_id
  };
}

export function releaseSlotLease(state, { slotId, leaseId = null, terminalId = null, pid = null } = {}) {
  ensureRuntimeState(state);
  const lease = state.leases[slotId];
  if (!lease) return { released: false, reason: 'not_found' };

  if (leaseId && lease.lease_id !== leaseId) {
    return { released: false, reason: 'lease_id_mismatch' };
  }
  if (terminalId && lease.terminal_id !== terminalId) {
    return { released: false, reason: 'terminal_id_mismatch' };
  }
  if (pid !== null && pid !== undefined) {
    const normalizedPid = Number(pid);
    if (Number.isInteger(normalizedPid) && normalizedPid > 0 && lease.pid !== normalizedPid) {
      return { released: false, reason: 'pid_mismatch' };
    }
  }

  delete state.leases[slotId];
  return { released: true };
}
