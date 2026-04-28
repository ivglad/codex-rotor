import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileSlots } from '../src/core/slot-reconcile.js';

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function authJson({ accountId, workspaceId, email, planType = 'team', lastRefresh = '2026-04-27T10:00:00.000Z' }) {
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
    last_refresh: lastRefresh,
    tokens: {
      id_token: makeJwt({ email, [ 'https://api.openai.com/auth' ]: authClaim }),
      access_token: makeJwt({ [ 'https://api.openai.com/auth' ]: authClaim, [ 'https://api.openai.com/profile' ]: { email } })
    }
  };
}

async function writeAuth(homePath, payload) {
  await fs.mkdir(homePath, { recursive: true });
  await fs.writeFile(path.join(homePath, 'auth.json'), `${JSON.stringify(authJson(payload), null, 2)}\n`, 'utf8');
}

function baseState(slotIds, active = 'main') {
  const slots = {};
  for (const slotId of slotIds) {
    slots[slotId] = {
      status: 'ready',
      blocked_until: null,
      last_error: null,
      last_error_at: null,
      last_ok: null
    };
  }
  return {
    schema_version: 2,
    active_slot: active,
    last_rotation_at: null,
    last_rotation_reason: null,
    slots
  };
}

test('reconcileSlots removes invalid slots and renumbers auto slots sequentially', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-reconcile-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const mainHome = path.join(root, 'main');
  const slot2Home = path.join(root, 'slot-2');
  const slot3Home = path.join(root, 'slot-3');
  const slot4Home = path.join(root, 'slot-4');

  await writeAuth(mainHome, { accountId: 'acc-main', workspaceId: 'org-main', email: 'main@example.com', planType: 'prolite' });
  await writeAuth(slot2Home, { accountId: 'acc-2', workspaceId: 'org-2', email: 'acc2@example.com' });
  await writeAuth(slot4Home, { accountId: 'acc-4', workspaceId: 'org-4', email: 'acc4@example.com' });
  await fs.mkdir(slot3Home, { recursive: true }); // no auth.json => invalid slot

  const config = {
    schema_version: 2,
    default_slot: 'slot-4',
    slots: [
      { id: 'main', label: 'Main', codex_home: mainHome, priority: 100, enabled: true },
      { id: 'slot-2', label: 'Account 2', codex_home: slot2Home, priority: 98, enabled: true },
      { id: 'slot-3', label: 'Account 3', codex_home: slot3Home, priority: 97, enabled: true },
      { id: 'slot-4', label: 'Account 4', codex_home: slot4Home, priority: 96, enabled: true }
    ]
  };
  const state = baseState(['main', 'slot-2', 'slot-3', 'slot-4'], 'slot-4');

  const result = await reconcileSlots(config, state);

  assert.equal(result.changed, true);
  assert.deepEqual(config.slots.map((slot) => slot.id), ['main', 'slot-1', 'slot-2']);
  assert.deepEqual(config.slots.map((slot) => slot.label), ['Main', 'Account 1', 'Account 2']);
  assert.equal(config.slots[1].codex_home, path.join(root, 'slot-1'));
  assert.equal(config.slots[2].codex_home, path.join(root, 'slot-2'));
  assert.equal(state.active_slot, 'slot-2');
  assert.equal(config.default_slot, 'slot-2');
  assert.deepEqual(result.report.removed_invalid, ['slot-3']);
  assert.equal(config.slots[1].priority, 99);
  assert.equal(config.slots[2].priority, 98);
});

