import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAppServerRateLimitResult,
  readSlotUsageViaAppServer
} from '../src/core/app-server-rate-limits.js';

function makeAppServerResult() {
  return {
    rateLimits: {
      limitId: 'legacy',
      planType: 'legacy-plan',
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: 1777380791
      },
      secondary: null,
      rateLimitReachedType: null
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'team',
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: 1777380791
        },
        secondary: {
          usedPercent: 47,
          windowDurationMins: 10080,
          resetsAt: 1777967591
        },
        rateLimitReachedType: 'rate_limit_reached'
      },
      codex_spark: {
        limitId: 'codex_spark',
        planType: 'team',
        primary: {
          usedPercent: 5,
          windowDurationMins: 300,
          resetsAt: 1777380791
        },
        secondary: null,
        rateLimitReachedType: null
      }
    }
  };
}

test('normalizeAppServerRateLimitResult prefers codex bucket and normalizes shape', () => {
  const now = new Date('2026-04-28T12:00:00.000Z');
  const normalized = normalizeAppServerRateLimitResult(makeAppServerResult(), now);
  assert.ok(normalized);
  assert.equal(normalized.limit_id, 'codex');
  assert.equal(normalized.plan_type, 'team');
  assert.equal(normalized.rate_limit_reached_type, 'rate_limit_reached');
  assert.equal(normalized.primary.used_percent, 100);
  assert.equal(normalized.primary.left_percent, 0);
  assert.equal(normalized.secondary.used_percent, 47);
});

test('normalizeAppServerRateLimitResult falls back to top-level rateLimits payload', () => {
  const now = new Date('2026-04-28T12:00:00.000Z');
  const normalized = normalizeAppServerRateLimitResult({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1777380791
      },
      secondary: null,
      rateLimitReachedType: null
    }
  }, now);
  assert.ok(normalized);
  assert.equal(normalized.limit_id, 'codex');
  assert.equal(normalized.plan_type, 'pro');
  assert.equal(normalized.primary.used_percent, 25);
  assert.equal(normalized.primary.left_percent, 75);
});

test('normalizeAppServerRateLimitResult supports custom preferred limit id', () => {
  const now = new Date('2026-04-28T12:00:00.000Z');
  const normalized = normalizeAppServerRateLimitResult(makeAppServerResult(), now, {
    preferredLimitId: 'codex_spark'
  });
  assert.ok(normalized);
  assert.equal(normalized.limit_id, 'codex_spark');
  assert.equal(normalized.primary.used_percent, 5);
  assert.equal(normalized.rate_limit_reached_type, null);
});

test('readSlotUsageViaAppServer reads and normalizes rate limits from app-server protocol', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-app-server-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const fakeCodex = path.join(root, 'fake-codex-app-server.mjs');
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
let buffer = '';

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

function handleRpc(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize' && msg.id) {
    respond({
      id: msg.id,
      result: {
        codexHome: process.env.CODEX_HOME || null,
        platformFamily: 'unix'
      }
    });
    return;
  }
  if (msg.method === 'account/rateLimits/read' && msg.id) {
    respond({
      id: msg.id,
      result: ${JSON.stringify(makeAppServerResult())}
    });
    setTimeout(() => process.exit(0), 10);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleRpc(line);
  }
});

setTimeout(() => process.exit(0), 5000);
`,
    { mode: 0o755 }
  );

  const now = new Date('2026-04-28T12:00:00.000Z');
  const snapshot = await readSlotUsageViaAppServer(fakeCodex, path.join(root, '.codex-slot'), now, {
    timeoutMs: 3000
  });

  assert.ok(snapshot);
  assert.equal(snapshot.limit_id, 'codex');
  assert.equal(snapshot.plan_type, 'team');
  assert.equal(snapshot.rate_limit_reached_type, 'rate_limit_reached');
  assert.equal(snapshot.primary.used_percent, 100);
});

test('readSlotUsageViaAppServer returns null when app-server closes stdin early', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-app-server-epipe-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const fakeCodex = path.join(root, 'fake-codex-app-server-early-exit.mjs');
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
if (process.argv[2] === 'app-server') {
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );

  const snapshot = await readSlotUsageViaAppServer(
    fakeCodex,
    path.join(root, '.codex-slot'),
    new Date('2026-04-28T12:00:00.000Z'),
    { timeoutMs: 1000 }
  );

  assert.equal(snapshot, null);
});

test('readSlotUsageViaAppServer retries on app-server overload error -32001', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-app-server-retry-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const counterPath = path.join(root, 'attempt-counter.txt');
  await fs.writeFile(counterPath, '0\n');

  const fakeCodex = path.join(root, 'fake-codex-app-server-retry.mjs');
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import fs from 'node:fs';

const counterPath = process.env.FAKE_APP_SERVER_COUNTER;
if (!counterPath) process.exit(2);

function nextAttempt() {
  let prev = 0;
  try {
    prev = Number(fs.readFileSync(counterPath, 'utf8').trim() || '0');
  } catch {
    prev = 0;
  }
  const next = Number.isFinite(prev) ? prev + 1 : 1;
  fs.writeFileSync(counterPath, String(next));
  return next;
}

const attempt = nextAttempt();
let buffer = '';

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

function handleRpc(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize' && msg.id) {
    respond({
      id: msg.id,
      result: {
        codexHome: process.env.CODEX_HOME || null,
        platformFamily: 'unix'
      }
    });
    return;
  }
  if (msg.method === 'account/rateLimits/read' && msg.id) {
    if (attempt === 1) {
      respond({
        id: msg.id,
        error: {
          code: -32001,
          message: 'Server overloaded; retry later.'
        }
      });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    respond({
      id: msg.id,
      result: ${JSON.stringify(makeAppServerResult())}
    });
    setTimeout(() => process.exit(0), 10);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleRpc(line);
  }
});

setTimeout(() => process.exit(0), 5000);
`,
    { mode: 0o755 }
  );

  const oldCounter = process.env.FAKE_APP_SERVER_COUNTER;
  process.env.FAKE_APP_SERVER_COUNTER = counterPath;
  try {
    const snapshot = await readSlotUsageViaAppServer(
      fakeCodex,
      path.join(root, '.codex-slot'),
      new Date('2026-04-28T12:00:00.000Z'),
      {
        timeoutMs: 2000,
        retries: 2,
        retryBaseDelayMs: 10
      }
    );
    assert.ok(snapshot);
    assert.equal(snapshot.limit_id, 'codex');
    assert.equal(snapshot.primary.used_percent, 100);
  } finally {
    if (oldCounter === undefined) {
      delete process.env.FAKE_APP_SERVER_COUNTER;
    } else {
      process.env.FAKE_APP_SERVER_COUNTER = oldCounter;
    }
  }

  const attempts = Number(fssync.readFileSync(counterPath, 'utf8').trim() || '0');
  assert.equal(attempts, 2);
});
