import { parseIso } from './time.js';

export function isSlotAvailable(slot, slotState, now = new Date()) {
  if (!slot?.enabled) return false;
  if (!slotState) return true;
  if (slotState.status === 'blocked_auth' || slotState.status === 'pending_auth') return false;
  const blockedUntil = parseIso(slotState.blocked_until);
  if (blockedUntil && blockedUntil > now) return false;
  return true;
}

export function sortedSlots(config) {
  return [...config.slots].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}

export function pickEligibleSlot(config, state, preferredId = null, now = new Date()) {
  const ordered = sortedSlots(config);
  if (preferredId) {
    const preferred = ordered.find((s) => s.id === preferredId);
    if (preferred && isSlotAvailable(preferred, state.slots?.[preferred.id], now)) {
      return preferred;
    }
  }

  const active = state.active_slot;
  if (active) {
    const activeSlot = ordered.find((s) => s.id === active);
    if (activeSlot && isSlotAvailable(activeSlot, state.slots?.[active], now)) {
      return activeSlot;
    }
  }

  const defaultSlot = config.default_slot;
  const defaultObj = ordered.find((s) => s.id === defaultSlot);
  if (defaultObj && isSlotAvailable(defaultObj, state.slots?.[defaultObj.id], now)) {
    return defaultObj;
  }

  return ordered.find((s) => isSlotAvailable(s, state.slots?.[s.id], now)) || null;
}

export function pickNextSlot(config, state, currentSlotId, now = new Date()) {
  const ordered = sortedSlots(config);
  const currentIdx = ordered.findIndex((s) => s.id === currentSlotId);
  if (currentIdx < 0) {
    return pickEligibleSlot(config, state, null, now);
  }

  const rotated = [...ordered.slice(currentIdx + 1), ...ordered.slice(0, currentIdx)];
  return rotated.find((s) => isSlotAvailable(s, state.slots?.[s.id], now)) || null;
}