test('reconcileSlots removes duplicate account+workspace slots', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-dedup-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const mainHome = path.join(root, 'main');
  const slot1Home = path.join(root, 'slot-1');
  const slot2Home = path.join(root, 'slot-2');

  await writeAuth(mainHome, { accountId: 'acc-x', workspaceId: 'org-x', email: 'same@example.com' });
  await writeAuth(slot1Home, { accountId: 'acc-x', workspaceId: 'org-x', email: 'same@example.com' });
  await writeAuth(slot2Home, { accountId: 'acc-y', workspaceId: 'org-y', email: 'other@example.com' });

  const config = {
    schema_version: 2,
    default_slot: 'main',
    slots: [
      { id: 'main', label: 'Main', codex_home: mainHome, priority: 100, enabled: true },
      { id: 'slot-1', label: 'Account 1', codex_home: slot1Home, priority: 99, enabled: true },
      { id: 'slot-2', label: 'Account 2', codex_home: slot2Home, priority: 98, enabled: true }
    ]
  };
  const state = baseState(['main', 'slot-1', 'slot-2'], 'main');

  const result = await reconcileSlots(config, state);

  assert.equal(result.changed, true);
  assert.equal(result.report.removed_duplicate.length, 1);
  assert.equal(result.report.removed_duplicate[0].slot_id, 'slot-1');
  assert.equal(result.report.removed_duplicate[0].kept_slot_id, 'main');
  assert.deepEqual(config.slots.map((slot) => slot.id), ['main', 'slot-1']);
  assert.equal(config.slots[1].codex_home, slot2Home);
  assert.equal(result.report.move_conflicts.length, 1);
});

test('reconcileSlots keeps pending_auth slots without auth.json', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-pending-auth-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const mainHome = path.join(root, 'main');
  const slot1Home = path.join(root, 'slot-1');

  await writeAuth(mainHome, { accountId: 'acc-main', workspaceId: 'org-main', email: 'main@example.com' });
  await fs.mkdir(slot1Home, { recursive: true });

  const config = {
    schema_version: 2,
    default_slot: 'main',
    slots: [
      { id: 'main', label: 'Main', codex_home: mainHome, priority: 100, enabled: true },
      { id: 'slot-1', label: 'Account 1', codex_home: slot1Home, priority: 99, enabled: true }
    ]
  };
  const state = baseState(['main', 'slot-1'], 'main');
  state.slots['slot-1'].status = 'pending_auth';

  const result = await reconcileSlots(config, state);

  assert.equal(result.changed, false);
  assert.deepEqual(result.report.removed_invalid, []);
  assert.deepEqual(config.slots.map((slot) => slot.id), ['main', 'slot-1']);
  assert.equal(state.slots['slot-1'].status, 'pending_auth');
});

test('reconcileSlots does not delete conflicting destination home during renumber', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-move-conflict-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const mainHome = path.join(root, 'main');
  const slot2Home = path.join(root, 'slot-2');
  const conflictSlot1Home = path.join(root, 'slot-1');
  const conflictMarker = path.join(conflictSlot1Home, 'keep.txt');

  await writeAuth(mainHome, { accountId: 'acc-main', workspaceId: 'org-main', email: 'main@example.com' });
  await writeAuth(slot2Home, { accountId: 'acc-2', workspaceId: 'org-2', email: 'acc2@example.com' });
  await fs.mkdir(conflictSlot1Home, { recursive: true });
  await fs.writeFile(conflictMarker, 'do-not-delete');

  const config = {
    schema_version: 2,
    default_slot: 'main',
    slots: [
      { id: 'main', label: 'Main', codex_home: mainHome, priority: 100, enabled: true },
      { id: 'slot-2', label: 'Account 2', codex_home: slot2Home, priority: 98, enabled: true }
    ]
  };
  const state = baseState(['main', 'slot-2'], 'main');

  const result = await reconcileSlots(config, state);

  assert.equal(result.changed, true);
  assert.deepEqual(config.slots.map((slot) => slot.id), ['main', 'slot-1']);
  assert.equal(config.slots[1].codex_home, slot2Home);
  await fs.stat(conflictMarker);
  assert.equal(result.report.move_conflicts.length, 1);
  assert.equal(result.report.move_conflicts[0].slot_id, 'slot-1');
});
