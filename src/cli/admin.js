import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, findSlot } from '../core/config-store.js';
import { loadState, saveState, ensureSlotState } from '../core/state-store.js';
import { configPath, stateLockPath, statePath, defaultSlotHome } from '../config/paths.js';
import { defaultConfig, defaultState } from '../config/defaults.js';
import { pathExists, withFileLock, writeJsonAtomic } from '../core/fs.js';
import { findRealCodex } from '../core/real-codex.js';
import { ensureAllSlotStates, ensureSlotDir, normalizeSlotInput, upsertSlot, buildAutoSlot } from '../core/slots.js';
import { pickNextSlot } from '../core/selector.js';
import { iso, parseIso } from '../core/time.js';
import { readSlotUsageSnapshot } from '../core/usage-snapshot.js';
import { formatIdentityCompact } from '../core/slot-identity.js';
import { loadIdentitiesBySlot, reconcileSlots } from '../core/slot-reconcile.js';

function parseArgs(argv) {
  const numericFlags = new Set(['priority', 'interval']);
  const isNumericLiteral = (value) => /^-?\d+(\.\d+)?$/.test(value);
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (
        i + 1 < argv.length
        && (
          !argv[i + 1].startsWith('-')
          || (numericFlags.has(key) && isNumericLiteral(argv[i + 1]))
        )
      ) {
        flags[key] = argv[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

async function runChild(cmd, args, env = process.env) {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function withStateLock(fn) {
  return await withFileLock(stateLockPath(), fn);
}

function formatCompactDuration(totalSeconds) {
  const sec = Number(totalSeconds);
  if (!Number.isFinite(sec)) return '-';
  if (sec <= 0) return '0s';

  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const rounded = Math.round(n * 10) / 10;
  return `${rounded}%`;
}

function formatLeftPercent(windowData) {
  return formatPercent(windowData?.left_percent);
}

function formatSampleAge(usage, now = new Date()) {
  const sampleAt = usage?.sample_at;
  if (!sampleAt) return '-';
  const ts = new Date(sampleAt);
  if (Number.isNaN(ts.getTime())) return '-';
  const ageSec = Math.max(0, Math.floor((now.getTime() - ts.getTime()) / 1000));
  return formatCompactDuration(ageSec);
}

function formatRemainingWindow(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '-';
  return formatCompactDuration(n);
}

function formatCell(value, width) {
  const raw = String(value ?? '-');
  return raw.padStart(width, ' ');
}

function formatStatusHuman(slotState, now = new Date()) {
  const status = String(slotState?.status || 'ready');
  if (status === 'ready') return 'Готов';
  if (status === 'disabled') return 'Отключен';
  if (status === 'pending_auth') return 'Требуется вход';
  if (status === 'blocked_auth') return 'Требуется вход';
  if (status === 'blocked_limit') {
    const until = parseIso(slotState?.blocked_until);
    if (until && until > now) {
      return `Лимит исчерпан (${formatCompactDuration(Math.floor((until.getTime() - now.getTime()) / 1000))})`;
    }
    return 'Лимит исчерпан';
  }
  return status;
}

function formatLimitHuman(usage, identity, now = new Date()) {
  if (!usage) {
    if (identity) {
      return 'Остаток: ожидание первого запроса';
    }
    return 'Остаток: аккаунт не авторизован';
  }
  const p = usage.primary || null;
  const w = usage.secondary || null;
  return `5ч осталось ${formatLeftPercent(p)} (сброс через ${formatRemainingWindow(p?.resets_in_seconds)}), `
    + `неделя осталось ${formatLeftPercent(w)} (сброс через ${formatRemainingWindow(w?.resets_in_seconds)}), `
    + `данные ${formatSampleAge(usage, now)} назад`;
}

function accountText(identity) {
  if (!identity) return '—';
  return identity.email || identity.user_id || identity.account_id || '—';
}

function workspaceText(identity) {
  if (!identity) return '—';
  return identity.workspace_title || identity.workspace_id || '—';
}

async function loadUsageBySlot(config, identitiesBySlot, now = new Date()) {
  const entries = await Promise.all(
    config.slots.map(async (slot) => {
      const identity = identitiesBySlot?.[slot.id] || null;
      const usage = await readSlotUsageSnapshot(slot.codex_home, now, {
        notBeforeIso: identity?.last_refresh || null
      });
      return [slot.id, usage];
    })
  );
  return Object.fromEntries(entries);
}

async function loadReconciledSnapshot() {
  return await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    const beforeConfig = JSON.stringify(config);
    const beforeState = JSON.stringify(state);

    ensureAllSlotStates(config, state);
    const reconciled = await reconcileSlots(config, state);

    const afterConfig = JSON.stringify(config);
    const afterState = JSON.stringify(state);
    const configChanged = beforeConfig !== afterConfig;
    const stateChanged = beforeState !== afterState;
    if (configChanged) {
      await saveConfig(config);
    }
    if (stateChanged) {
      await saveState(state);
    }
    const identitiesBySlot = reconciled.identitiesBySlot || await loadIdentitiesBySlot(config);
    return {
      config,
      state,
      identitiesBySlot,
      reconcileReport: reconciled.report,
      changed: configChanged || stateChanged
    };
  });
}

async function cmdInit() {
  await withStateLock(async () => {
    if (!(await pathExists(configPath()))) {
      await writeJsonAtomic(configPath(), defaultConfig());
    }
    if (!(await pathExists(statePath()))) {
      await writeJsonAtomic(statePath(), defaultState());
    }
  });
  console.log(`Initialized:\n- ${configPath()}\n- ${statePath()}`);
  return 0;
}

async function cmdStatus() {
  const { config, state, identitiesBySlot, reconcileReport } = await loadReconciledSnapshot();
  const now = new Date();
  const usageBySlot = await loadUsageBySlot(config, identitiesBySlot, now);

  console.log(`Активный слот: ${state.active_slot ?? '—'}`);
  console.log('');
  console.log('Слоты:');
  for (const slot of config.slots) {
    const marker = slot.id === state.active_slot ? '*' : ' ';
    const slotState = ensureSlotState(state, slot.id);
    const identity = identitiesBySlot[slot.id] || null;
    const usage = usageBySlot[slot.id] || null;
    const statusHuman = formatStatusHuman(slotState, now);
    const planText = usage?.plan_type || identity?.plan_type || '—';

    console.log(`${marker} ${slot.id} (${slot.label})`);
    console.log(`   Статус: ${statusHuman}`);
    console.log(`   Аккаунт: ${accountText(identity)} | Workspace: ${workspaceText(identity)} | План: ${planText}`);
    console.log(`   ${formatLimitHuman(usage, identity, now)}`);
  }

  const removedInvalid = reconcileReport?.removed_invalid || [];
  const removedDuplicate = reconcileReport?.removed_duplicate || [];
  if (removedInvalid.length > 0 || removedDuplicate.length > 0) {
    console.log('');
    console.log('Автоочистка:');
    if (removedInvalid.length > 0) {
      console.log(`- Удалены невалидные слоты: ${removedInvalid.join(', ')}`);
    }
    if (removedDuplicate.length > 0) {
      for (const dup of removedDuplicate) {
        console.log(`- Удален дубликат ${dup.slot_id} (оставлен ${dup.kept_slot_id})`);
      }
    }
  }
  return 0;
}

async function cmdList() {
  const { config } = await loadReconciledSnapshot();
  for (const slot of config.slots.sort((a, b) => b.priority - a.priority)) {
    console.log(`${slot.id}\t${slot.priority}\tenabled=${slot.enabled}\thome=${slot.codex_home}`);
  }
  return 0;
}

async function cmdSetActive(slotId) {
  const code = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    const slot = findSlot(config, slotId);
    if (!slot) {
      return 1;
    }
    state.active_slot = slotId;
    ensureSlotState(state, slotId);
    await saveState(state);
    return 0;
  });
  if (code !== 0) {
    console.error(`Unknown slot: ${slotId}`);
    return 1;
  }
  console.log(`Active slot set to ${slotId}`);
  return 0;
}

