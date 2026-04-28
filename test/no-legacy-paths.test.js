import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

async function loadPathsModule() {
  return import(`../src/config/paths.js?noLegacy=${Date.now()}-${Math.random()}`);
}

test('paths ignore legacy CODEX_AUTOROTATE_* env vars', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-home-'));
  t.after(async () => fs.rm(home, { recursive: true, force: true }));

  await withEnv(
    {
      HOME: home,
      CODEX_ROTOR_CONFIG_PATH: null,
      CODEX_ROTOR_STATE_PATH: null,
      CODEX_ROTOR_LOGS_DIR: null,
      CODEX_ROTOR_MAIN_HOME: null,
      CODEX_ROTOR_SLOTS_DIR: null,
      CODEX_AUTOROTATE_CONFIG_PATH: path.join(home, 'legacy-config.json'),
      CODEX_AUTOROTATE_STATE_PATH: path.join(home, 'legacy-state.json'),
      CODEX_AUTOROTATE_LOGS_DIR: path.join(home, 'legacy-logs'),
      CODEX_AUTOROTATE_MAIN_HOME: path.join(home, 'legacy-main-home'),
      CODEX_AUTOROTATE_SLOTS_DIR: path.join(home, 'legacy-slots')
    },
    async () => {
      const paths = await loadPathsModule();

      assert.equal(paths.configPath(), path.join(home, '.config', 'codex-rotor', 'config.json'));
      assert.equal(paths.statePath(), path.join(home, '.local', 'state', 'codex-rotor', 'state.json'));
      assert.equal(paths.logsDir(), path.join(home, '.local', 'state', 'codex-rotor', 'logs'));
      assert.equal(paths.defaultSlotHome('main'), path.join(home, '.codex'));
      assert.equal(paths.defaultSlotHome('slot-1'), path.join(home, '.codex-slots', 'slot-1'));
    }
  );
});

test('paths do not fall back to old codex-autorotate filesystem locations', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-home-'));
  t.after(async () => fs.rm(home, { recursive: true, force: true }));

  const legacyConfig = path.join(home, '.config', 'codex-autorotate', 'config.json');
  const legacyState = path.join(home, '.local', 'state', 'codex-autorotate', 'state.json');
  const legacyLogs = path.join(home, '.local', 'state', 'codex-autorotate', 'logs');

  await fs.mkdir(path.dirname(legacyConfig), { recursive: true });
  await fs.mkdir(path.dirname(legacyState), { recursive: true });
  await fs.mkdir(legacyLogs, { recursive: true });
  await fs.writeFile(legacyConfig, '{}\n');
  await fs.writeFile(legacyState, '{}\n');

  await withEnv(
    {
      HOME: home,
      CODEX_ROTOR_CONFIG_PATH: null,
      CODEX_ROTOR_STATE_PATH: null,
      CODEX_ROTOR_LOGS_DIR: null,
      CODEX_AUTOROTATE_CONFIG_PATH: null,
      CODEX_AUTOROTATE_STATE_PATH: null,
      CODEX_AUTOROTATE_LOGS_DIR: null
    },
    async () => {
      const paths = await loadPathsModule();

      assert.equal(paths.configPath(), path.join(home, '.config', 'codex-rotor', 'config.json'));
      assert.equal(paths.statePath(), path.join(home, '.local', 'state', 'codex-rotor', 'state.json'));
      assert.equal(paths.logsDir(), path.join(home, '.local', 'state', 'codex-rotor', 'logs'));
    }
  );
});
