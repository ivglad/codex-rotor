import { defaultState } from '../config/defaults.js';
import { statePath } from '../config/paths.js';
import { readJson, writeJsonAtomic } from './fs.js';

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  if (raw.schema_version === 2 && raw.slots && typeof raw.slots === 'object') {
    return raw;
  }
  return defaultState();
}

export async function loadState() {
  return normalizeState(await readJson(statePath(), defaultState()));
}

export async function saveState(state) {
  await writeJsonAtomic(statePath(), state);
}

export function ensureSlotState(state, slotId) {
  if (!state.slots || typeof state.slots !== 'object') {
    state.slots = {};
  }
  if (!state.slots[slotId]) {
    state.slots[slotId] = {
      status: 'ready',
      blocked_until: null,
      last_error: null,
      last_error_at: null,
      last_ok: null
    };
  }
  return state.slots[slotId];
}
