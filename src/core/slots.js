import fs from 'node:fs/promises';
import { defaultSlotHome } from '../config/paths.js';
import { ensureSlotState } from './state-store.js';

const AUTO_SLOT_RE = /^slot-(\d+)$/;
const SAFE_SLOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function ensureSlotDir(slot) {
  await fs.mkdir(slot.codex_home, { recursive: true, mode: 0o700 });
}

export function normalizeSlotInput({ id, label, codexHome, priority, enabled = true }) {
  const slotId = String(id).trim();
  if (!slotId) throw new Error('slot id is required');
  if (!SAFE_SLOT_ID_RE.test(slotId)) {
    throw new Error('slot id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  }
  return {
    id: slotId,
    label: label ? String(label) : slotId,
    codex_home: codexHome ? String(codexHome) : defaultSlotHome(slotId),
    priority: Number.isFinite(priority) ? Number(priority) : 100,
    enabled: Boolean(enabled)
  };
}

export function nextAutoSlotId(config) {
  const used = new Set(config.slots.map((slot) => slot.id));
  let n = 1;
  while (used.has(`slot-${n}`)) {
    n += 1;
  }
  return `slot-${n}`;
}

export function autoSlotLabel(slotId) {
  const m = String(slotId).match(AUTO_SLOT_RE);
  if (!m) return slotId;
  return `Account ${Number(m[1])}`;
}

export function nextAutoPriority(config) {
  const priorities = config.slots
    .map((slot) => Number(slot.priority))
    .filter((p) => Number.isFinite(p));
  if (priorities.length === 0) return 100;
  return Math.min(...priorities) - 1;
}

export function buildAutoSlot(config) {
  const id = nextAutoSlotId(config);
  return normalizeSlotInput({
    id,
    label: autoSlotLabel(id),
    codexHome: defaultSlotHome(id),
    priority: nextAutoPriority(config),
    enabled: true
  });
}

export function upsertSlot(config, state, slotInput) {
  const idx = config.slots.findIndex((s) => s.id === slotInput.id);
  if (idx >= 0) {
    config.slots[idx] = { ...config.slots[idx], ...slotInput };
  } else {
    config.slots.push(slotInput);
  }
  ensureSlotState(state, slotInput.id);
}

export function ensureAllSlotStates(config, state) {
  for (const slot of config.slots) {
    ensureSlotState(state, slot.id);
    const st = state.slots[slot.id];
    if (!slot.enabled) st.status = 'disabled';
    if (slot.enabled && st.status === 'disabled') st.status = 'ready';
  }
}
