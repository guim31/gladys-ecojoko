// -----------------------------------------------------------------------------
// Dashboard widget contents: pure builders over the engine's last readings.
// Every content must pass the SDK validator exactly as sent ([] = nothing
// dropped or truncated by the core).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  WIDGET,
  WIDGET_BUILDERS,
  ENERGY_INTERVALS,
  DEFAULT_ENERGY_INTERVAL,
  buildEnergyContent,
  buildWeekContent,
  buildAmbientContent,
  widgetFeatureIds,
  isStale,
  formatTime,
  formatKwh,
  weekdayName,
} from '../src/widgets.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { GOOD } from './helpers/fakeEcojoko.js';

const gladys = createFakeGladys();

function snapshot({ hasProduction = false, tempHum = true, periods = ['HC', 'HP'] } = {}) {
  return {
    gateway: { gatewayId: '4242', powerMeterId: '11', tempHumId: tempHum ? '12' : null },
    capabilities: { periods, hasProduction, hasTempHum: tempHum },
    discoveredAt: '2026-09-08T08:00:00.000Z',
  };
}

// Tuesday 2026-09-08: Monday and Tuesday known, the rest of the week ahead.
function weekDays(kwhs, kwhProds = []) {
  const dates = [
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-13',
  ];
  return dates.map((date, i) => ({
    date,
    kwh: kwhs[i] ?? null,
    kwhProd: kwhProds[i] ?? null,
    periods: [],
  }));
}

function readings({ week = weekDays([12, 11.25]), previousWeek = null, ambient, periods } = {}) {
  return {
    power: { watts: 1234, at: '2026-09-08T08:30:00.000Z' },
    stats: {
      date: '2026-09-08',
      at: '2026-09-08T08:25:00.000Z',
      index: 11.25,
      todayKwh: 11.25,
      kwhProd: null,
      productionIndex: null,
      periods: periods ?? [
        { label: 'HC', kwh: 5 },
        { label: 'HP', kwh: 6.25 },
      ],
      ambient:
        ambient === undefined
          ? { temperature: { indoor: 21.5, outdoor: 13.4 }, humidity: { indoor: 55, outdoor: 72 } }
          : ambient,
    },
    week: { monday: '2026-09-07', days: week },
    previousWeek,
  };
}

function inputs(overrides = {}) {
  const snap = overrides.snapshot === undefined ? snapshot() : overrides.snapshot;
  return {
    snapshot: snap,
    readings: overrides.readings === undefined ? readings() : overrides.readings,
    config: normalizeConfig({ ...GOOD, ...(overrides.config ?? {}) }),
    ids: snap ? widgetFeatureIds(gladys, snap) : {},
    language: overrides.language ?? 'fr',
    settings: overrides.settings ?? {},
    // One minute after the fake readings.
    now: overrides.now ?? '2026-09-08T08:31:00.000Z',
  };
}

const byType = (content, type) => content.components.filter((c) => c.type === type);

test('feature ids match what the device modules publish', () => {
  const ids = widgetFeatureIds(gladys, snapshot());
  assert.equal(ids.power, 'ecojoko-meter:4242-11:power');
  assert.equal(ids.today, 'ecojoko-meter:4242-11:today');
  assert.equal(ids.productionToday, 'ecojoko-meter:4242-11:production-today');
  assert.equal(ids.temperatureIndoor, 'ecojoko-ambient:4242-12:temperature-indoor');
  assert.equal(ids.humidityOutdoor, 'ecojoko-ambient:4242-12:humidity-outdoor');
  assert.equal(widgetFeatureIds(gladys, snapshot({ tempHum: false })).temperatureIndoor, undefined);
});

test('energy: live tiles, power chart, tariff periods and last reading', () => {
  const content = buildEnergyContent(inputs());
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 30);
  const tiles = byType(content, 'value');
  assert.deepEqual(
    tiles.map((t) => t.device_feature),
    ['ecojoko-meter:4242-11:power', 'ecojoko-meter:4242-11:today'],
  );
  const [chart] = byType(content, 'chart');
  assert.deepEqual(chart.device_features, ['ecojoko-meter:4242-11:power']);
  assert.equal(chart.interval, DEFAULT_ENERGY_INTERVAL);
  assert.equal(chart.chart_type, 'area');
  const [status] = byType(content, 'status');
  assert.deepEqual(
    status.items.map((i) => [typeof i.label === 'string' ? i.label : i.label.fr, i.value]),
    [
      ['HC', '5 kWh'],
      ['HP', '6,3 kWh'],
      ['Dernier relevé', '10:30'],
    ],
  );
});