async function cmdRotate() {
  const result = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    const beforeConfig = JSON.stringify(config);
    const beforeState = JSON.stringify(state);
    ensureAllSlotStates(config, state);
    await reconcileSlots(config, state);
    const current = state.active_slot ?? config.default_slot;
    const next = pickNextSlot(config, state, current, new Date());
    if (!next) {
      const afterConfig = JSON.stringify(config);
      const afterState = JSON.stringify(state);
      if (afterConfig !== beforeConfig) {
        await saveConfig(config);
      }
      if (afterState !== beforeState) {
        await saveState(state);
      }
      return { code: 2, current: null, next: null };
    }
    state.active_slot = next.id;
    state.last_rotation_at = iso();
    state.last_rotation_reason = 'manual_rotate';
    const afterConfig = JSON.stringify(config);
    const afterState = JSON.stringify(state);
    if (afterConfig !== beforeConfig) {
      await saveConfig(config);
    }
    if (afterState !== beforeState) {
      await saveState(state);
    }
    return { code: 0, current, next: next.id };
  });
  if (result.code !== 0) {
    console.error('No eligible slot to rotate to');
    return 2;
  }
  const current = result.current;
  const next = result.next;
  console.log(`Rotated active slot: ${current} -> ${next}`);
  return 0;
}

