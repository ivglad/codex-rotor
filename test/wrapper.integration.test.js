import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCodexWrapper } from '../src/cli/codex-wrapper.js';

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
const log = process.env.FAKE_CODEX_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    argv: process.argv.slice(2),
    codex_home: process.env.CODEX_HOME,
    active_slot: process.env.CODEX_ACTIVE_SLOT
  }) + '\\n');
}

if (mode === 'limit') {
  console.error('rate limit reached');
  process.exit(1);
}
if (mode === 'auth') {
  console.error('not logged in');
  process.exit(1);
}
if (mode === 'unknown') {
  console.error('unexpected crash');
  process.exit(1);
}
process.exit(0);
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
    slots: {
      main: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null },
      alt: { status: 'ready', blocked_until: null, last_error: null, last_error_at: null, last_ok: null }
    }
  };
  await fs.writeFile(config, `${JSON.stringify(baseConfig, null, 2)}\n`);
  await fs.writeFile(state, `${JSON.stringify(baseState, null, 2)}\n`);
  return { root, config, state, logPath, fakeCodex, mainHome, altHome };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function withSandboxEnv(sandbox, fn) {
  const old = {
    CODEX_ROTOR_CONFIG_PATH: process.env.CODEX_ROTOR_CONFIG_PATH,
    CODEX_ROTOR_STATE_PATH: process.env.CODEX_ROTOR_STATE_PATH,
    CODEX_REAL_BIN: process.env.CODEX_REAL_BIN,
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG
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
