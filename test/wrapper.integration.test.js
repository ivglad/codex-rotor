import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCodexWrapper } from '../src/cli/codex-wrapper.js';
import { spawnWrapperProcess, readJsonl as readJsonlFile } from './helpers/wrapper-harness.js';

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function makeAuthJson({ accountId, workspaceId, email, planType = 'team' }) {
  const authClaim = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
    chatgpt_user_id: `user-${accountId}`,
    user_id: `user-${accountId}`,
    organizations: [{ id: workspaceId, title: 'Workspace', is_default: true }],
    groups: []
  };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: '2026-04-27T10:00:00.000Z',
    tokens: {
      id_token: makeJwt({ email, [ 'https://api.openai.com/auth' ]: authClaim }),
      access_token: makeJwt({ [ 'https://api.openai.com/auth' ]: authClaim })
    }
  };
}

async function mkSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-test-'));
  const config = path.join(root, 'config.json');
  const state = path.join(root, 'state.json');
  const logPath = path.join(root, 'fake-log.jsonl');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  const mainHome = path.join(root, '.codex-main');
  const altHome = path.join(root, '.codex-alt');
  await fs.mkdir(mainHome, { recursive: true });
  await fs.mkdir(altHome, { recursive: true });
  await fs.writeFile(path.join(mainHome, 'auth.json'), `${JSON.stringify(makeAuthJson({
    accountId: 'acc-main',
    workspaceId: 'org-main',
    email: 'main@example.com',
    planType: 'prolite'
  }), null, 2)}\n`);
  await fs.writeFile(path.join(altHome, 'auth.json'), `${JSON.stringify(makeAuthJson({
    accountId: 'acc-alt',
    workspaceId: 'org-alt',
    email: 'alt@example.com',
    planType: 'team'
  }), null, 2)}\n`);

  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import fs from 'node:fs';

const mode = process.env.FAKE_CODEX_MODE || 'success';
const appServerMode = process.env.FAKE_APP_SERVER_MODE || 'none';
const log = process.env.FAKE_CODEX_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    argv: process.argv.slice(2),
    codex_home: process.env.CODEX_HOME,
    active_slot: process.env.CODEX_ACTIVE_SLOT,
    terminal_id: process.env.CODEX_ROTOR_TERMINAL_ID || null
  }) + '\\n');
}

if (process.argv[2] === 'app-server') {
  if (appServerMode === 'exit_early') {
    process.exit(0);
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf('\\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === 'initialize' && msg.id) {
        process.stdout.write(JSON.stringify({
          id: msg.id,
          result: {
            codexHome: process.env.CODEX_HOME || null,
            platformFamily: 'unix',
            platformOs: 'linux'
          }
        }) + '\\n');
        continue;
      }
      if (msg.method === 'account/rateLimits/read' && msg.id) {
        const home = String(process.env.CODEX_HOME || '');
        const codexLimitReached = appServerMode === 'limit'
          || (appServerMode === 'main_limit' && home.endsWith('.codex-main'));
        const bengalfoxLimitReached = appServerMode === 'bengalfox_limit'
          || (appServerMode === 'main_bengalfox_limit' && home.endsWith('.codex-main'));
        process.stdout.write(JSON.stringify({
          id: msg.id,
          result: {
            rateLimits: {
              limitId: 'codex',
              planType: 'team',
              primary: {
                usedPercent: codexLimitReached ? 100 : 12,
                windowDurationMins: 300,
                resetsAt: Math.floor(Date.now() / 1000) + 3600
              },
              secondary: {
                usedPercent: 15,
                windowDurationMins: 10080,
                resetsAt: Math.floor(Date.now() / 1000) + 86400
              },
              rateLimitReachedType: codexLimitReached ? 'rate_limit_reached' : null
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: 'codex',
                planType: 'team',
                primary: {
                  usedPercent: codexLimitReached ? 100 : 12,
                  windowDurationMins: 300,
                  resetsAt: Math.floor(Date.now() / 1000) + 3600
                },
                secondary: {
                  usedPercent: 15,
                  windowDurationMins: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400
                },
                rateLimitReachedType: codexLimitReached ? 'rate_limit_reached' : null
              },
              codex_bengalfox: {
                limitId: 'codex_bengalfox',
                planType: 'team',
                primary: {
                  usedPercent: bengalfoxLimitReached ? 100 : 7,
                  windowDurationMins: 300,
                  resetsAt: Math.floor(Date.now() / 1000) + 3600
                },
                secondary: {
                  usedPercent: 10,
                  windowDurationMins: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400
                },
                rateLimitReachedType: bengalfoxLimitReached ? 'rate_limit_reached' : null
              }
            }
          }
        }) + '\\n');
      }
    }
  });
  setTimeout(() => process.exit(0), 5000);
}