test('energy: the surplus tile only on a solar account', () => {
  const content = buildEnergyContent(inputs({ snapshot: snapshot({ hasProduction: true }) }));
  assert.deepEqual(validateWidgetContent(content), []);
  const tiles = byType(content, 'value');
  assert.equal(tiles.length, 3);
  assert.equal(tiles[2].device_feature, 'ecojoko-meter:4242-11:production-today');
});

test('energy: the interval setting drives the chart, unknown values fall back', () => {
  for (const interval of ENERGY_INTERVALS) {
    const content = buildEnergyContent(inputs({ settings: { interval } }));
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(byType(content, 'chart')[0].interval, interval);
  }
  const bogus = buildEnergyContent(inputs({ settings: { interval: 'last-year' } }));
  assert.equal(byType(bogus, 'chart')[0].interval, DEFAULT_ENERGY_INTERVAL);
});

test('energy: no period rows when the option is off or the account has none', () => {
  const off = buildEnergyContent(inputs({ config: { sub_consumption: false } }));
  assert.deepEqual(validateWidgetContent(off), []);
  assert.deepEqual(
    byType(off, 'status')[0].items.map((i) => i.label.en),
    ['Last reading'],
  );
  const none = buildEnergyContent(inputs({ readings: readings({ periods: [] }) }));
  assert.deepEqual(
    byType(none, 'status')[0].items.map((i) => i.label.en),
    ['Last reading'],
  );
});

test('energy: many tariff periods stay within the 10 status rows', () => {
  const periods = Array.from({ length: 12 }, (_, i) => ({ label: `Période ${i}`, kwh: i }));
  const content = buildEnergyContent(inputs({ readings: readings({ periods }) }));
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(byType(content, 'status')[0].items.length, 10);
});

test('energy: before the first readings, the live tiles still bind the features', () => {
  const fresh = {
    power: null,
    stats: null,
    week: null,
    previousWeek: null,
  };
  const content = buildEnergyContent(inputs({ readings: fresh }));
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(byType(content, 'value').length, 2);
  assert.equal(byType(content, 'status').length, 0);
});

test('week: one bar per elapsed day, totals, average and hungriest day', () => {
  const content = buildWeekContent(inputs());
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 900);
  const [chart] = byType(content, 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series.length, 1, 'no exported series without production');
  assert.deepEqual(chart.series[0].points, [
    { t: '2026-09-07T10:00:00.000Z', v: 12 },
    { t: '2026-09-08T10:00:00.000Z', v: 11.3 },
  ]);
  const [status] = byType(content, 'status');
  assert.deepEqual(
    status.items.map((i) => [i.label.fr, i.value]),
    [
      ['Total de la semaine', '23,3 kWh'],
      ['Moyenne par jour', '11,6 kWh'],
      ['Jour le plus gourmand', 'Lundi · 12 kWh'],
    ],
  );
  assert.equal(chart.now_marker, undefined);
});

test('week: exported series and totals on a solar account, previous week when in memory', () => {
  const content = buildWeekContent(
    inputs({
      snapshot: snapshot({ hasProduction: true }),
      readings: readings({
        week: weekDays([12, 11.25], [2.5, 1.25]),
        previousWeek: { monday: '2026-08-31', days: weekDays([10, 10, 10, 10, 10, 10, 10]) },
      }),
      language: 'en',
    }),
  );
  assert.deepEqual(validateWidgetContent(content), []);
  const [chart] = byType(content, 'chart');
  assert.equal(chart.series.length, 2);
  assert.equal(chart.series[1].name.en, 'Exported');
  assert.deepEqual(
    chart.series[1].points.map((p) => p.v),
    [2.5, 1.3],
  );
  const labels = byType(content, 'status')[0].items.map((i) => [i.label.en, i.value]);
  assert.deepEqual(labels, [
    ['Week total', '23.3 kWh'],
    ['Daily average', '11.6 kWh'],
    ['Hungriest day', 'Monday · 12 kWh'],
    ['Exported this week', '3.8 kWh'],
    ['Last week', '70 kWh'],
  ]);
});

