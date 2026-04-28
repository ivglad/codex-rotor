import { defaultState } from '../config/defaults.js';
import { statePath } from '../config/paths.js';
import { readJson, writeJsonAtomic } from './fs.js';

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  if (raw.schema_version === 2 && raw.slots && typeof raw.slots === 'object') {
    if (!raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) {
      raw.sessions = {};
    }
    if (!raw.leases || typeof raw.leases !== 'object' || Array.isArray(raw.leases)) {
      raw.leases = {};
    }
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

export function ensureRuntimeState(state) {
  if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    state.sessions = {};
  }
  if (!state.leases || typeof state.leases !== 'object' || Array.isArray(state.leases)) {
    state.leases = {};
  }
}

export function ensureSessionState(state, terminalId) {
  ensureRuntimeState(state);
  if (!terminalId) return null;
  if (!state.sessions[terminalId] || typeof state.sessions[terminalId] !== 'object') {
    state.sessions[terminalId] = {
      last_slot: null,
      suggested_slot: null,
      last_command: null,
      updated_at: null
    };
  }
  return state.sessions[terminalId];
}