else if (mode === 'limit') {
  console.error('rate limit reached');
  process.exit(1);
} else if (mode === 'limit130') {
  console.error('rate limit reached');
  process.exit(130);
} else if (mode === 'limit130_structured') {
  const home = process.env.CODEX_HOME;
  if (home) {
    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const dir = home + '/sessions/' + y + '/' + m + '/' + d;
    fs.mkdirSync(dir, { recursive: true });
    const sampleLine = JSON.stringify({
      timestamp: now.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'team',
          rate_limit_reached_type: 'primary',
          primary: {
            used_percent: 100,
            window_minutes: 300,
            resets_at: Math.floor(Date.now() / 1000) + 3600
          },
          secondary: {
            used_percent: 42,
            window_minutes: 10080,
            resets_at: Math.floor(Date.now() / 1000) + 86400
          }
        }
      }
    });
    const fileName = 'rollout-' + now.toISOString().replace(/[:.]/g, '-') + '-structured.jsonl';
    fs.appendFileSync(dir + '/' + fileName, sampleLine + '\\n');
  }
  process.exit(130);
} else if (mode === 'limit_stdout') {
  console.log('rate limit reached');
  process.exit(1);
} else if (mode === 'auth') {
  console.error('not logged in');
  process.exit(1);
} else if (mode === 'unknown') {
  console.error('unexpected crash');
  process.exit(1);
} else if (mode === 'sleep_success') {
  const ms = Number(process.env.FAKE_CODEX_SLEEP_MS || 350);
  await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 350));
  process.exit(0);
} else {
  process.exit(0);
}
`,
    { mode: 0o755 }
  );

  const baseConfig = {
    schema_version: 2,
    default_slot: 'main',
    slots: [
      { id: 'main', label: 'Main', codex_home: mainHome, priority: 100, enabled: true },
      { id: 'alt', label: 'Alt', codex_home: altHome, priority: 90, enabled: true }
    ],
    rotation: {
      max_retries: 1,
      quick_fail_seconds: 50,
      limit_block_seconds: 3600,
      auth_block_seconds: 900,
      unknown_block_seconds: 300
    },
    scheduling: {
      mode: 'terminal_pinned'
    },
    notifications: {
      telegram_enabled: false,
      bot_token_env: 'CODEX_ROTOR_TELEGRAM_BOT_TOKEN',
      chat_id_env: 'CODEX_ROTOR_TELEGRAM_CHAT_ID'
    }
  };
  const baseState = {
    schema_version: 2,
    active_slot: 'main',
    last_rotation_at: null,
    last_rotation_reason: null,
    sessions: {},
    leases: {},
    slots: {
      main: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null },
      alt: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null }
    }
  };
  await fs.writeFile(config, `${JSON.stringify(baseConfig, null, 2)}\n`);
  await fs.writeFile(state, `${JSON.stringify(baseState, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'state.initial.json'), `${JSON.stringify(baseState, null, 2)}\n`);
  return { root, config, state, logPath, fakeCodex, mainHome, altHome };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeRateLimitSnapshot(codexHome, {
  timestampIso,
  primaryUsedPercent = 100,
  secondaryUsedPercent = 0,
  primaryResetEpoch = Math.floor(Date.now() / 1000) + 3600,
  secondaryResetEpoch = Math.floor(Date.now() / 1000) + 86400
}) {
  const ts = new Date(timestampIso);
  const y = String(ts.getUTCFullYear());
  const m = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ts.getUTCDate()).padStart(2, '0');
  const dir = path.join(codexHome, 'sessions', y, m, d);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    timestamp: ts.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        plan_type: 'team',
        rate_limit_reached_type: 'primary',
        primary: {
          used_percent: primaryUsedPercent,
          window_minutes: 300,
          resets_at: primaryResetEpoch
        },
        secondary: {
          used_percent: secondaryUsedPercent,
          window_minutes: 10080,
          resets_at: secondaryResetEpoch
        }
      }
    }
  });
  const fileName = `rollout-${ts.toISOString().replace(/[:.]/g, '-')}-preflight.jsonl`;
  await fs.writeFile(path.join(dir, fileName), `${line}\n`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_RUNNER = path.resolve(__dirname, 'helpers', 'wrapper-child-runner.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSandboxEnv(sandbox, fn) {
  const old = {
    CODEX_ROTOR_CONFIG_PATH: process.env.CODEX_ROTOR_CONFIG_PATH,
    CODEX_ROTOR_STATE_PATH: process.env.CODEX_ROTOR_STATE_PATH,
    CODEX_REAL_BIN: process.env.CODEX_REAL_BIN,
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
    FAKE_APP_SERVER_MODE: process.env.FAKE_APP_SERVER_MODE,
    CODEX_ROTOR_TERMINAL_ID: process.env.CODEX_ROTOR_TERMINAL_ID,
    CODEX_ROTOR_APP_SERVER_LIMIT_ID: process.env.CODEX_ROTOR_APP_SERVER_LIMIT_ID,
    CODEX_ROTOR_APP_SERVER_TIMEOUT_MS: process.env.CODEX_ROTOR_APP_SERVER_TIMEOUT_MS,
    CODEX_ROTOR_APP_SERVER_RETRIES: process.env.CODEX_ROTOR_APP_SERVER_RETRIES,
    CODEX_ROTOR_APP_SERVER_RETRY_BASE_DELAY_MS: process.env.CODEX_ROTOR_APP_SERVER_RETRY_BASE_DELAY_MS
  };
  process.env.CODEX_ROTOR_CONFIG_PATH = sandbox.config;
  process.env.CODEX_ROTOR_STATE_PATH = sandbox.state;
  process.env.CODEX_REAL_BIN = sandbox.fakeCodex;
  process.env.FAKE_CODEX_LOG = sandbox.logPath;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('wrapper passes through success and updates last_ok', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    const code = await runCodexWrapper(['--version']);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.ok(state.slots.main.last_ok);
  const logs = await fs.readFile(sb.logPath, 'utf8');
  assert.match(logs, new RegExp(sb.mainHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('wrapper rotates after explicit limit failure', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit';
    const code = await runCodexWrapper([]);
    assert.equal(code, 1);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
});

test('wrapper rotates after limit failure even with exit 130', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit130';
    const code = await runCodexWrapper([]);
    assert.equal(code, 130);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
});

test('after limit130 rotation, next terminal starts on rotated slot', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit130';
    process.env.CODEX_ROTOR_TERMINAL_ID = 'term-a';
    const first = await runCodexWrapper([]);
    assert.equal(first, 130);

    process.env.FAKE_CODEX_MODE = 'success';
    process.env.CODEX_ROTOR_TERMINAL_ID = 'term-b';
    const second = await runCodexWrapper([]);
    assert.equal(second, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const runs = lines.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].active_slot, 'main');
  assert.equal(runs[1].active_slot, 'alt');
  assert.equal(runs[0].terminal_id, 'term-a');
  assert.equal(runs[1].terminal_id, 'term-b');
});

test('wrapper preflight-rotates before launch when app-server reports exhausted limit', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'main_limit';
    const code = await runCodexWrapper([]);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  const appServerProbes = lines.filter((entry) => entry.argv[0] === 'app-server');
  const mainRun = lines.find((entry) => entry.argv[0] !== 'app-server');
  assert.equal(appServerProbes.length, 2);
  assert.ok(mainRun);
  assert.equal(mainRun.active_slot, 'alt');
});

