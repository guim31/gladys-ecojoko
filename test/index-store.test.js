import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexStore, weekToDailyKwh } from '../src/index-store.js';

let dataDir;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ecojoko-index-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const kwhOf = (entry) => entry?.kwh ?? null;

test('weekToDailyKwh maps the 7 Monday-first entries to dates', () => {
  const week = [1, 2, 3, 4, 5, 6, 7].map((kwh) => ({ kwh }));
  const daily = weekToDailyKwh(week, '2026-09-10', kwhOf);
  assert.equal(daily['2026-09-07'], 1);
  assert.equal(daily['2026-09-13'], 7);
  assert.equal(Object.keys(daily).length, 7);
  assert.deepEqual(weekToDailyKwh(week.slice(0, 5), '2026-09-10', kwhOf), {}, 'not a full week');
});

test('first run starts the index at today so far and persists', async () => {
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  const result = await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 3.2 } });
  assert.deepEqual(result, { index: 3.2, todayKwh: 3.2 });
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.completed_through, '2026-09-07');
  assert.equal(saved.base_kwh, 0);
  assert.equal(saved.last_index_kwh, 3.2);
});

test('the index grows within the day and folds yesterday at the day change', async () => {
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 3 } });
  let r = await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 7.5 } });
  assert.equal(r.index, 7.5);
  // Next morning: the week array still holds yesterday's final value (8.1).
  r = await store.update({
    today: '2026-09-09',
    dailyKwh: { '2026-09-08': 8.1, '2026-09-09': 0.4 },
  });
  assert.equal(r.index, 8.5);
  assert.equal(r.todayKwh, 0.4);
  assert.equal(store.getState().base_kwh, 8.1);
  assert.equal(store.getState().completed_through, '2026-09-08');
});

test('a restart reloads the persisted fold instead of rewinding to zero', async () => {
  const first = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await first.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 3 } });
  await first.update({ today: '2026-09-09', dailyKwh: { '2026-09-08': 8, '2026-09-09': 1 } });

  const second = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  const r = await second.update({ today: '2026-09-09', dailyKwh: { '2026-09-09': 2 } });
  assert.equal(r.index, 10);
});

test('days missed while stopped are backfilled through fetchWeek', async () => {
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await store.update({ today: '2026-09-05', dailyKwh: { '2026-09-05': 5 } }); // Saturday
  const fetched = [];
  const r = await store.update({
    today: '2026-09-10', // Thursday of the next week
    dailyKwh: { '2026-09-07': 7, '2026-09-08': 8, '2026-09-09': 9, '2026-09-10': 1 },
    fetchWeek: async (isoDate) => {
      fetched.push(isoDate);
      return { '2026-09-05': 5.5, '2026-09-06': 6 };
    },
  });
  assert.deepEqual(fetched, ['2026-09-05'], 'the previous week is fetched once');
  // 5.5 + 6 + 7 + 8 + 9 (completed days) + 1 (today)
  assert.equal(r.index, 36.5);
  assert.equal(store.getState().completed_through, '2026-09-09');
});

test('a day nobody knows counts as zero and the fold still advances', async () => {
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 3 } });
  const r = await store.update({
    today: '2026-09-10',
    dailyKwh: { '2026-09-10': 2 },
    fetchWeek: async () => {
      throw new Error('cloud down');
    },
  });
  // 0 (unknown 09-08) + 0 (unknown 09-09) + 2 (today) = 2, clamped to the last
  // published value: the lost days are gone, the index must not go backwards.
  assert.equal(r.index, 3);
  assert.equal(r.todayKwh, 2);
  assert.equal(store.getState().completed_through, '2026-09-09');
});

test('the index never decreases when ecojoko revises a value downward', async () => {
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 5 } });
  const r = await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 4.2 } });
  assert.equal(r.index, 5);
  assert.equal(r.todayKwh, 4.2, 'today so far is reported as-is');
});

test('an unreadable or foreign state file is ignored, not fatal', async () => {
  const { writeFile } = await import('node:fs/promises');
  const store = createIndexStore({ dataDir, meterKey: 'gw-pm' });
  await writeFile(store.file, '{not json');
  const r = await store.update({ today: '2026-09-08', dailyKwh: { '2026-09-08': 1 } });
  assert.equal(r.index, 1);
});
