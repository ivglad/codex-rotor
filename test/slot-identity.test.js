import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatIdentityCompact, isSameAccountWorkspace, readSlotAuthIdentity } from '../src/core/slot-identity.js';

function makeJwt(payload) {
  const toB64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${toB64({ alg: 'none', typ: 'JWT' })}.${toB64(payload)}.sig`;
}

function buildAuthJson({ accountId, workspaceId, workspaceTitle, email, planType, lastRefresh }) {
  const authClaim = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
    chatgpt_user_id: 'user-x',
    user_id: 'user-x',
    organizations: [
      {
        id: workspaceId,
        title: workspaceTitle,
        is_default: true
      }
    ],
    groups: []
  };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: lastRefresh,
    tokens: {
      id_token: makeJwt({
        email,
        [ 'https://api.openai.com/auth' ]: authClaim
      }),
      access_token: makeJwt({
        [ 'https://api.openai.com/auth' ]: authClaim,
        [ 'https://api.openai.com/profile' ]: { email }
      })
    }
  };
}

test('readSlotAuthIdentity extracts account/workspace fingerprint from auth.json', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-ident-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify(buildAuthJson({
    accountId: 'acc-123',
    workspaceId: 'org-456',
    workspaceTitle: 'My Workspace',
    email: 'me@example.com',
    planType: 'team',
    lastRefresh: '2026-04-27T10:00:00.000Z'
  }), null, 2));

  const identity = await readSlotAuthIdentity(root);
  assert.ok(identity);
  assert.equal(identity.fingerprint, 'acc-123::org-456');
  assert.equal(identity.workspace_title, 'My Workspace');
  assert.equal(identity.email, 'me@example.com');
  assert.equal(identity.plan_type, 'team');
  assert.equal(identity.last_refresh, '2026-04-27T10:00:00.000Z');
  assert.match(formatIdentityCompact(identity), /acct=/);
});

test('isSameAccountWorkspace compares by fingerprint', () => {
  assert.equal(
    isSameAccountWorkspace({ fingerprint: 'a::b' }, { fingerprint: 'a::b' }),
    true
  );
  assert.equal(
    isSameAccountWorkspace({ fingerprint: 'a::b' }, { fingerprint: 'x::y' }),
    false
  );
  assert.equal(
    isSameAccountWorkspace({ fingerprint: null }, { fingerprint: 'x::y' }),
    false
  );
});
