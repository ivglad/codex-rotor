import { defaultConfig } from '../config/defaults.js';
import { configPath } from '../config/paths.js';
import { readJson, writeJsonAtomic } from './fs.js';

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return defaultConfig();
  if (raw.schema_version === 2 && Array.isArray(raw.slots)) {
    return raw;
  }
  return defaultConfig();
}

export async function loadConfig() {
  const cfg = normalizeConfig(await readJson(configPath(), defaultConfig()));
  if (!Array.isArray(cfg.slots) || cfg.slots.length === 0) {
    const fallback = defaultConfig();
    cfg.slots = fallback.slots;
    cfg.default_slot = fallback.default_slot;
  }
  return cfg;
}

export async function saveConfig(config) {
  await writeJsonAtomic(configPath(), config);
}

export function findSlot(config, slotId) {
  return config.slots.find((s) => s.id === slotId) || null;
}