test('week: a day without value (or in the future) is omitted', () => {
  const week = weekDays([12, null]);
  const content = buildWeekContent(inputs({ readings: readings({ week }) }));
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(byType(content, 'chart')[0].series[0].points.length, 1);
  // Values past today never count, even when the service reports them.
  const ahead = weekDays([12, 11, 99, 99, 99, 99, 99]);
  const clipped = buildWeekContent(inputs({ readings: readings({ week: ahead }) }));
  assert.equal(byType(clipped, 'chart')[0].series[0].points.length, 2);
});

test('week: empty states are explicit texts, never errors', () => {
  const noStats = buildWeekContent(
    inputs({ readings: { power: null, stats: null, week: null, previousWeek: null } }),
  );
  assert.deepEqual(validateWidgetContent(noStats), []);
  assert.equal(noStats.components.length, 1);
  assert.equal(noStats.components[0].type, 'text');
  assert.match(noStats.components[0].text.fr, /Aucune statistique/);
  const noWeekValues = buildWeekContent(
    inputs({ readings: readings({ week: weekDays([null, null]) }) }),
  );
  assert.equal(noWeekValues.components[0].type, 'text');
});

test('ambient: four live tiles and the temperature chart', () => {
  const content = buildAmbientContent(inputs());
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 300);
  const tiles = byType(content, 'value');
  assert.deepEqual(
    tiles.map((t) => t.device_feature),
    [
      'ecojoko-ambient:4242-12:temperature-indoor',
      'ecojoko-ambient:4242-12:temperature-outdoor',
      'ecojoko-ambient:4242-12:humidity-indoor',
      'ecojoko-ambient:4242-12:humidity-outdoor',
    ],
  );
  const [chart] = byType(content, 'chart');
  assert.deepEqual(chart.device_features, [
    'ecojoko-ambient:4242-12:temperature-indoor',
    'ecojoko-ambient:4242-12:temperature-outdoor',
  ]);
  assert.equal(chart.interval, 'last-day');
});

test('ambient: only the sensors ecojoko reports, once a reading exists', () => {
  const partial = readings({
    ambient: {
      temperature: { indoor: 21.5, outdoor: null },
      humidity: { indoor: 55, outdoor: null },
    },
  });
  const content = buildAmbientContent(inputs({ readings: partial }));
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    byType(content, 'value').map((t) => t.device_feature),
    ['ecojoko-ambient:4242-12:temperature-indoor', 'ecojoko-ambient:4242-12:humidity-indoor'],
  );
  assert.deepEqual(byType(content, 'chart')[0].device_features, [
    'ecojoko-ambient:4242-12:temperature-indoor',
  ]);
  // Before any reading, every sensor of the published device is shown.
  const fresh = buildAmbientContent(
    inputs({ readings: { power: null, stats: null, week: null, previousWeek: null } }),
  );
  assert.equal(byType(fresh, 'value').length, 4);
});

