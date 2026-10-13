// The container drives its own readings (Gladys #3198: the core never polls a
// device created without `should_poll: true`), and a normal cycle stays quiet
// at info level. Runs against the SDK's fake Gladys, a real GladysIntegration
// whose host API checks the payloads like the core does.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createEngine } from '../src/engine.js';
import { createClient } from '../src/ecojoko.js';
import { startScheduler } from '../src/scheduler.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeFetch, GOOD } from './helpers/fakeEcojoko.js';

let dataDir;
let savedLogLevel;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ecojoko-poll-'));
  savedLogLevel = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL; // default level: info
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (savedLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = savedLogLevel;
  }
});

// Tuesday 2026-09-08, 10:00 in Paris.
const NOW = new Date('2026-09-08T08:00:00Z');

function setup({ fetchWrapper } = {}) {
  const config = normalizeConfig({ ...GOOD, poll_frequency: 10, stats_frequency: 60 });
  const fake = createFakeFetch({ realtime: 850 });
  const fetchImpl = fetchWrapper ? fetchWrapper(fake.fetchImpl) : fake.fetchImpl;
  const engine = createEngine({
    config,
    dataDir,
    now: () => NOW,
    clientFactory: (creds) => createClient(creds, { fetchImpl }),
  });
  const gladys = createFakeGladys({ config });
  return { config, fake, engine, gladys };
}

async function drain() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Capture what the SDK logger writes (info/debug -> console.log, warn/error -> console.error). */
function captureLogs(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  return lines;
}

test('states reach Gladys from the internal timers, without any onPoll from the core', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { gladys, engine, config } = setup();

  const { stop } = await startScheduler({ gladys, config, engine });
  t.after(stop);

  // Devices pass the host API checks and opt out of core polling.
  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 2);
  for (const device of devices) {
    assert.equal(device.should_poll, false, device.external_id);
  }
  const meter = devices.find((d) => d.features.some((f) => f.external_id.endsWith(':power')));
  const powerId = meter.features.find((f) => f.external_id.endsWith(':power')).external_id;
  const indexId = meter.features.find((f) => f.external_id.endsWith(':index')).external_id;

  const powerStates = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === powerId);
  const indexStates = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === indexId);
  assert.equal(powerStates().length, 1, 'first live reading at start');
  assert.equal(indexStates().length, 1, 'first statistics at start');

  // Two minutes of scheduled readings: 12 live readings, 2 statistics.
  for (let s = 0; s < 120; s += 10) {
    t.mock.timers.tick(10 * 1000);
    await drain();
  }
  assert.equal(powerStates().length, 13);
  assert.equal(indexStates().length, 3);
  assert.equal(gladys.fake.lastState(powerId), 850);
  // No `gladys.fake.poll()` anywhere in this test: the core never polled.
});

test('a normal cycle writes nothing at info level', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { engine, fake, gladys, config } = setup();
  const lines = captureLogs(t);

  const { stop } = await startScheduler({ gladys, config, engine });
  t.after(stop);
  assert.ok(
    lines.some((l) => l.includes('[INFO]')),
    'the start itself is lifecycle and may log at info',
  );

  lines.length = 0;
  for (let s = 0; s < 300; s += 10) {
    t.mock.timers.tick(10 * 1000);
    await drain();
    if (s === 150) {
      // ecojoko expires the session mid-run: the re-login is routine too.
      fake.state.sessionValid = false;
    }
  }
  assert.ok(fake.state.loginCount >= 2, 'the session was renewed during the run');
  assert.ok(gladys.fake.states.length > 30, 'states kept flowing');
  assert.deepEqual(
    lines.filter((l) => /\[(INFO|WARN|ERROR)\]/.test(l)),
    [],
    'nothing above debug during a normal cycle',
  );
});

test('a cloud outage logs one warning, then one line when it is back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let outage = false;
  const { engine, gladys, config } = setup({
    fetchWrapper: (inner) => async (url, options) => {
      if (outage) {
        throw new Error('ETIMEDOUT');
      }
      return inner(url, options);
    },
  });
  const lines = captureLogs(t);
  const { stop } = await startScheduler({ gladys, config, engine });
  t.after(stop);
  lines.length = 0;

  outage = true;
  for (let n = 0; n < 5; n += 1) {
    t.mock.timers.tick(10 * 1000);
    await drain();
  }
  const warnings = lines.filter((l) => l.includes('[WARN]'));
  assert.equal(warnings.length, 1, `one warning for five failed readings: ${warnings}`);
  assert.match(warnings[0], /live power failed/);

  outage = false;
  t.mock.timers.tick(10 * 1000);
  await drain();
  const info = lines.filter((l) => l.includes('[INFO]'));
  assert.equal(info.length, 1);
  assert.match(info[0], /live power: back to normal/);
  for (const line of lines) {
    assert.ok(!line.includes(GOOD.password), 'never the password');
  }
});

test('a failing ambient sensor is warned once, the energy keeps flowing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ambientDown = true;
  const { engine, gladys, config } = setup({
    fetchWrapper: (inner) => async (url, options) => {
      if (ambientDown && /\/(tempstat|humstat)\//.test(url)) {
        throw new Error('ECONNRESET');
      }
      return inner(url, options);
    },
  });
  const lines = captureLogs(t);
  const { stop } = await startScheduler({ gladys, config, engine });
  t.after(stop);
  for (let s = 0; s < 180; s += 10) {
    t.mock.timers.tick(10 * 1000);
    await drain();
  }
  const warnings = lines.filter((l) => l.includes('[WARN]'));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /Ambient reading failed/);
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, true, 'still connected');

  ambientDown = false;
  lines.length = 0;
  t.mock.timers.tick(60 * 1000);
  await drain();
  assert.deepEqual(
    lines.filter((l) => l.includes('[INFO]')).map((l) => l.replace(/^.*\] /, '')),
    ['Ambient reading back to normal'],
  );
});
