import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('package contract: codex-rotor does not bundle upstream @openai/codex', async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  assert.equal(pkg.name, '@ivglad/codex-rotor');
  assert.equal(Object.hasOwn(pkg.dependencies || {}, '@openai/codex'), false);
  assert.equal(Object.hasOwn(pkg.peerDependencies || {}, '@openai/codex'), false);
});
