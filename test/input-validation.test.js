import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSlotInput } from '../src/core/slots.js';
import { readJson } from '../src/core/fs.js';

test('normalizeSlotInput rejects unsafe slot ids', () => {
  assert.throws(
    () => normalizeSlotInput({ id: '../evil', codexHome: '/tmp/x', priority: 1 }),
    /slot id must match/
  );
  assert.throws(
    () => normalizeSlotInput({ id: 'bad space', codexHome: '/tmp/x', priority: 1 }),
    /slot id must match/
  );

  const slot = normalizeSlotInput({ id: 'slot-12', codexHome: '/tmp/x', priority: 1 });
  assert.equal(slot.id, 'slot-12');
});

test('readJson throws on malformed JSON instead of silently resetting', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-json-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const badFile = path.join(root, 'bad.json');
  await fs.writeFile(badFile, '{ bad json');

  await assert.rejects(
    () => readJson(badFile, { ok: true }),
    /Invalid JSON/
  );
});
