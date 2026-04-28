import { loadConfig, saveConfig } from '../core/config-store.js';
import { ensureRuntimeState, ensureSessionState, loadState, saveState } from '../core/state-store.js';
import { configPath, stateLockPath, statePath } from '../config/paths.js';
import { defaultConfig, defaultState } from '../config/defaults.js';
import { pathExists, withFileLock, writeJsonAtomic } from '../core/fs.js';
import { ensureAllSlotStates } from '../core/slots.js';
import { pickEligibleSlot } from '../core/selector.js';
import { findRealCodex } from '../core/real-codex.js';
import { runWithStderrTail } from '../core/run-process.js';
import { classifyFailure } from '../core/classifier.js';
import { applyFailurePolicy, markOk } from '../core/rotation.js';
import { iso } from '../core/time.js';
import { notifyTelegram } from '../core/notify.js';
import { reconcileSlots } from '../core/slot-reconcile.js';
import { acquireSlotLease, reapStaleLeases, releaseSlotLease } from '../core/runtime-lease.js';
import { resolveTerminalId } from '../core/terminal-identity.js';
import { readSlotUsageSnapshot } from '../core/usage-snapshot.js';
import { readSlotUsageViaAppServer } from '../core/app-server-rate-limits.js';
import { readSlotAuthIdentity } from '../core/slot-identity.js';

const CONTROL_COMMANDS = new Set([
  'help',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'completion',
  'sandbox',
  'debug',
  'features',
  'apply',
  'cloud',
  'exec-server'
]);

const ROTATION_ELIGIBLE_COMMANDS = new Set([
  'exec',
  'resume'
]);

const APP_SERVER_LIMITS_TIMEOUT_MS = 4000;
const APP_SERVER_LIMITS_RETRIES = 2;
const APP_SERVER_LIMITS_RETRY_BASE_DELAY_MS = 120;
const APP_SERVER_LIMIT_ID = 'codex';

