// End-to-end of engine + scheduler against the scripted ecojoko service.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { createClient } from '../src/ecojoko.js';
import { startScheduler, MESSAGES } from '../src/scheduler.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeFetch, GOOD, weekEntries } from './helpers/fakeEcojoko.js';

let dataDir;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ecojoko-sched-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Tuesday 2026-09-08, 10:00 in Paris.
const NOW = new Date('2026-09-08T08:00:00Z');

function makeEngine(config, fakeOptions = {}) {
  const fake = createFakeFetch(fakeOptions);
  const engine = createEngine({
    config,
    dataDir,
    now: () => NOW,
    clientFactory: (creds) => createClient(creds, { fetchImpl: fake.fetchImpl }),
  });
  return { engine, fake };
}

test('a solar account gets a second, independent cumulative index', async () => {
  // Same week, with an exported surplus on Monday and Tuesday.
  const week = weekEntries();
  week[0] = { ...week[0], kwh_prod: '-2.5' };
  week[1] = { ...week[1], kwh_prod: '-1.25' };
  const { engine } = makeEngine(normalizeConfig(GOOD), { week });
  const snapshot = await engine.discover();
  assert.equal(snapshot.capabilities.hasProduction, true);

  const stats = await engine.readStats();
  // Today is Tuesday: the index starts at today's surplus only, as the
  // consumption one does, and the daily value is the magnitude.
  assert.equal(stats.kwhProd, 1.25);
  assert.equal(stats.productionIndex, 1.25);
  assert.notEqual(engine.getProductionIndexState(), null);
  assert.equal(engine.getIndexState().base_kwh, 0, 'the two folds are independent');
});

test('an account without surplus keeps no production index', async () => {
  const { engine } = makeEngine(normalizeConfig(GOOD));
  await engine.discover();
  const stats = await engine.readStats();
  assert.equal(stats.productionIndex, null);
  assert.equal(engine.getProductionIndexState(), null);
});

test('discover takes a capabilities snapshot from this week statistics', async () => {
  const { engine } = makeEngine(normalizeConfig(GOOD));
  const snapshot = await engine.discover();
  assert.equal(snapshot.gateway.gatewayId, '4242');
  assert.deepEqual(snapshot.capabilities, {
    periods: ['Heures Creuses', 'Heures Pleines'],
    hasProduction: false,
    hasTempHum: true,
  });
});

test('readStats publishes today (Tuesday = entry 1) and the synthesized index', async () => {
  const { engine } = makeEngine(normalizeConfig(GOOD));
  await engine.discover();
  const stats = await engine.readStats();
  assert.equal(stats.todayKwh, 11, 'Tuesday entry of the fake week');
  assert.equal(stats.index, 11, 'first run: index = today so far');
  assert.deepEqual(stats.periods[0], { label: 'Heures Creuses', kwh: 5 });
  assert.deepEqual(stats.ambient.temperature, { indoor: 21.5, outdoor: 13.4 });
});

test('the scheduler discovers, publishes devices and first states, then ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const config = normalizeConfig({ ...GOOD, poll_frequency: 10, stats_frequency: 60 });
  const { engine, fake } = makeEngine(config, { realtime: 850 });
  const gladys = createFakeGladys();

  const { stop, poll } = await startScheduler({ gladys, config, engine });
  assert.equal(gladys.discovered.length, 1);
  assert.equal(gladys.discovered[0].length, 2, 'meter + ambient');

  const ids = gladys.published.map((p) => p.featureExternalId);
  assert.ok(ids.includes('ecojoko-meter:4242-11:power'));
  assert.ok(ids.includes('ecojoko-meter:4242-11:index'));
  assert.ok(ids.includes('ecojoko-meter:4242-11:today'));
  assert.ok(ids.includes('ecojoko-meter:4242-11:period-heures-creuses'));
  assert.ok(ids.includes('ecojoko-ambient:4242-12:temperature-indoor'));
  assert.ok(ids.includes('ecojoko-ambient:4242-12:humidity-outdoor'));
  assert.deepEqual(gladys.connectionStatuses.at(-1), { connected: true, message: undefined });

  const realtimeCalls = () =>
    fake.state.calls.filter((c) => c.path.endsWith('realtime_conso')).length;
  const before = realtimeCalls();
  t.mock.timers.tick(10 * 1000);
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  assert.equal(realtimeCalls(), before + 1, 'one live reading per poll_frequency');

  // onPoll fallback: a poll on the meter is an immediate live reading, a poll
  // on the ambient device a statistics refresh, an unknown device is ignored.
  await poll({ external_id: 'ecojoko-meter:4242-11' });
  assert.equal(realtimeCalls(), before + 2, 'poll(meter) reads the live power');
  const statsCalls = () => fake.state.calls.filter((c) => c.path.includes('/powerstat/')).length;
  const statsBefore = statsCalls();
  await poll({ external_id: 'ecojoko-ambient:4242-12' });
  assert.equal(statsCalls(), statsBefore + 1, 'poll(ambient) refreshes the statistics');
  await poll({ external_id: 'ecojoko-meter:unknown' });
  assert.equal(realtimeCalls(), before + 2);

  stop();
  t.mock.timers.tick(10 * 60 * 1000);
  await Promise.resolve();
  assert.equal(realtimeCalls(), before + 2, 'nothing after stop');
  await poll({ external_id: 'ecojoko-meter:4242-11' });
  assert.equal(realtimeCalls(), before + 2, 'poll is a no-op once stopped');
});

test('bad credentials stop the scheduler and flag the integration', async () => {
  const config = normalizeConfig({ email: GOOD.email, password: 'wrong' });
  const { engine } = makeEngine(config);
  const gladys = createFakeGladys();
  await assert.rejects(startScheduler({ gladys, config, engine }), /error 101/);
  assert.equal(gladys.discovered.length, 0);
});

test('a cloud outage after start flags disconnected after 3 failures, then recovers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const config = normalizeConfig({ ...GOOD, poll_frequency: 5, stats_frequency: 3600 });
  const fake = createFakeFetch();
  let outage = false;
  const engine = createEngine({
    config,
    dataDir,
    now: () => NOW,
    clientFactory: (creds) =>
      createClient(creds, {
        fetchImpl: async (url, options) => {
          if (outage) {
            throw new Error('ETIMEDOUT');
          }
          return fake.fetchImpl(url, options);
        },
      }),
  });
  const gladys = createFakeGladys();
  const { stop } = await startScheduler({ gladys, config, engine });
  const drain = async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  };

  outage = true;
  for (let n = 0; n < 3; n += 1) {
    t.mock.timers.tick(5 * 1000);
    await drain();
  }
  assert.deepEqual(gladys.connectionStatuses.at(-1), {
    connected: false,
    message: MESSAGES.unreachable,
  });

  outage = false;
  t.mock.timers.tick(5 * 1000);
  await drain();
  assert.equal(gladys.connectionStatuses.at(-1).connected, true);
  stop();
});