test('wrapper preflight rotates from fresh local snapshot even when app-server is neutral', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await writeRateLimitSnapshot(sb.mainHome, {
    timestampIso: new Date().toISOString()
  });

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'none';
    const code = await runCodexWrapper([]);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const appServerProbes = lines.filter((entry) => entry.argv[0] === 'app-server');
  const runs = lines.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].active_slot, 'alt');
  assert.equal(appServerProbes.length, 1);
  assert.equal(appServerProbes[0].codex_home, sb.altHome);
});

test('wrapper returns no-slot when app-server preflight reports limits on all slots', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'limit';
    const code = await runCodexWrapper([]);
    assert.equal(code, 2);
  });

  const state = await readJson(sb.state);
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.equal(state.slots.alt.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
  assert.ok(state.slots.alt.blocked_until);

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const appServerProbes = lines.filter((entry) => entry.argv[0] === 'app-server');
  const runs = lines.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(appServerProbes.length, 2);
  assert.equal(runs.length, 0);
});

test('wrapper preflight ignores stale local limit snapshots older than current auth refresh', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await writeRateLimitSnapshot(sb.mainHome, {
    timestampIso: '2026-04-26T09:00:00.000Z'
  });

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'none';
    const code = await runCodexWrapper([]);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.equal(state.last_rotation_reason, null);
  assert.equal(state.slots.main.status, 'ready');

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const run = lines.find((entry) => entry.argv[0] !== 'app-server');
  assert.ok(run);
  assert.equal(run.active_slot, 'main');
});