test('ambient: explicit text when the option is off or the account has no sensor', () => {
  const off = buildAmbientContent(inputs({ config: { environment: false } }));
  assert.deepEqual(validateWidgetContent(off), []);
  assert.equal(off.components.length, 1);
  assert.match(off.components[0].text.fr, /Aucun capteur d'ambiance/);
  const none = buildAmbientContent(inputs({ snapshot: snapshot({ tempHum: false }) }));
  assert.equal(none.components[0].type, 'text');
});

test('every widget shows a text while the integration is not connected', () => {
  for (const key of Object.values(WIDGET)) {
    const content = WIDGET_BUILDERS[key](inputs({ snapshot: null, readings: null }));
    assert.deepEqual(validateWidgetContent(content), [], key);
    assert.equal(content.components.length, 1, key);
    assert.equal(content.components[0].type, 'text', key);
    assert.ok(content.components[0].text.en && content.components[0].text.fr, key);
  }
});

test('contents never use the primary style and keep every label short', () => {
  const contents = [
    buildEnergyContent(inputs({ snapshot: snapshot({ hasProduction: true }) })),
    buildWeekContent(inputs({ snapshot: snapshot({ hasProduction: true }) })),
    buildAmbientContent(inputs()),
  ];
  for (const content of contents) {
    for (const component of content.components) {
      assert.notEqual(component.style, 'primary');
      for (const text of Object.values(component.label ?? {})) {
        assert.ok(text.length <= 24, text);
      }
    }
  }
});

test('formatting helpers follow the language', () => {
  assert.equal(formatKwh(11.25, 'fr'), '11,3 kWh');
  assert.equal(formatKwh(11.25, 'en'), '11.3 kWh');
  assert.equal(formatKwh(1234.5, 'en'), '1,234.5 kWh');
  assert.equal(weekdayName('2026-09-13', 'fr'), 'Dimanche');
  assert.equal(weekdayName('2026-09-13', 'en'), 'Sunday');
});

test('energy: the last reading turns orange when stale, and shows its day when not today', () => {
  const stale = buildEnergyContent(inputs({ now: '2026-09-08T09:00:00.000Z' }));
  const row = (content) => byType(content, 'status')[0].items.at(-1);
  assert.equal(row(stale).color, 'warning', '30 min > 3 × 300 s');
  assert.equal(row(stale).value, '10:30', 'same Paris day: time only');
  const fresh = buildEnergyContent(inputs({ now: '2026-09-08T08:40:00.000Z' }));
  assert.equal(row(fresh).color, 'success');
  const nextDay = buildEnergyContent(inputs({ now: '2026-09-09T06:00:00.000Z' }));
  assert.deepEqual(validateWidgetContent(nextDay), []);
  assert.equal(row(nextDay).value, '08/09 10:30');
  assert.equal(row(nextDay).color, 'warning');
  // The threshold follows the configured statistics cadence.
  const slow = buildEnergyContent(
    inputs({ now: '2026-09-08T09:00:00.000Z', config: { stats_frequency: 3600 } }),
  );
  assert.equal(row(slow).color, 'success');
  assert.equal(isStale('2026-09-08T08:00:00Z', '2026-09-08T08:15:01Z', 300), true);
  assert.equal(formatTime('2026-09-08T08:30:00Z', 'en'), '10:30');
});

test('week: early on a Monday, last week is shown while this week has no value', () => {
  const mondayStats = { ...readings().stats, date: '2026-09-14', at: '2026-09-14T04:05:00.000Z' };
  const thisWeek = {
    monday: '2026-09-14',
    days: weekDays([]).map((day, i) => ({ ...day, date: `2026-09-${14 + i}` })),
  };
  const lastWeek = { monday: '2026-09-07', days: weekDays([12, 11, 10, 9, 8, 7, 6], [1, 2]) };
  const withPrevious = buildWeekContent(
    inputs({
      snapshot: snapshot({ hasProduction: true }),
      readings: { ...readings(), stats: mondayStats, week: thisWeek, previousWeek: lastWeek },
    }),
  );
  assert.deepEqual(validateWidgetContent(withPrevious), []);
  const [chart] = byType(withPrevious, 'chart');
  assert.equal(chart.title.fr, 'Semaine dernière');
  assert.equal(chart.series[0].name.fr, 'Semaine dernière');
  assert.equal(chart.series[0].points.length, 7);
  assert.equal(chart.series[1].name.fr, 'Injecté');
  const rows = byType(withPrevious, 'status')[0].items.map((i) => [i.label.fr, i.value]);
  assert.deepEqual(rows, [
    ['Semaine dernière', '63 kWh'],
    ['Moyenne par jour', '9 kWh'],
    ['Jour le plus gourmand', 'Lundi · 12 kWh'],
    ['Injecté cette semaine', '3 kWh'],
  ]);

  const alone = buildWeekContent(
    inputs({ readings: { ...readings(), stats: mondayStats, week: thisWeek, previousWeek: null } }),
  );
  assert.deepEqual(validateWidgetContent(alone), []);
  assert.equal(alone.components.length, 1);
  assert.match(alone.components[0].text.fr, /Aucune consommation relevée cette semaine/);
});