function findTopLevelToken(argv) {
  for (const token of argv) {
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

export function isRotationEligibleInvocation(argv) {
  const cmd = findTopLevelToken(argv);
  if (!cmd) return true;
  if (ROTATION_ELIGIBLE_COMMANDS.has(cmd)) return true;
  if (CONTROL_COMMANDS.has(cmd)) return false;
  return false;
}

function snapshotSuggestsLimitExhausted(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const reachedType = String(snapshot.rate_limit_reached_type || '').trim();
  if (reachedType) return true;
  const primaryUsed = Number(snapshot.primary?.used_percent);
  if (Number.isFinite(primaryUsed) && primaryUsed >= 100) return true;
  const secondaryUsed = Number(snapshot.secondary?.used_percent);
  if (Number.isFinite(secondaryUsed) && secondaryUsed >= 100) return true;
  return false;
}

function snapshotLimitIsStillActive(snapshot) {
  if (!snapshotSuggestsLimitExhausted(snapshot)) return false;
  const primaryReset = Number(snapshot?.primary?.resets_in_seconds);
  const secondaryReset = Number(snapshot?.secondary?.resets_in_seconds);
  const hasActivePrimary = Number.isFinite(primaryReset) && primaryReset > 0;
  const hasActiveSecondary = Number.isFinite(secondaryReset) && secondaryReset > 0;
  return hasActivePrimary || hasActiveSecondary;
}

function isTruthyEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

async function readLimitSignalFromAppServer(realCodex, codexHome, now = new Date()) {
  if (!isTruthyEnv(process.env.CODEX_ROTOR_APP_SERVER_LIMITS, true)) {
    return null;
  }
  const timeoutRaw = Number(process.env.CODEX_ROTOR_APP_SERVER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.floor(timeoutRaw)
    : APP_SERVER_LIMITS_TIMEOUT_MS;
  const retriesRaw = Number(process.env.CODEX_ROTOR_APP_SERVER_RETRIES);
  const retries = Number.isFinite(retriesRaw) && retriesRaw >= 0
    ? Math.floor(retriesRaw)
    : APP_SERVER_LIMITS_RETRIES;
  const retryBaseDelayRaw = Number(process.env.CODEX_ROTOR_APP_SERVER_RETRY_BASE_DELAY_MS);
  const retryBaseDelayMs = Number.isFinite(retryBaseDelayRaw) && retryBaseDelayRaw > 0
    ? Math.floor(retryBaseDelayRaw)
    : APP_SERVER_LIMITS_RETRY_BASE_DELAY_MS;
  const preferredLimitIdRaw = String(process.env.CODEX_ROTOR_APP_SERVER_LIMIT_ID || '').trim();
  const preferredLimitId = preferredLimitIdRaw || APP_SERVER_LIMIT_ID;

  const appServerSnapshot = await readSlotUsageViaAppServer(realCodex, codexHome, now, {
    timeoutMs,
    retries,
    retryBaseDelayMs,
    preferredLimitId
  });
  if (!appServerSnapshot || !snapshotSuggestsLimitExhausted(appServerSnapshot)) {
    return null;
  }
  return {
    source: 'app_server',
    snapshot: appServerSnapshot
  };
}

async function readLimitSignalFromLocalSessions(codexHome, runStartedAtIso, now = new Date()) {
  const usageSnapshot = await readSlotUsageSnapshot(codexHome, now, {
    notBeforeIso: runStartedAtIso,
    maxFiles: 24
  });
  if (!snapshotSuggestsLimitExhausted(usageSnapshot)) {
    return null;
  }
  return {
    source: 'sessions',
    snapshot: usageSnapshot
  };
}

async function detectLimitSignal(realCodex, codexHome, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const runStartedAtIso = options.runStartedAtIso || null;
  const appServerSignal = await readLimitSignalFromAppServer(realCodex, codexHome, now);
  if (appServerSignal) {
    return appServerSignal;
  }
  if (!runStartedAtIso) {
    return null;
  }
  return await readLimitSignalFromLocalSessions(codexHome, runStartedAtIso, now);
}

async function ensureInitializedFiles() {
  if (!(await pathExists(configPath()))) {
    await writeJsonAtomic(configPath(), defaultConfig());
  }
  if (!(await pathExists(statePath()))) {
    await writeJsonAtomic(statePath(), defaultState());
  }
}

async function withStateLock(fn) {
  return await withFileLock(stateLockPath(), fn);
}

function renderNoSlotReason(config, state, terminalId, now = new Date()) {
  const lines = ['No eligible slot available.'];
  for (const slot of config.slots) {
    const slotState = state.slots?.[slot.id];
    const enabled = slot.enabled ? 'enabled' : 'disabled';
    const status = slotState?.status || 'ready';
    const blockedUntil = slotState?.blocked_until || '-';
    if (!slot.enabled) {
      lines.push(`- ${slot.id}: ${enabled}`);
      continue;
    }

    if (slotState?.blocked_until) {
      const ts = new Date(slotState.blocked_until);
      if (!Number.isNaN(ts.getTime()) && ts > now) {
        lines.push(`- ${slot.id}: ${status} until ${blockedUntil}`);
      } else {
        lines.push(`- ${slot.id}: ${status} (block expired; run 'codex-rotor unblock ${slot.id}' if needed)`);
      }
      continue;
    }

    if (slotState?.status === 'blocked_auth') {
      lines.push(`- ${slot.id}: blocked_auth`);
      continue;
    }

    const lease = state.leases?.[slot.id];
    if (lease && lease.terminal_id && lease.terminal_id !== terminalId) {
      lines.push(`- ${slot.id}: leased by ${lease.terminal_id} (pid ${lease.pid ?? '-'})`);
      continue;
    }

    lines.push(`- ${slot.id}: ${status}`);
  }
  return lines.join('\n');
}

async function acquireSlotForRun({
  terminalId,
  command,
  rotationEligible = false,
  excludedSlotIds = new Set()
}) {
  return await withStateLock(async () => {
    await ensureInitializedFiles();

    const config = await loadConfig();
    const state = await loadState();
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);
    ensureAllSlotStates(config, state);
    ensureRuntimeState(state);
    ensureSessionState(state, terminalId);
    await reconcileSlots(config, state);
    reapStaleLeases(state);
    const configAfter = JSON.stringify(config);
    const now = new Date();
    const session = state.sessions?.[terminalId];
    const mode = config.scheduling?.mode || 'terminal_pinned';
    const preferred = mode === 'terminal_pinned'
      ? (session?.suggested_slot || session?.last_slot || state.active_slot || config.default_slot)
      : (state.active_slot || config.default_slot);
    const excluded = new Set(excludedSlotIds);

    let slot = null;
    let lease = null;
    let preflightRotated = false;
    while (true) {
      slot = pickEligibleSlot(config, state, preferred, now, { terminalId, excludeSlotIds: excluded });
      if (!slot) break;
      const leaseTry = acquireSlotLease(state, {
        slotId: slot.id,
        terminalId,
        pid: process.pid
      }, { now });
      if (leaseTry.acquired) {
        if (rotationEligible) {
          const identity = await readSlotAuthIdentity(slot.codex_home);
          const snapshot = await readSlotUsageSnapshot(slot.codex_home, now, {
            notBeforeIso: identity?.last_refresh || null,
            maxFiles: 24
          });
          if (snapshotLimitIsStillActive(snapshot)) {
            applyFailurePolicy({
              config,
              state,
              slotId: slot.id,
              failureType: 'limit_exhausted',
              terminalId,
              command,
              now
            });
            releaseSlotLease(state, {
              slotId: slot.id,
              leaseId: leaseTry.lease_id || null,
              terminalId,
              pid: process.pid
            });
            excluded.add(slot.id);
            preflightRotated = true;
            continue;
          }
        }
        lease = leaseTry;
        break;
      }
      excluded.add(slot.id);
    }

    const stateAfter = JSON.stringify(state);
    if (configAfter !== configBefore) {
      await saveConfig(config);
    }
    if (stateAfter !== stateBefore) {
      await saveState(state);
    }

    if (!slot) {
      return {
        slot: null,
        config,
        noSlotMessage: renderNoSlotReason(config, state, terminalId, now),
        noSlotNotifyMessage: `codex-rotor: all slots unavailable at ${iso(now)}`
      };
    }

    return {
      slot,
      config,
      terminalId,
      leaseId: lease?.lease_id || null,
      command,
      preflightRotated
    };
  });
}

async function applyLimitPolicyAndReleaseLease({ slotId, leaseId, terminalId, command, now = new Date() }) {
  return await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    ensureAllSlotStates(config, state);
    ensureRuntimeState(state);
    ensureSessionState(state, terminalId);
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);
    await reconcileSlots(config, state);
    reapStaleLeases(state);

    releaseSlotLease(state, {
      slotId,
      leaseId,
      terminalId,
      pid: process.pid
    });

    const policy = applyFailurePolicy({
      config,
      state,
      slotId,
      failureType: 'limit_exhausted',
      terminalId,
      command,
      now
    });

    const configAfter = JSON.stringify(config);
    const stateAfter = JSON.stringify(state);
    if (configAfter !== configBefore) {
      await saveConfig(config);
    }
    if (stateAfter !== stateBefore || policy.changed) {
      await saveState(state);
    }

    return {
      config,
      policy,
      slotStatus: state.slots?.[slotId]?.status ?? 'blocked'
    };
  });
}