test('wrapper supports custom app-server limit id selector', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'main_bengalfox_limit';
    process.env.CODEX_ROTOR_APP_SERVER_LIMIT_ID = 'codex_bengalfox';
    const code = await runCodexWrapper([]);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const run = lines.find((entry) => entry.argv[0] !== 'app-server');
  assert.ok(run);
  assert.equal(run.active_slot, 'alt');
});

test('wrapper keeps running when app-server preflight probe exits early', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_APP_SERVER_MODE = 'exit_early';
    const code = await runCodexWrapper([]);
    assert.equal(code, 0);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.equal(state.last_rotation_reason, null);
  assert.equal(state.slots.main.status, 'ready');

  const logsRaw = await fs.readFile(sb.logPath, 'utf8');
  const lines = logsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const appServerProbes = lines.filter((entry) => entry.argv[0] === 'app-server');
  const runs = lines.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(appServerProbes.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].active_slot, 'main');
});

test('wrapper rotates after interrupt using structured rate-limit snapshot', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit130_structured';
    const code = await runCodexWrapper([]);
    assert.equal(code, 130);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
});

test('wrapper rotates after limit failure reported on stdout', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit_stdout';
    const code = await runCodexWrapper([]);
    assert.equal(code, 1);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'alt');
  assert.equal(state.last_rotation_reason, 'limit_exhausted');
  assert.equal(state.slots.main.status, 'blocked_limit');
  assert.ok(state.slots.main.blocked_until);
});

test('wrapper does not rotate for control commands', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit';
    const code = await runCodexWrapper(['login', 'status']);
    assert.equal(code, 1);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.equal(state.last_rotation_reason, null);
  assert.equal(state.slots.main.status, 'ready');
});

test('wrapper does not rotate for unknown commands', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'limit';
    const code = await runCodexWrapper(['unexpected-command']);
    assert.equal(code, 1);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.equal(state.last_rotation_reason, null);
  assert.equal(state.slots.main.status, 'ready');
});

test('wrapper does not block slot for unknown failures', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'unknown';
    const code = await runCodexWrapper([]);
    assert.equal(code, 1);
  });

  const state = await readJson(sb.state);
  assert.equal(state.active_slot, 'main');
  assert.equal(state.last_rotation_reason, null);
  assert.equal(state.slots.main.status, 'ready');
  assert.equal(state.slots.main.blocked_until, null);
});

