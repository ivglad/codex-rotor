import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractLatestRateLimitsFromJsonlText,
  normalizeRateLimitsSnapshot,
  readSlotUsageSnapshot
} from '../src/core/usage-snapshot.js';

function tokenCountLine({
  timestamp,
  primaryUsed,
  primaryReset,
  weeklyUsed,
  weeklyReset,
  plan = 'business'
}) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        plan_type: plan,
        primary: {
          used_percent: primaryUsed,
          window_minutes: 300,
          resets_at: primaryReset
        },
        secondary: {
          used_percent: weeklyUsed,
          window_minutes: 10080,
          resets_at: weeklyReset
        }
      }
    }
  });
}

test('extractLatestRateLimitsFromJsonlText returns the latest token_count snapshot', () => {
  const text = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'other' } }),
    tokenCountLine({
      timestamp: '2026-04-26T10:00:00.000Z',
      primaryUsed: 30,
      primaryReset: 1777197600,
      weeklyUsed: 12,
      weeklyReset: 1777600000
    }),
    '{not-json}',
    tokenCountLine({
      timestamp: '2026-04-26T11:00:00.000Z',
      primaryUsed: 40,
      primaryReset: 1777201200,
      weeklyUsed: 13,
      weeklyReset: 1777603600
    })
  ].join('\n');

  const extracted = extractLatestRateLimitsFromJsonlText(text);
  assert.ok(extracted);
  assert.equal(extracted.timestamp, '2026-04-26T11:00:00.000Z');
  assert.equal(extracted.rate_limits.primary.used_percent, 40);
  assert.equal(extracted.rate_limits.secondary.used_percent, 13);
});

test('extractLatestRateLimitsFromJsonlText picks max timestamp even if log order is mixed', () => {
  const text = [
    tokenCountLine({
      timestamp: '2026-04-28T09:31:42.387Z',
      primaryUsed: 10,
      primaryReset: 1777380791,
      weeklyUsed: 2,
      weeklyReset: 1777967591
    }),
    tokenCountLine({
      timestamp: '2026-04-28T09:29:47.742Z',
      primaryUsed: 9,
      primaryReset: 1777380791,
      weeklyUsed: 1,
      weeklyReset: 1777967591
    })
  ].join('\n');

  const extracted = extractLatestRateLimitsFromJsonlText(text);
  assert.ok(extracted);
  assert.equal(extracted.timestamp, '2026-04-28T09:31:42.387Z');
  assert.equal(extracted.rate_limits.primary.used_percent, 10);
});

test('normalizeRateLimitsSnapshot computes left percent and reset countdowns', () => {
  const now = new Date('2026-04-26T10:00:00.000Z');
  const extracted = {
    timestamp: '2026-04-26T09:58:00.000Z',
    rate_limits: {
      limit_id: 'codex',
      plan_type: 'team',
      primary: {
        used_percent: 25,
        window_minutes: 300,
        resets_at: 1777201200
      },
      secondary: {
        used_percent: 60,
        window_minutes: 10080,
        resets_at: 1777600000
      }
    }
  };

  const normalized = normalizeRateLimitsSnapshot(extracted, now);
  assert.ok(normalized);
  assert.equal(normalized.plan_type, 'team');
  assert.equal(normalized.primary.left_percent, 75);
  assert.equal(normalized.primary.resets_in_seconds, 3600);
  assert.equal(normalized.secondary.left_percent, 40);
  assert.equal(normalized.sample_at, '2026-04-26T09:58:00.000Z');
});