export async function runCodexWrapper(argv) {
  const terminalId = resolveTerminalId(process.env);
  const command = findTopLevelToken(argv) || null;
  const rotationEligible = isRotationEligibleInvocation(argv);
  const realCodex = findRealCodex(process.argv[1]);
  const preflightLimitRetryMax = 6;
  const preflightExcludedSlots = new Set();

  let pre = null;
  let preflightRotationCount = 0;
  while (true) {
    pre = await acquireSlotForRun({
      terminalId,
      command,
      rotationEligible,
      excludedSlotIds: preflightExcludedSlots
    });

  if (!pre.slot) {
    console.error(pre.noSlotMessage);
    await notifyTelegram(pre.config, pre.noSlotNotifyMessage);
    return 2;
  }

  if (pre.preflightRotated) {
    const note = `codex-rotor: preflight detected active limit and switched slot before launch (${pre.terminalId}).`;
    console.error(note);
    await notifyTelegram(pre.config, note);
  }

    if (!rotationEligible) {
      break;
    }

    const preflightLimitSignal = await detectLimitSignal(realCodex, pre.slot.codex_home, {
      now: new Date()
    });
    if (!preflightLimitSignal) {
      break;
    }

    preflightExcludedSlots.add(pre.slot.id);
    const preflightPolicy = await applyLimitPolicyAndReleaseLease({
      slotId: pre.slot.id,
      leaseId: pre.leaseId,
      terminalId: pre.terminalId,
      command: pre.command,
      now: new Date()
    });

    preflightRotationCount += 1;
    if (preflightPolicy.policy.rotatedTo) {
      const note = `codex-rotor: preflight rotated slot ${pre.slot.id} -> ${preflightPolicy.policy.rotatedTo} after detected limit (${pre.terminalId}).`;
      console.error(note);
      await notifyTelegram(preflightPolicy.config, note);
    } else if (preflightPolicy.policy.action !== 'no_policy_change') {
      await notifyTelegram(
        preflightPolicy.config,
        `codex-rotor: preflight marked slot ${pre.slot.id} as ${preflightPolicy.slotStatus} after detected limit`
      );
    }

    if (preflightRotationCount >= preflightLimitRetryMax) {
      const stopMessage = 'codex-rotor: preflight rotation guard reached; stop to avoid loop.';
      console.error(stopMessage);
      await notifyTelegram(preflightPolicy.config, stopMessage);
      return 2;
    }
  }

  const slot = pre.slot;
  const env = {
    ...process.env,
    CODEX_HOME: slot.codex_home,
    CODEX_ACTIVE_SLOT: slot.id
  };

  const runStartedAtIso = iso();
  const runResult = await runWithStderrTail(realCodex, argv, env);
  let failType = classifyFailure(runResult);

  if (
    rotationEligible
    && (failType === 'interrupt' || failType === 'startup_failure' || failType === 'unknown_failure')
  ) {
    const detectedSignal = await detectLimitSignal(realCodex, slot.codex_home, {
      now: new Date(),
      runStartedAtIso
    });
    if (detectedSignal) {
      failType = 'limit_exhausted';
    }
  }

  const post = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    ensureAllSlotStates(config, state);
    ensureRuntimeState(state);
    ensureSessionState(state, pre.terminalId);
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);
    await reconcileSlots(config, state);
    reapStaleLeases(state);

    releaseSlotLease(state, {
      slotId: slot.id,
      leaseId: pre.leaseId,
      terminalId: pre.terminalId,
      pid: process.pid
    });

    let policy = { changed: false, rotatedTo: null, action: 'no_policy_change' };
    if (failType === 'ok') {
      markOk(state, slot.id, {
        terminalId: pre.terminalId,
        command: pre.command
      });
      policy = { changed: true, rotatedTo: null, action: 'marked_ok' };
    } else if (failType !== 'interrupt' && rotationEligible) {
      policy = applyFailurePolicy({
        config,
        state,
        slotId: slot.id,
        failureType: failType,
        terminalId: pre.terminalId,
        command: pre.command,
        now: new Date()
      });
    } else {
      const session = ensureSessionState(state, pre.terminalId);
      session.last_slot = slot.id;
      session.last_command = pre.command;
      session.updated_at = iso();
    }

    const configAfter = JSON.stringify(config);
    const stateAfter = JSON.stringify(state);
    if (configAfter !== configBefore) {
      await saveConfig(config);
    }
    if (stateAfter !== stateBefore || policy.changed) {
      await saveState(state);
    }

    return {
      config,
      policy,
      slotStatus: state.slots?.[slot.id]?.status ?? 'blocked'
    };
  });

  if (failType === 'ok' || failType === 'interrupt' || !rotationEligible) {
    return runResult.exitCode;
  }

  if (post.policy.rotatedTo) {
    const note = `codex-rotor: rotated slot ${slot.id} -> ${post.policy.rotatedTo} after ${failType} (${pre.terminalId}). Restart codex to continue.`;
    console.error(note);
    await notifyTelegram(post.config, note);
  } else if (post.policy.action !== 'no_policy_change') {
    await notifyTelegram(
      post.config,
      `codex-rotor: slot ${slot.id} marked ${post.slotStatus} after ${failType}`
    );
  }

  return runResult.exitCode;
}
