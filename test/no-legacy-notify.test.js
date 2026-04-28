import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyTelegram } from '../src/core/notify.js';

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

function withFetchStub(stub, fn) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (oldFetch === undefined) {
        delete globalThis.fetch;
      } else {
        globalThis.fetch = oldFetch;
      }
    });
}

test('notifyTelegram uses CODEX_ROTOR_TELEGRAM_* env vars', async () => {
  let called = 0;

  await withEnv(
    {
      CODEX_ROTOR_TELEGRAM_BOT_TOKEN: 'rotor-token',
      CODEX_ROTOR_TELEGRAM_CHAT_ID: '12345',
      CODEX_ROTATOR_TELEGRAM_BOT_TOKEN: null,
      CODEX_ROTATOR_TELEGRAM_CHAT_ID: null
    },
    async () => {
      await withFetchStub(async () => {
        called += 1;
        return { ok: true };
      }, async () => {
        const ok = await notifyTelegram({ notifications: { telegram_enabled: true } }, 'hello');
        assert.equal(ok, true);
      });
    }
  );

  assert.equal(called, 1);
});

test('notifyTelegram ignores legacy CODEX_ROTATOR_TELEGRAM_* env vars', async () => {
  let called = 0;

  await withEnv(
    {
      CODEX_ROTOR_TELEGRAM_BOT_TOKEN: null,
      CODEX_ROTOR_TELEGRAM_CHAT_ID: null,
      CODEX_ROTATOR_TELEGRAM_BOT_TOKEN: 'legacy-token',
      CODEX_ROTATOR_TELEGRAM_CHAT_ID: 'legacy-chat-id'
    },
    async () => {
      await withFetchStub(async () => {
        called += 1;
        return { ok: true };
      }, async () => {
        const ok = await notifyTelegram({ notifications: { telegram_enabled: true } }, 'hello');
        assert.equal(ok, false);
      });
    }
  );

  assert.equal(called, 0);
});
