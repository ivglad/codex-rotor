import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRealCodex } from '../src/core/real-codex.js';

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

test('findRealCodex avoids PATH wrapper shim recursion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-real-bin-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const fakeBin = path.join(root, 'bin');
  const fakeGlobalCodex = path.join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(path.dirname(fakeGlobalCodex), { recursive: true });
  await fs.writeFile(fakeGlobalCodex, '#!/usr/bin/env node\nconsole.log("ok")\n', { mode: 0o755 });

  const wrapperPath = path.join(process.cwd(), 'bin', 'codex.js');
  const pathShim = path.join(fakeBin, 'codex');
  await fs.writeFile(pathShim, `#!/usr/bin/env bash\nexec node ${wrapperPath} \"$@\"\n`, { mode: 0o755 });

  await withEnv(
    {
      CODEX_REAL_BIN: null,
      PATH: fakeBin,
      npm_config_prefix: root
    },
    async () => {
      const resolved = findRealCodex(wrapperPath);
      assert.notEqual(resolved, pathShim);
      assert.equal(resolved, fakeGlobalCodex);
    }
  );
});

test('findRealCodex rejects CODEX_REAL_BIN when it points to wrapper', async () => {
  const wrapperPath = path.join(process.cwd(), 'bin', 'codex.js');
  await withEnv(
    {
      CODEX_REAL_BIN: wrapperPath
    },
    async () => {
      assert.throws(
        () => findRealCodex(wrapperPath),
        /CODEX_REAL_BIN points to codex-rotor wrapper/
      );
    }
  );
});
