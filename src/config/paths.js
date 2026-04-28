import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

export function configPath() {
  return process.env.CODEX_ROTOR_CONFIG_PATH || path.join(HOME, '.config', 'codex-rotor', 'config.json');
}

export function statePath() {
  return process.env.CODEX_ROTOR_STATE_PATH || path.join(HOME, '.local', 'state', 'codex-rotor', 'state.json');
}

export function stateLockPath() {
  return `${statePath()}.lock`;
}

export function logsDir() {
  return process.env.CODEX_ROTOR_LOGS_DIR || path.join(HOME, '.local', 'state', 'codex-rotor', 'logs');
}

export function defaultSlotHome(slotId = 'main') {
  if (slotId === 'main') {
    return process.env.CODEX_ROTOR_MAIN_HOME || path.join(HOME, '.codex');
  }
  const slotsRoot = process.env.CODEX_ROTOR_SLOTS_DIR || path.join(HOME, '.codex-slots');
  return path.join(slotsRoot, slotId);
}