test('wrapper reports when all slots unavailable', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  const state = await readJson(sb.state);
  const future = new Date(Date.now() + 3600_000).toISOString();
  state.slots.main.status = 'blocked_limit';
  state.slots.main.blocked_until = future;
  state.slots.alt.status = 'blocked_limit';
  state.slots.alt.blocked_until = future;
  await fs.writeFile(sb.state, `${JSON.stringify(state, null, 2)}\n`);

  await withSandboxEnv(sb, async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    const code = await runCodexWrapper([]);
    assert.equal(code, 2);
  });

  let logs = '';
  try {
    logs = await fs.readFile(sb.logPath, 'utf8');
  } catch {
    logs = '';
  }
  assert.equal(logs.trim(), '');
});

test('parallel wrapper launches use different slots across terminals', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  const envBase = {
    CODEX_ROTOR_CONFIG_PATH: sb.config,
    CODEX_ROTOR_STATE_PATH: sb.state,
    CODEX_REAL_BIN: sb.fakeCodex,
    FAKE_CODEX_MODE: 'sleep_success'
  };

  const procA = spawnWrapperProcess({
    runnerPath: CHILD_RUNNER,
    env: {
      ...envBase,
      CODEX_ROTOR_TERMINAL_ID: 'term-a',
      FAKE_CODEX_LOG: path.join(sb.root, 'term-a.log.jsonl')
    }
  });

  const procB = spawnWrapperProcess({
    runnerPath: CHILD_RUNNER,
    env: {
      ...envBase,
      CODEX_ROTOR_TERMINAL_ID: 'term-b',
      FAKE_CODEX_LOG: path.join(sb.root, 'term-b.log.jsonl')
    }
  });

  const [resA, resB] = await Promise.all([procA.done, procB.done]);
  assert.equal(resA.code, 0);
  assert.equal(resB.code, 0);

  const logsA = await readJsonlFile(path.join(sb.root, 'term-a.log.jsonl'));
  const logsB = await readJsonlFile(path.join(sb.root, 'term-b.log.jsonl'));
  const runsA = logsA.filter((entry) => entry.argv[0] !== 'app-server');
  const runsB = logsB.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(runsA.length, 1);
  assert.equal(runsB.length, 1);
  assert.notEqual(runsA[0].active_slot, runsB[0].active_slot);
});

test('limit in terminal A does not block terminal B slot', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  const envBase = {
    CODEX_ROTOR_CONFIG_PATH: sb.config,
    CODEX_ROTOR_STATE_PATH: sb.state,
    CODEX_REAL_BIN: sb.fakeCodex
  };

  const procB = spawnWrapperProcess({
    runnerPath: CHILD_RUNNER,
    env: {
      ...envBase,
      CODEX_ROTOR_TERMINAL_ID: 'term-b',
      FAKE_CODEX_MODE: 'sleep_success',
      FAKE_CODEX_LOG: path.join(sb.root, 'iso-b.log.jsonl')
    }
  });

  await sleep(120);

  const procA = spawnWrapperProcess({
    runnerPath: CHILD_RUNNER,
    env: {
      ...envBase,
      CODEX_ROTOR_TERMINAL_ID: 'term-a',
      FAKE_CODEX_MODE: 'limit',
      FAKE_CODEX_LOG: path.join(sb.root, 'iso-a.log.jsonl')
    }
  });

  const resA = await procA.done;
  assert.equal(resA.code, 1);

  const stateMid = await readJson(sb.state);
  const logA = await readJsonlFile(path.join(sb.root, 'iso-a.log.jsonl'));
  const logB = await readJsonlFile(path.join(sb.root, 'iso-b.log.jsonl'));
  const runA = logA.filter((entry) => entry.argv[0] !== 'app-server');
  const runB = logB.filter((entry) => entry.argv[0] !== 'app-server');
  assert.equal(runA.length, 1);
  assert.equal(runB.length, 1);

  const slotA = runA[0].active_slot;
  const slotB = runB[0].active_slot;
  assert.notEqual(slotA, slotB);
  assert.equal(stateMid.slots[slotA].status, 'blocked_limit');
  assert.equal(stateMid.slots[slotB].status, 'ready');

  const resB = await procB.done;
  assert.equal(resB.code, 0);
});