test('readSlotUsageSnapshot reads latest rollout file from CODEX_HOME/sessions tree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-usage-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const home = path.join(root, 'slot-home');
  const oldDir = path.join(home, 'sessions', '2026', '04', '25');
  const newDir = path.join(home, 'sessions', '2026', '04', '26');
  await fs.mkdir(oldDir, { recursive: true });
  await fs.mkdir(newDir, { recursive: true });

  await fs.writeFile(
    path.join(oldDir, 'rollout-2026-04-25T08-00-00-old.jsonl'),
    `${tokenCountLine({
      timestamp: '2026-04-25T08:00:00.000Z',
      primaryUsed: 90,
      primaryReset: 1777113600,
      weeklyUsed: 80,
      weeklyReset: 1777600000,
      plan: 'old'
    })}\n`,
    'utf8'
  );

  const newestFile = path.join(newDir, 'rollout-2026-04-26T09-00-00-new.jsonl');
  await fs.writeFile(
    newestFile,
    [
      tokenCountLine({
        timestamp: '2026-04-26T08:59:00.000Z',
        primaryUsed: 10,
        primaryReset: 1777199400,
        weeklyUsed: 20,
        weeklyReset: 1777600000,
        plan: 'business'
      }),
      tokenCountLine({
        timestamp: '2026-04-26T09:01:00.000Z',
        primaryUsed: 15,
        primaryReset: 1777203000,
        weeklyUsed: 21,
        weeklyReset: 1777603600,
        plan: 'business'
      })
    ].join('\n'),
    'utf8'
  );

  const snapshot = await readSlotUsageSnapshot(home, new Date('2026-04-26T09:00:00.000Z'));
  assert.ok(snapshot);
  assert.equal(snapshot.source_file, newestFile);
  assert.equal(snapshot.primary.used_percent, 15);
  assert.equal(snapshot.secondary.used_percent, 21);
  assert.equal(snapshot.plan_type, 'business');
});

test('readSlotUsageSnapshot returns null when session data is missing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-empty-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const snapshot = await readSlotUsageSnapshot(path.join(root, 'empty-home'));
  assert.equal(snapshot, null);
});

test('readSlotUsageSnapshot respects notBeforeIso to avoid stale limits from old auth', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-cutoff-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const home = path.join(root, 'slot-home');
  const dayDir = path.join(home, 'sessions', '2026', '04', '27');
  await fs.mkdir(dayDir, { recursive: true });

  await fs.writeFile(
    path.join(dayDir, 'rollout-2026-04-27T09-00-00-old.jsonl'),
    `${tokenCountLine({
      timestamp: '2026-04-27T09:00:00.000Z',
      primaryUsed: 55,
      primaryReset: 1777299600,
      weeklyUsed: 44,
      weeklyReset: 1777600000
    })}\n`,
    'utf8'
  );

  const snapshot = await readSlotUsageSnapshot(
    home,
    new Date('2026-04-27T10:00:00.000Z'),
    { notBeforeIso: '2026-04-27T09:30:00.000Z' }
  );
  assert.equal(snapshot, null);
});

test('readSlotUsageSnapshot picks newest sample timestamp across recent rollout files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotor-sample-order-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const home = path.join(root, 'slot-home');
  const dayDir = path.join(home, 'sessions', '2026', '04', '28');
  await fs.mkdir(dayDir, { recursive: true });

  const lexicographicallyNewerFile = path.join(
    dayDir,
    'rollout-2026-04-28T14-24-13-older-sample.jsonl'
  );
  const lexicographicallyOlderFile = path.join(
    dayDir,
    'rollout-2026-04-28T13-31-55-newer-sample.jsonl'
  );

  await fs.writeFile(
    lexicographicallyNewerFile,
    `${tokenCountLine({
      timestamp: '2026-04-28T09:25:57.836Z',
      primaryUsed: 7,
      primaryReset: 1777380791,
      weeklyUsed: 1,
      weeklyReset: 1777967591
    })}\n`,
    'utf8'
  );

  await fs.writeFile(
    lexicographicallyOlderFile,
    `${tokenCountLine({
      timestamp: '2026-04-28T09:30:43.258Z',
      primaryUsed: 9,
      primaryReset: 1777380791,
      weeklyUsed: 1,
      weeklyReset: 1777967591
    })}\n`,
    'utf8'
  );

  const snapshot = await readSlotUsageSnapshot(home, new Date('2026-04-28T09:35:00.000Z'));
  assert.ok(snapshot);
  assert.equal(snapshot.sample_at, '2026-04-28T09:30:43.258Z');
  assert.equal(snapshot.source_file, lexicographicallyOlderFile);
  assert.equal(snapshot.primary.used_percent, 9);
});
