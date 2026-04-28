import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './fs.js';

const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function toEpochSeconds(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return Math.floor(n);
}

function toIsoFromEpochSeconds(epochSeconds) {
  if (epochSeconds === null) return null;
  const ms = epochSeconds * 1000;
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function secondsUntil(epochSeconds, now = new Date()) {
  if (epochSeconds === null) return null;
  const nowSec = Math.floor(now.getTime() / 1000);
  return Math.max(0, epochSeconds - nowSec);
}

function parseTimestampToIso(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function isAtOrAfter(isoTimestamp, notBeforeIso) {
  if (!notBeforeIso) return true;
  if (!isoTimestamp) return false;
  const ts = Date.parse(isoTimestamp);
  const cutoff = Date.parse(notBeforeIso);
  if (Number.isNaN(ts) || Number.isNaN(cutoff)) return false;
  return ts >= cutoff;
}

export function extractLatestRateLimitsFromJsonlText(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.includes('"rate_limits"')) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = parsed?.payload;
    const rate = payload?.rate_limits;
    if (parsed?.type !== 'event_msg' || payload?.type !== 'token_count' || !rate || typeof rate !== 'object') {
      continue;
    }

    return {
      timestamp: parseTimestampToIso(parsed.timestamp),
      rate_limits: rate
    };
  }

  return null;
}

function normalizeWindow(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;

  const usedPercent = clampPercent(raw.used_percent);
  const leftPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const windowMinutes = toFiniteNumber(raw.window_minutes);
  const resetsAtEpoch = toEpochSeconds(raw.resets_at);

  return {
    used_percent: usedPercent,
    left_percent: leftPercent,
    window_minutes: windowMinutes,
    resets_at_epoch: resetsAtEpoch,
    resets_at: toIsoFromEpochSeconds(resetsAtEpoch),
    resets_in_seconds: secondsUntil(resetsAtEpoch, now)
  };
}

export function normalizeRateLimitsSnapshot(extracted, now = new Date()) {
  if (!extracted?.rate_limits || typeof extracted.rate_limits !== 'object') {
    return null;
  }

  const rate = extracted.rate_limits;

  return {
    sample_at: extracted.timestamp || null,
    plan_type: rate.plan_type ? String(rate.plan_type) : null,
    limit_id: rate.limit_id ? String(rate.limit_id) : null,
    rate_limit_reached_type: rate.rate_limit_reached_type ? String(rate.rate_limit_reached_type) : null,
    primary: normalizeWindow(rate.primary, now),
    secondary: normalizeWindow(rate.secondary, now)
  };
}

async function readDirSafe(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sortDescByName(items) {
  return [...items].sort((a, b) => b.name.localeCompare(a.name));
}

function onlyDirectories(entries) {
  return entries.filter((entry) => entry?.isDirectory?.());
}

function onlyRolloutFiles(entries) {
  return entries.filter((entry) => entry?.isFile?.() && ROLLOUT_FILE_RE.test(entry.name));
}

async function collectRecentSessionFiles(sessionsDirPath, maxFiles = 20) {
  const limit = Math.max(1, Math.floor(Number(maxFiles) || 20));
  const files = [];
  const years = sortDescByName(onlyDirectories(await readDirSafe(sessionsDirPath)));
  yearLoop:
  for (const year of years) {
    const yearPath = path.join(sessionsDirPath, year.name);
    const months = sortDescByName(onlyDirectories(await readDirSafe(yearPath)));
    for (const month of months) {
      const monthPath = path.join(yearPath, month.name);
      const days = sortDescByName(onlyDirectories(await readDirSafe(monthPath)));
      for (const day of days) {
        const dayPath = path.join(monthPath, day.name);
        const dayFiles = sortDescByName(onlyRolloutFiles(await readDirSafe(dayPath)));
        for (const file of dayFiles) {
          files.push(path.join(dayPath, file.name));
          if (files.length >= limit) {
            break yearLoop;
          }
        }
      }
    }
  }
  return files;
}

async function readTailText(filePath, maxBytes = 256 * 1024) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const size = Number(stats.size ?? 0);
    if (size <= 0) return '';

    const bytesToRead = Math.min(size, maxBytes);
    const start = size - bytesToRead;
    const buff = Buffer.alloc(bytesToRead);
    await handle.read(buff, 0, bytesToRead, start);
    return buff.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readSlotUsageSnapshot(codexHome, now = new Date(), options = {}) {
  const homePath = String(codexHome || '').trim();
  if (!homePath) return null;
  const notBeforeIso = parseTimestampToIso(options?.notBeforeIso || null);
  const maxFiles = Number.isFinite(Number(options?.maxFiles))
    ? Math.max(1, Math.floor(Number(options.maxFiles)))
    : 20;

  const sessionsPath = path.join(homePath, 'sessions');
  if (!(await pathExists(sessionsPath))) {
    return null;
  }

  const files = await collectRecentSessionFiles(sessionsPath, maxFiles);

  for (const sessionFile of files) {
    const tail = await readTailText(sessionFile);
    const extracted = extractLatestRateLimitsFromJsonlText(tail);
    if (!extracted) continue;
    if (!isAtOrAfter(extracted.timestamp, notBeforeIso)) {
      continue;
    }
    const normalized = normalizeRateLimitsSnapshot(extracted, now);
    if (!normalized) continue;
    return {
      ...normalized,
      source_file: sessionFile
    };
  }

  return null;
}
