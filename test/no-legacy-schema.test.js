import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config-store.js';
import { loadState } from '../src/core/state-store.js';

function withEnv(pairs, fn) {
  const old = {};
  for (const [key, value] of Object.entries(pairs)) {
    old[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('loadConfig ignores legacy accounts schema and falls back to schema v2 defaults', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-legacy-cfg-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, `${JSON.stringify({
    default_account: 'legacy-main',
    accounts: [
      { id: 'legacy-main', codex_home: '/tmp/legacy-main', priority: 100, enabled: true }
    ]
  }, null, 2)}\n`);

  await withEnv(
    {
      CODEX_ROTOR_CONFIG_PATH: configFile
    },
    async () => {
      const config = await loadConfig();
      assert.equal(config.schema_version, 2);
      assert.equal(config.default_slot, 'main');
      assert.equal(config.slots[0].id, 'main');
    }
  );
});

test('loadState ignores legacy accounts schema and falls back to schema v2 defaults', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-legacy-state-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const stateFile = path.join(root, 'state.json');
  await fs.writeFile(stateFile, `${JSON.stringify({
    active_account: 'legacy-main',
    accounts: {
      'legacy-main': {
        blocked_until: null,
        last_error: null,
        last_error_at: null,
        last_ok: null
      }
    }
  }, null, 2)}\n`);

  await withEnv(
    {
      CODEX_ROTOR_STATE_PATH: stateFile
    },
    async () => {
      const state = await loadState();
      assert.equal(state.schema_version, 2);
      assert.equal(state.active_slot, 'main');
      assert.equal(Object.hasOwn(state.slots, 'main'), true);
      assert.equal(Object.hasOwn(state.slots, 'legacy-main'), false);
    }
  );
});
