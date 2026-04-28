import { spawn } from 'node:child_process';
import readline from 'node:readline';

const INIT_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 120;
const MAX_RETRY_DELAY_MS = 1200;
const DEFAULT_LIMIT_ID = 'codex';
const APP_SERVER_OVERLOAD_CODE = -32001;

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

function trimString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(obj, keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeWindow(raw, now = new Date()) {
  if (!isObject(raw)) return null;
  const usedPercentRaw = firstDefined(raw, ['usedPercent', 'used_percent']);
  const resetsAtRaw = firstDefined(raw, ['resetsAt', 'resets_at']);
  const windowMinutesRaw = firstDefined(raw, [
    'windowDurationMins',
    'window_duration_mins',
    'window_minutes'
  ]);

  const usedPercent = clampPercent(usedPercentRaw);
  const leftPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const windowMinutes = toFiniteNumber(windowMinutesRaw);
  const resetsAtEpoch = toEpochSeconds(resetsAtRaw);

  return {
    used_percent: usedPercent,
    left_percent: leftPercent,
    window_minutes: windowMinutes,
    resets_at_epoch: resetsAtEpoch,
    resets_at: toIsoFromEpochSeconds(resetsAtEpoch),
    resets_in_seconds: secondsUntil(resetsAtEpoch, now)
  };
}

function chooseRateLimitsBucket(result, preferredLimitId = DEFAULT_LIMIT_ID) {
  if (!isObject(result)) return null;

  const byId = firstDefined(result, ['rateLimitsByLimitId', 'rate_limits_by_limit_id']);
  if (isObject(byId)) {
    const preferred = byId[preferredLimitId];
    if (isObject(preferred)) {
      return preferred;
    }
    for (const value of Object.values(byId)) {
      if (isObject(value)) {
        return value;
      }
    }
  }

  const topLevel = firstDefined(result, ['rateLimits', 'rate_limits']);
  if (isObject(topLevel)) {
    return topLevel;
  }
  return null;
}

function normalizeRateLimitsBucket(bucket, now = new Date(), sampleAtIso = null) {
  if (!isObject(bucket)) return null;
  const normalizedSampleAt = trimString(sampleAtIso) || new Date(now).toISOString();
  const primary = normalizeWindow(firstDefined(bucket, ['primary']), now);
  const secondary = normalizeWindow(firstDefined(bucket, ['secondary']), now);
  return {
    sample_at: normalizedSampleAt,
    plan_type: trimString(firstDefined(bucket, ['planType', 'plan_type'])),
    limit_id: trimString(firstDefined(bucket, ['limitId', 'limit_id'])),
    rate_limit_reached_type: trimString(firstDefined(bucket, ['rateLimitReachedType', 'rate_limit_reached_type'])),
    primary,
    secondary
  };
}

function safeKill(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // no-op
  }
}

function writeJsonl(stream, payload) {
  if (!stream?.writable) return false;
  try {
    stream.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

function isRetryableOverloadError(errorPayload) {
  const code = Number(errorPayload?.code);
  return Number.isFinite(code) && code === APP_SERVER_OVERLOAD_CODE;
}

function backoffDelayMs(baseDelayMs, attempt) {
  const exp = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(25, Math.floor(exp * jitter));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeAppServerRateLimitResult(result, now = new Date(), options = {}) {
  const preferredLimitId = trimString(options?.preferredLimitId) || DEFAULT_LIMIT_ID;
  const sampleAtIso = trimString(options?.sampleAtIso) || null;
  const bucket = chooseRateLimitsBucket(result, preferredLimitId);
  if (!bucket) return null;
  return normalizeRateLimitsBucket(bucket, now, sampleAtIso);
}

async function readSlotUsageViaAppServerOnce(codexBin, codexHome, now = new Date(), options = {}) {
  const bin = trimString(codexBin);
  const home = trimString(codexHome);
  if (!bin || !home) return { status: 'hard_error', snapshot: null };

  const timeoutMs = clampInt(options?.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 30000);
  const preferredLimitId = trimString(options?.preferredLimitId) || DEFAULT_LIMIT_ID;

  const env = {
    ...process.env,
    CODEX_HOME: home,
    RUST_LOG: process.env.RUST_LOG || 'error'
  };

  return await new Promise((resolve) => {
    let settled = false;

    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        rl.close();
      } catch {
        // no-op
      }
      try {
        child.stdout?.removeAllListeners('data');
      } catch {
        // no-op
      }
      safeKill(child);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      done({ status: 'hard_error', snapshot: null });
    }, timeoutMs);

    const rl = readline.createInterface({ input: child.stdout });

    child.stderr?.on('data', () => {
      // suppress probe noise from interactive stderr
    });
    child.stdin?.on('error', () => {
      done({ status: 'hard_error', snapshot: null });
    });

    child.on('error', () => {
      done({ status: 'hard_error', snapshot: null });
    });

    child.on('exit', () => {
      done({ status: 'hard_error', snapshot: null });
    });

    rl.on('line', (line) => {
      if (settled) return;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      const msgId = parsed?.id;
      if (msgId === INIT_REQUEST_ID) {
        if (parsed?.error) {
          if (isRetryableOverloadError(parsed.error)) {
            done({ status: 'retryable_error', snapshot: null });
            return;
          }
          done({ status: 'hard_error', snapshot: null });
          return;
        }
        const notified = writeJsonl(child.stdin, { method: 'initialized', params: {} });
        if (!notified) {
          done({ status: 'hard_error', snapshot: null });
          return;
        }
        const requested = writeJsonl(child.stdin, {
          id: RATE_LIMITS_REQUEST_ID,
          method: 'account/rateLimits/read'
        });
        if (!requested) {
          done({ status: 'hard_error', snapshot: null });
        }
        return;
      }

      if (msgId === RATE_LIMITS_REQUEST_ID) {
        if (parsed?.error) {
          if (isRetryableOverloadError(parsed.error)) {
            done({ status: 'retryable_error', snapshot: null });
            return;
          }
          done({ status: 'hard_error', snapshot: null });
          return;
        }
        const normalized = normalizeAppServerRateLimitResult(parsed?.result, now, {
          preferredLimitId,
          sampleAtIso: new Date(now).toISOString()
        });
        done({
          status: normalized ? 'ok' : 'hard_error',
          snapshot: normalized
        });
      }
    });

    const initWritten = writeJsonl(child.stdin, {
      id: INIT_REQUEST_ID,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex_rotor',
          title: 'codex-rotor',
          version: '0.1.0'
        }
      }
    });

    if (!initWritten) {
      done({ status: 'hard_error', snapshot: null });
    }
  });
}

export async function readSlotUsageViaAppServer(codexBin, codexHome, now = new Date(), options = {}) {
  const maxRetries = clampInt(options?.retries, DEFAULT_RETRIES, 0, 5);
  const retryBaseDelayMs = clampInt(
    options?.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    25,
    MAX_RETRY_DELAY_MS
  );

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await readSlotUsageViaAppServerOnce(codexBin, codexHome, now, options);
    if (result?.status === 'ok' && result.snapshot) {
      return result.snapshot;
    }

    const shouldRetry = result?.status === 'retryable_error' && attempt < maxRetries;
    if (!shouldRetry) {
      return null;
    }
    await sleep(backoffDelayMs(retryBaseDelayMs, attempt + 1));
  }

  return null;
}
