import { loadConfig, saveConfig } from '../core/config-store.js';
import { loadState, saveState } from '../core/state-store.js';
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

function renderNoSlotReason(config, state, now = new Date()) {
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

    lines.push(`- ${slot.id}: ${status}`);
  }
  return lines.join('\n');
}

export async function runCodexWrapper(argv) {
  const pre = await withStateLock(async () => {
    await ensureInitializedFiles();

    const config = await loadConfig();
    const state = await loadState();
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);
    ensureAllSlotStates(config, state);
    await reconcileSlots(config, state);
    const configAfter = JSON.stringify(config);
    const stateAfter = JSON.stringify(state);
    if (configAfter !== configBefore) {
      await saveConfig(config);
    }
    if (stateAfter !== stateBefore) {
      await saveState(state);
    }

    const now = new Date();
    const preferred = state.active_slot ?? config.default_slot;
    const slot = pickEligibleSlot(config, state, preferred, now);
    if (!slot) {
      return {
        slot: null,
        config,
        noSlotMessage: renderNoSlotReason(config, state, now),
        noSlotNotifyMessage: `codex-rotor: all slots unavailable at ${iso(now)}`
      };
    }

    return { slot, config };
  });

  if (!pre.slot) {
    console.error(pre.noSlotMessage);
    await notifyTelegram(pre.config, pre.noSlotNotifyMessage);
    return 2;
  }

  const slot = pre.slot;

  const realCodex = findRealCodex(process.argv[1]);
  const env = {
    ...process.env,
    CODEX_HOME: slot.codex_home,
    CODEX_ACTIVE_SLOT: slot.id
  };

  const runResult = await runWithStderrTail(realCodex, argv, env);
  const failType = classifyFailure(runResult);

  if (failType === 'ok') {
    await withStateLock(async () => {
      const state = await loadState();
      markOk(state, slot.id);
      await saveState(state);
    });
    return runResult.exitCode;
  }

  if (failType === 'interrupt') {
    return runResult.exitCode;
  }

  if (!isRotationEligibleInvocation(argv)) {
    return runResult.exitCode;
  }

  const post = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    ensureAllSlotStates(config, state);
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);
    await reconcileSlots(config, state);
    const policy = applyFailurePolicy({
      config,
      state,
      slotId: slot.id,
      failureType: failType,
      now: new Date()
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
      slotStatus: state.slots?.[slot.id]?.status ?? 'blocked'
    };
  });

  if (post.policy.rotatedTo) {
    const note = `codex-rotor: rotated slot ${slot.id} -> ${post.policy.rotatedTo} after ${failType}. Restart codex manually to continue.`;
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