async function cmdUnblock(slotId) {
  const code = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    const slot = findSlot(config, slotId);
    if (!slot) {
      return 1;
    }
    const s = ensureSlotState(state, slotId);
    s.status = slot.enabled ? 'ready' : 'disabled';
    s.blocked_until = null;
    s.last_error = null;
    await saveState(state);
    return 0;
  });
  if (code !== 0) {
    console.error(`Unknown slot: ${slotId}`);
    return 1;
  }
  console.log(`Unblocked slot: ${slotId}`);
  return 0;
}

async function verifyLogin(slot) {
  const real = findRealCodex();
  const env = { ...process.env, CODEX_HOME: slot.codex_home };
  const code = await runChild(real, ['login', 'status'], env);
  return code === 0;
}

async function cmdEnroll(slotId, flags, autoOnly = false) {
  const shouldLogin = flags['no-login'] ? false : true;
  const prepared = await withStateLock(async () => {
    const config = await loadConfig();
    const state = await loadState();

    let slot = null;
    try {
      slot = (slotId || autoOnly)
        ? (slotId
          ? normalizeSlotInput({
              id: slotId,
              label: flags.label,
              codexHome: flags['codex-home'] || defaultSlotHome(slotId),
              priority: Number(flags.priority ?? 100),
              enabled: (flags.disabled === true || String(flags.disabled).toLowerCase() === 'true') ? false : true
            })
          : buildAutoSlot(config))
        : null;
    } catch (err) {
      return {
        code: 1,
        slot: null,
        error: err?.message || String(err),
        usage: false
      };
    }

    if (!slot) {
      return { code: 1, slot: null, error: null, usage: true };
    }

    await ensureSlotDir(slot);
    upsertSlot(config, state, slot);
    const slotState = ensureSlotState(state, slot.id);
    slotState.status = 'pending_auth';
    slotState.blocked_until = null;
    slotState.last_error = null;

    if (!state.active_slot) {
      state.active_slot = slot.id;
    }

    await saveConfig(config);
    await saveState(state);

    return {
      code: 0,
      slot,
      error: null,
      usage: false
    };
  });

  if (prepared.code !== 0) {
    if (prepared.error) {
      console.error(prepared.error);
      return 1;
    }
    console.error('Usage: codex-rotor add [--no-login]  OR  codex-rotor enroll <slot-id> [--codex-home PATH] [--priority N] [--label TEXT] [--no-login]');
    return 1;
  }

  const slot = prepared.slot;

  if (autoOnly || !slotId) {
    console.log(`Auto-added slot ${slot.id}`);
  }

  if (!shouldLogin) {
    console.log(`Slot ${slot.id} saved without login`);
    return 0;
  }

  const real = findRealCodex();
  const env = { ...process.env, CODEX_HOME: slot.codex_home };
  console.log(`Starting login for slot '${slot.id}'...`);
  console.log('Waiting for OAuth completion in browser/device flow...');
  const loginCode = await runChild(real, ['login'], env);
  if (loginCode !== 0) {
    console.error(`Login failed for slot ${slot.id} (exit ${loginCode})`);
    return loginCode;
  }
  const ok = await verifyLogin(slot);
  if (!ok) {
    console.error(`Login status check failed for slot ${slot.id}`);
    return 1;
  }

  await withStateLock(async () => {
    const state = await loadState();
    const slotState = ensureSlotState(state, slot.id);
    slotState.status = 'ready';
    slotState.blocked_until = null;
    slotState.last_error = null;
    await saveState(state);
  });

  const snap = await loadReconciledSnapshot();
  const matched = snap.config.slots.find((item) => item.codex_home === slot.codex_home) || null;
  const identity = matched ? (snap.identitiesBySlot?.[matched.id] || null) : null;
  if (!matched) {
    console.log(`Slot ${slot.id} authenticated but was removed by auto-cleanup (duplicate or invalid).`);
    return 0;
  }
  console.log(`Slot ${matched.id} enrolled and authenticated (${formatIdentityCompact(identity)}).`);
  return 0;
}

async function cmdLoginAll() {
  const initial = await loadReconciledSnapshot();
  const slots = [...initial.config.slots]
    .filter((s) => s.enabled)
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
  if (slots.length === 0) {
    console.error('No enabled slots');
    return 2;
  }

  const real = findRealCodex();
  for (let idx = 0; idx < slots.length; idx += 1) {
    const slot = slots[idx];
    const env = { ...process.env, CODEX_HOME: slot.codex_home };
    console.log(`[${idx + 1}/${slots.length}] login for slot '${slot.id}'`);
    console.log('Waiting for OAuth completion in browser/device flow...');
    const code = await runChild(real, ['login'], env);
    if (code !== 0) {
      console.error(`Login failed for slot ${slot.id} (exit ${code})`);
      return code;
    }
    const ok = await verifyLogin(slot);
    if (!ok) {
      console.error(`Login status check failed for slot ${slot.id}`);
      return 1;
    }

    const snap = await loadReconciledSnapshot();
    const matched = snap.config.slots.find((item) => item.codex_home === slot.codex_home) || null;
    if (!matched) {
      console.log(`Slot ${slot.id} authenticated but removed by auto-cleanup (duplicate/invalid).`);
      continue;
    }
    const identity = snap.identitiesBySlot?.[matched.id] || null;
    console.log(`Slot ${matched.id} authenticated (${formatIdentityCompact(identity)}).`);
  }
  console.log('All enabled slots are authenticated.');
  return 0;
}

