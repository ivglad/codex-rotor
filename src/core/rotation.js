import { ensureSlotState } from './state-store.js';
import { iso, secondsFromNow } from './time.js';
import { pickNextSlot } from './selector.js';

export function markOk(state, slotId) {
  const s = ensureSlotState(state, slotId);
  s.status = 'ready';
  s.last_error = null;
  s.blocked_until = null;
  s.last_ok = iso();
  state.active_slot = slotId;
}

export function blockSlot(state, slotId, status, seconds, reason) {
  const s = ensureSlotState(state, slotId);
  s.status = status;
  s.last_error = reason;
  s.last_error_at = iso();
  s.blocked_until = seconds > 0 ? iso(secondsFromNow(seconds)) : null;
}

export function applyFailurePolicy({ config, state, slotId, failureType, now = new Date() }) {
  const rot = config.rotation || {};
  let changed = false;
  let rotatedTo = null;

  if (failureType === 'limit_exhausted') {
    blockSlot(state, slotId, 'blocked_limit', Number(rot.limit_block_seconds ?? 18000), failureType);
    const next = pickNextSlot(config, state, slotId, now);
    if (next) {
      state.active_slot = next.id;
      state.last_rotation_at = iso();
      state.last_rotation_reason = failureType;
      rotatedTo = next.id;
      changed = true;
    }
    return { changed: true, rotatedTo, action: 'rotated_after_limit' };
  }

  if (failureType === 'auth_invalid') {
    blockSlot(state, slotId, 'blocked_auth', Number(rot.auth_block_seconds ?? 900), failureType);
    const next = pickNextSlot(config, state, slotId, now);
    if (next) {
      state.active_slot = next.id;
      state.last_rotation_at = iso();
      state.last_rotation_reason = failureType;
      rotatedTo = next.id;
      changed = true;
    }
    return { changed: true, rotatedTo, action: 'rotated_after_auth_invalid' };
  }

  return { changed, rotatedTo, action: 'no_policy_change' };
}
