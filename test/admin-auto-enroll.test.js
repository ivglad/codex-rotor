import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runAdminCli } from '../src/cli/admin.js';
import { defaultSlotHome } from '../src/config/paths.js';

async function mkSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-admin-'));
  const config = path.join(root, 'config.json');
  const state = path.join(root, 'state.json');
  const slotsRoot = path.join(root, 'slots');
  const mainHome = path.join(root, 'main-home');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  const logPath = path.join(root, 'fake-codex-log.jsonl');

  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    args,
    codex_home: process.env.CODEX_HOME
  }) + '\\n');
}
if (args[0] === 'login' || (args[0] === 'login' && args[1] === 'status')) {
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );

  return { root, config, state, slotsRoot, mainHome, fakeCodex, logPath };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function makeJwt(payload) {
  const toB64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${toB64({ alg: 'none', typ: 'JWT' })}.${toB64(payload)}.sig`;
}

function buildAuthJson({ accountId, workspaceId, email, planType = 'team', lastRefresh }) {
  const authClaim = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
    chatgpt_user_id: 'user-test',
    user_id: 'user-test',
    organizations: [
      {
        id: workspaceId,
        title: 'Workspace',
        is_default: true
      }
    ],
    groups: []
  };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: lastRefresh ?? '2026-04-27T00:00:00.000Z',
    tokens: {
      id_token: makeJwt({
        email,
        [ 'https://api.openai.com/auth' ]: authClaim
      }),
      access_token: makeJwt({
        [ 'https://api.openai.com/auth' ]: authClaim,
        [ 'https://api.openai.com/profile' ]: { email }
      }),
      refresh_token: 'dummy'
    }
  };
}

async function withEnv(sb, fn) {
  const old = {
    CODEX_ROTOR_CONFIG_PATH: process.env.CODEX_ROTOR_CONFIG_PATH,
    CODEX_ROTOR_STATE_PATH: process.env.CODEX_ROTOR_STATE_PATH,
    CODEX_ROTOR_SLOTS_DIR: process.env.CODEX_ROTOR_SLOTS_DIR,
    CODEX_ROTOR_MAIN_HOME: process.env.CODEX_ROTOR_MAIN_HOME,
    CODEX_REAL_BIN: process.env.CODEX_REAL_BIN,
    FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG
  };

  process.env.CODEX_ROTOR_CONFIG_PATH = sb.config;
  process.env.CODEX_ROTOR_STATE_PATH = sb.state;
  process.env.CODEX_ROTOR_SLOTS_DIR = sb.slotsRoot;
  process.env.CODEX_ROTOR_MAIN_HOME = sb.mainHome;
  process.env.CODEX_REAL_BIN = sb.fakeCodex;
  process.env.FAKE_CODEX_LOG = sb.logPath;

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('add creates a fully automatic slot with no manual naming/priority/path', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withEnv(sb, async () => {
    assert.equal(await runAdminCli(['init']), 0);
    assert.equal(await runAdminCli(['add', '--no-login']), 0);
  });

  const config = await readJson(sb.config);
  const state = await readJson(sb.state);
  const added = config.slots.find((slot) => slot.id === 'slot-1');
  assert.ok(added);
  assert.equal(added.label, 'Account 1');
  assert.equal(added.priority, 99);
  assert.equal(added.codex_home, path.join(sb.slotsRoot, 'slot-1'));
  assert.equal(state.slots['slot-1'].status, 'pending_auth');
  await fs.stat(path.join(sb.slotsRoot, 'slot-1'));
});

test('add --no-login slot is preserved by status reconcile (pending_auth)', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withEnv(sb, async () => {
    assert.equal(await runAdminCli(['init']), 0);
    assert.equal(await runAdminCli(['add', '--no-login']), 0);
    assert.equal(await runAdminCli(['status']), 0);
  });

  const config = await readJson(sb.config);
  const state = await readJson(sb.state);

  assert.ok(config.slots.find((slot) => slot.id === 'slot-1'));
  assert.equal(state.slots['slot-1'].status, 'pending_auth');
});

test('add performs codex login and status validation for auto slot', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withEnv(sb, async () => {
    assert.equal(await runAdminCli(['init']), 0);
    assert.equal(await runAdminCli(['add']), 0);
  });

  const lines = (await fs.readFile(sb.logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].args, ['login']);
  assert.deepEqual(lines[1].args, ['login', 'status']);
  assert.equal(lines[0].codex_home, path.join(sb.slotsRoot, 'slot-1'));
  assert.equal(lines[1].codex_home, path.join(sb.slotsRoot, 'slot-1'));
});

test('enroll keeps negative priority value when passed as separate arg', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withEnv(sb, async () => {
    assert.equal(await runAdminCli(['init']), 0);
    assert.equal(await runAdminCli(['enroll', 'slot-negative', '--priority', '-5', '--no-login']), 0);
  });

  const config = await readJson(sb.config);
  const slot = config.slots.find((item) => item.id === 'slot-negative');
  assert.ok(slot);
  assert.equal(slot.priority, -5);
});

test('add deduplicates slot when same account+workspace is already authorized', async (t) => {
  const sb = await mkSandbox();
  t.after(async () => fs.rm(sb.root, { recursive: true, force: true }));

  await withEnv(sb, async () => {
    assert.equal(await runAdminCli(['init']), 0);

    const mainAuthPath = path.join(defaultSlotHome('main'), 'auth.json');
    await fs.mkdir(path.dirname(mainAuthPath), { recursive: true });
    await fs.writeFile(mainAuthPath, JSON.stringify(buildAuthJson({
      accountId: 'acc-1',
      workspaceId: 'org-1',
      email: 'same@example.com'
    }), null, 2));

    const slot1Home = path.join(sb.slotsRoot, 'slot-1');
    await fs.mkdir(slot1Home, { recursive: true });
    await fs.writeFile(path.join(slot1Home, 'auth.json'), JSON.stringify(buildAuthJson({
      accountId: 'acc-1',
      workspaceId: 'org-1',
      email: 'same@example.com'
    }), null, 2));

    assert.equal(await runAdminCli(['add']), 0);
  });

  const config = await readJson(sb.config);
  const state = await readJson(sb.state);

  assert.deepEqual(config.slots.map((slot) => slot.id), ['main']);
  assert.ok(!state.slots['slot-1']);
  assert.equal(state.active_slot, 'main');
});