function printWatchTable(config, state, usageBySlot, identitiesBySlot, now, interval) {
  console.clear();
  console.log('codex-rotor watch');
  console.log(`time: ${iso(now)}   interval: ${interval}s`);
  console.log('');
  console.log('A  slot            status              5h left  reset      wk left  reset      updated');
  console.log('---------------------------------------------------------------------------------------');
  for (const slot of config.slots) {
    const st = ensureSlotState(state, slot.id);
    const marker = slot.id === state.active_slot ? '*' : ' ';
    const identity = identitiesBySlot?.[slot.id] || null;
    const usage = usageBySlot?.[slot.id] || null;
    const statusHuman = formatStatusHuman(st, now);
    const row = [
      marker,
      slot.id.padEnd(15, ' '),
      statusHuman.padEnd(18, ' '),
      formatCell(formatLeftPercent(usage?.primary), 7),
      formatCell(formatRemainingWindow(usage?.primary?.resets_in_seconds), 8),
      formatCell(formatLeftPercent(usage?.secondary), 7),
      formatCell(formatRemainingWindow(usage?.secondary?.resets_in_seconds), 8),
      formatCell(formatSampleAge(usage, now), 7)
    ].join('  ');
    console.log(row);
    console.log(`   acct=${accountText(identity)} | ws=${workspaceText(identity)} | ${formatLimitHuman(usage, identity, now)}`);
  }
  console.log('---------------------------------------------------------------------------------------');
  console.log('Legend: left = remaining quota in current window.');
  console.log('Ctrl+C to stop');
}

async function cmdWatch(flags) {
  const intervalRaw = Number(flags.interval ?? 5);
  const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : 5;
  while (true) {
    const { config, state, identitiesBySlot } = await loadReconciledSnapshot();
    const now = new Date();
    const usageBySlot = await loadUsageBySlot(config, identitiesBySlot, now);
    printWatchTable(config, state, usageBySlot, identitiesBySlot, now, interval);
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

async function cmdDoctor() {
  const report = [];
  report.push(`node: ${process.version}`);
  report.push(`platform: ${process.platform}/${process.arch}`);
  report.push(`config: ${configPath()}`);
  report.push(`state: ${statePath()}`);

  try {
    const real = findRealCodex();
    report.push(`real_codex: ${real}`);
  } catch (err) {
    report.push(`real_codex_error: ${err.message}`);
  }

  try {
    const cfgExists = await pathExists(configPath());
    const stExists = await pathExists(statePath());
    report.push(`config_exists: ${cfgExists}`);
    report.push(`state_exists: ${stExists}`);
  } catch (err) {
    report.push(`path_check_error: ${err.message}`);
  }

  console.log(report.join('\n'));
  return 0;
}

async function cmdReset(yes) {
  if (!yes) {
    console.error('Use --yes to confirm reset');
    return 1;
  }
  await withStateLock(async () => {
    await fs.rm(configPath(), { force: true });
    await fs.rm(statePath(), { force: true });
  });
  console.log('Reset complete');
  return 0;
}

function printHelp() {
  console.log(`codex-rotor commands:
  init
  add [--no-login]
  enroll <slot-id> [--codex-home PATH] [--priority N] [--label TEXT] [--no-login]
  login-all
  list
  status
  watch [--interval SEC]
  set-active <slot-id>
  rotate
  unblock <slot-id>
  doctor
  reset --yes
`);
}

export async function runAdminCli(argv) {
  const { args, flags } = parseArgs(argv);
  const cmd = args[0] || 'help';

  if (cmd === 'help' || flags.help) {
    printHelp();
    return 0;
  }
  if (cmd === 'init') return cmdInit();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'watch') return cmdWatch(flags);
  if (cmd === 'list') return cmdList();
  if (cmd === 'set-active') return cmdSetActive(args[1]);
  if (cmd === 'rotate') return cmdRotate();
  if (cmd === 'unblock') return cmdUnblock(args[1]);
  if (cmd === 'add') return cmdEnroll(null, flags, true);
  if (cmd === 'enroll') return cmdEnroll(args[1], flags);
  if (cmd === 'login-all') return cmdLoginAll();
  if (cmd === 'doctor') return cmdDoctor();
  if (cmd === 'reset') return cmdReset(flags.yes === true);

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 1;
}
