import { parseIso } from './time.js';
import { isSlotLeasedByOtherTerminal } from './runtime-lease.js';

export function isSlotAvailable(slot, slotState, now = new Date(), options = {}) {
  if (options.excludeSlotIds?.has?.(slot?.id)) return false;
  if (!slot?.enabled) return false;
  if (!slotState) return true;
  if (slotState.status === 'blocked_auth' || slotState.status === 'pending_auth') return false;
  const blockedUntil = parseIso(slotState.blocked_until);
  if (blockedUntil && blockedUntil > now) return false;
  const terminalId = options.terminalId || null;
  if (options.state && isSlotLeasedByOtherTerminal(options.state, slot.id, terminalId)) {
    return false;
  }
  return true;
}

export function sortedSlots(config) {
  return [...config.slots].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}

function pushIfPresent(queue, value) {
  if (!value) return;
  if (queue.includes(value)) return;
  queue.push(value);
}

function slotById(config, slotId) {
  return config.slots.find((s) => s.id === slotId) || null;
}

function schedulingMode(config, options = {}) {
  return options.mode || config.scheduling?.mode || 'terminal_pinned';
}

export function pickEligibleSlot(config, state, preferredId = null, now = new Date(), options = {}) {
  const terminalId = options.terminalId || null;
  const mode = schedulingMode(config, options);
  const ordered = sortedSlots(config);

  const candidateIds = [];
  pushIfPresent(candidateIds, preferredId);

  if (mode === 'terminal_pinned' && terminalId) {
    const session = state.sessions?.[terminalId];
    pushIfPresent(candidateIds, session?.suggested_slot);
    pushIfPresent(candidateIds, session?.last_slot);
  }

  const active = state.active_slot;
  pushIfPresent(candidateIds, active);

  const defaultSlot = config.default_slot;
  pushIfPresent(candidateIds, defaultSlot);

  for (const candidateId of candidateIds) {
    const slot = slotById(config, candidateId);
    if (!slot) continue;
    if (isSlotAvailable(slot, state.slots?.[slot.id], now, { state, terminalId })) {
      return slot;
    }
  }

  return ordered.find((s) => isSlotAvailable(s, state.slots?.[s.id], now, { state, terminalId })) || null;
}

export function pickNextSlot(config, state, currentSlotId, now = new Date(), options = {}) {
  const terminalId = options.terminalId || null;
  const ordered = sortedSlots(config);
  const currentIdx = ordered.findIndex((s) => s.id === currentSlotId);
  if (currentIdx < 0) {
    return pickEligibleSlot(config, state, null, now, options);
  }

  const rotated = [...ordered.slice(currentIdx + 1), ...ordered.slice(0, currentIdx)];
  return rotated.find((s) => isSlotAvailable(s, state.slots?.[s.id], now, { state, terminalId })) || null;
}
