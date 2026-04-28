import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock, pathExists } from '../src/core/fs.js';

test('withFileLock recovers stale lock owned by dead pid', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-lock-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const lockPath = path.join(root, 'state.json.lock');
  await fs.writeFile(lockPath, `${JSON.stringify({ pid: 99999999, created_at: '2026-01-01T00:00:00.000Z' })}\n`);

  const out = await withFileLock(lockPath, async () => 'ok', { timeoutMs: 500 });
  assert.equal(out, 'ok');
  assert.equal(await pathExists(lockPath), false);
});

test('withFileLock times out while an active lock is held', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-lock-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const lockPath = path.join(root, 'state.json.lock');

  await withFileLock(lockPath, async () => {
    await assert.rejects(
      () => withFileLock(lockPath, async () => 'unreachable', { timeoutMs: 150, retryMs: 20 }),
      /Timed out waiting for lock/
    );
  }, { timeoutMs: 500 });

  assert.equal(await pathExists(lockPath), false);
});

test('withFileLock recovers stale lock with unknown owner metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-lock-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const lockPath = path.join(root, 'state.json.lock');
  await fs.writeFile(lockPath, 'not-json-owner-metadata');
  const oldDate = new Date(Date.now() - 5_000);
  await fs.utimes(lockPath, oldDate, oldDate);

  const out = await withFileLock(lockPath, async () => 'ok', {
    timeoutMs: 500,
    unknownOwnerStaleMs: 1_000
  });
  assert.equal(out, 'ok');
  assert.equal(await pathExists(lockPath), false);
});
