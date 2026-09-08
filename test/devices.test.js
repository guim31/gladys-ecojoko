import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { buildDiscoveredDevices, powerMeter, ambient } from '../src/devices/index.js';
import { slugify, FEATURE } from '../src/devices/power-meter.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig();

const snapshot = {
  gateway: { gatewayId: '4242', firmware: '1.4.2', powerMeterId: '11', tempHumId: '12' },
  capabilities: {
    periods: ['Heures Creuses', 'Heures Pleines'],
    hasProduction: false,
    hasTempHum: true,
  },
};

test('slugify gives stable ascii keys for tariff labels', () => {
  assert.equal(slugify('Heures Creuses'), 'heures-creuses');
  assert.equal(slugify('HC Bleu'), 'hc-bleu');
  assert.equal(slugify('  Été / Hiver  '), 'ete-hiver');
});

test('discovery publishes the meter and, when present, the ambient device', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, snapshot, config);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].external_id, 'ecojoko-meter:4242-11');
  assert.equal(devices[1].external_id, 'ecojoko-ambient:4242-12');
  for (const device of devices) {
    assert.equal(device.poll_frequency, undefined, 'schedule lives in the container');
    for (const feature of device.features) {
      assert.equal(feature.read_only, true);
      assert.equal(feature.keep_history, true);
      assert.ok(feature.external_id.startsWith(`${device.external_id}:`));
    }
  }
});

test('no ambient device without a TEMP_HUM id, or when the user disabled it', () => {
  const gladys = createFakeGladys();
  const noSensor = { ...snapshot, gateway: { ...snapshot.gateway, tempHumId: null } };
  assert.equal(buildDiscoveredDevices(gladys, noSensor, config).length, 1);
  const disabled = normalizeConfig({ environment: false });
  assert.equal(buildDiscoveredDevices(gladys, snapshot, disabled).length, 1);
});

test('the meter carries a cumulative index Gladys can derive energy from', () => {
  const gladys = createFakeGladys();
  const device = powerMeter.buildDevice(gladys, snapshot, config);
  const index = device.features.find((f) => f.type === DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX);
  assert.ok(index, 'index feature present');
  assert.equal(index.category, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR);
  assert.equal(index.unit, DEVICE_FEATURE_UNITS.KILOWATT_HOUR);
  const power = device.features.find((f) => f.type === DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER);
  assert.equal(power.unit, DEVICE_FEATURE_UNITS.WATT);
  const todays = device.features.filter(
    (f) => f.type === DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX_TODAY,
  );
  assert.equal(todays.length, 3, 'total + one per tariff period');
  assert.ok(todays.some((f) => f.external_id.endsWith(':period-heures-creuses')));
});

test('tariff periods and solar surplus are opt-in / capability driven', () => {
  const gladys = createFakeGladys();
  const noPeriods = powerMeter.buildDevice(
    gladys,
    snapshot,
    normalizeConfig({ sub_consumption: false }),
  );
  assert.equal(noPeriods.features.length, 3, 'power + index + today');
  const solar = { ...snapshot, capabilities: { ...snapshot.capabilities, hasProduction: true } };
  const withSolar = powerMeter.buildDevice(gladys, solar, config);
  const prod = withSolar.features.find(
    (f) => f.category === DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
  );
  assert.equal(prod.type, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION);
});

test('states from a stats refresh target the declared features only', () => {
  const gladys = createFakeGladys();
  const states = powerMeter.statesFromStats(gladys, snapshot, config, {
    index: 123.456,
    todayKwh: 4.2,
    kwhProd: 1,
    periods: [
      { label: 'Heures Creuses', kwh: 1.5 },
      { label: 'HP Rouge', kwh: 9 }, // not declared at discovery: skipped
    ],
  });
  const byId = Object.fromEntries(states.map((s) => [s.device_feature_external_id, s.state]));
  assert.equal(byId['ecojoko-meter:4242-11:index'], 123.456);
  assert.equal(byId['ecojoko-meter:4242-11:today'], 4.2);
  assert.equal(byId['ecojoko-meter:4242-11:period-heures-creuses'], 1.5);
  assert.equal(byId['ecojoko-meter:4242-11:period-hp-rouge'], undefined);
  assert.equal(byId[`ecojoko-meter:4242-11:${FEATURE.PRODUCTION_TODAY}`], undefined, 'no solar');
});

test('live power is rounded to the watt; missing ambient values are skipped', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(powerMeter.statesFromRealtime(gladys, snapshot, 1234.6), [
    { device_feature_external_id: 'ecojoko-meter:4242-11:power', state: 1235 },
  ]);
  const states = ambient.statesFromReading(gladys, snapshot, {
    temperature: { indoor: 21.5, outdoor: null },
    humidity: { indoor: 55, outdoor: 70 },
  });
  assert.equal(states.length, 3);
  assert.ok(!states.some((s) => s.device_feature_external_id.endsWith('temperature-outdoor')));
});
