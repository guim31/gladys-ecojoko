// -----------------------------------------------------------------------------
// Device type: POWER METER (the ecojoko clamp on the Linky).
//
// One Gladys device per ecojoko power meter, read-only sensors:
//   - power            signed grid exchange, W            (grid-sensor/power)
//                      import > 0, export < 0 — ecojoko reports ONE signed
//                      value, which is exactly what this type is for
//   - index            synthesized cumulative kWh        (energy-sensor/index)
//                      -> Gladys derives its 30-min consumption + cost from it
//   - today            grid consumption today, kWh       (energy-sensor/index-today)
//   - production-today solar surplus exported today, kWh (energy-production-sensor/
//                      daily-production), only when the account reports one
//   - production-index cumulative exported energy, kWh   (energy-production-sensor/
//                      index), same synthesis as the consumption index
//   - period-<slug>    today's kWh per tariff period (HC/HP, Tempo colours...),
//                      one per label found in the statistics, optional
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'ecojoko-meter';

export const FEATURE = {
  POWER: 'power',
  INDEX: 'index',
  TODAY: 'today',
  PRODUCTION_TODAY: 'production-today',
  PRODUCTION_INDEX: 'production-index',
  periodKey: (label) => `period-${slugify(label)}`,
};

// Signed grid exchange: negative in solar surplus. The bounds are symmetric
// and cover the largest common French subscription (12 kVA) rather than the
// clamp's absolute ceiling — Gladys positions its gauge needle with them
// (`(value - min) / (max - min)`), so a needlessly wide range would leave the
// needle motionless around 0 W. A bigger installation still reports its exact
// value, the gauge simply pins.
const MIN_POWER_W = -12000;
const MAX_POWER_W = 12000;
const MAX_INDEX_KWH = 1000000000;
const MAX_DAILY_KWH = 1000;

/**
 * Deterministic slug for a tariff-period label ("HC Bleu" -> "hc-bleu").
 * Feature external_ids must be stable across runs, so this depends on nothing
 * but the label itself.
 */
export function slugify(label) {
  return String(label)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sensor(ids, key, name, category, type, unit, max, min = 0) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type,
    unit,
    min,
    max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

export const powerMeter = {
  key: DEVICE_TYPE,

  platformId(snapshot) {
    return `${snapshot.gateway.gatewayId}-${snapshot.gateway.powerMeterId}`;
  },

  deviceExternalId(gladys, snapshot) {
    return gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot)).device;
  },

  /**
   * Discovery payload. `snapshot.capabilities` comes from the first statistics
   * read: which tariff periods exist, whether a solar surplus is reported.
   */
  buildDevice(gladys, snapshot, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot));
    const { ENERGY_SENSOR, ENERGY_PRODUCTION_SENSOR, GRID_SENSOR } = DEVICE_FEATURE_CATEGORIES;
    const features = [
      // grid-sensor/power, not energy-sensor/power: the ecojoko clamp sits at
      // the grid connection point and reports a SIGNED value (negative when
      // solar surplus is exported), which is what this category was defined
      // for. energy-sensor/power is house consumption and never goes below 0.
      sensor(
        ids,
        FEATURE.POWER,
        'Puissance instantanée',
        GRID_SENSOR,
        DEVICE_FEATURE_TYPES.GRID_SENSOR.POWER,
        DEVICE_FEATURE_UNITS.WATT,
        MAX_POWER_W,
        MIN_POWER_W,
      ),
      sensor(
        ids,
        FEATURE.INDEX,
        'Index de consommation',
        ENERGY_SENSOR,
        DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
        DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        MAX_INDEX_KWH,
      ),
      sensor(
        ids,
        FEATURE.TODAY,
        'Consommation du jour',
        ENERGY_SENSOR,
        DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX_TODAY,
        DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        MAX_DAILY_KWH,
      ),
    ];
    if (snapshot.capabilities.hasProduction) {
      features.push(
        sensor(
          ids,
          FEATURE.PRODUCTION_TODAY,
          'Surplus solaire injecté du jour',
          ENERGY_PRODUCTION_SENSOR,
          DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
          DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          MAX_DAILY_KWH,
        ),
        // Cumulative counterpart of the daily surplus. `daily-production` is a
        // counter that resets every night; only a monotonic INDEX is the shape
        // Gladys tracks production from, so publish both.
        sensor(
          ids,
          FEATURE.PRODUCTION_INDEX,
          'Index de production injectée',
          ENERGY_PRODUCTION_SENSOR,
          DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
          DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          MAX_INDEX_KWH,
        ),
      );
    }
    if (config.sub_consumption) {
      for (const label of snapshot.capabilities.periods) {
        features.push(
          sensor(
            ids,
            FEATURE.periodKey(label),
            `${label} du jour`,
            ENERGY_SENSOR,
            DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX_TODAY,
            DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
            MAX_DAILY_KWH,
          ),
        );
      }
    }
    return {
      name: 'ecojoko',
      external_id: ids.device,
      // Gladys polling is deliberately OFF. The core only polls a device that
      // carries BOTH `should_poll: true` and a `poll_frequency` from its fixed
      // list (1, 2, 10, 15, 30 or 60 s); the Discovery screen posts this payload
      // as-is, nothing in the core infers one flag from the other. Our two
      // cadences (live power, daily statistics) are user-configurable and do
      // not fit that list, so the container pushes states itself
      // (src/scheduler.js). A poll request still gets an answer (onPoll in
      // index.js) should someone enable polling from the device page.
      should_poll: false,
      features,
    };
  },

  /** States for one live reading. */
  statesFromRealtime(gladys, snapshot, watts) {
    const ids = gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot));
    return [{ device_feature_external_id: ids.feature(FEATURE.POWER), state: Math.round(watts) }];
  },

  /**
   * States for one statistics refresh.
   * @param {object} stats - { index, todayKwh, kwhProd, periods: [{label, kwh}] }
   */
  statesFromStats(gladys, snapshot, config, stats) {
    const ids = gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot));
    const states = [];
    if (Number.isFinite(stats.index)) {
      states.push({ device_feature_external_id: ids.feature(FEATURE.INDEX), state: stats.index });
    }
    if (Number.isFinite(stats.todayKwh)) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.TODAY),
        state: stats.todayKwh,
      });
    }
    if (snapshot.capabilities.hasProduction) {
      if (Number.isFinite(stats.kwhProd)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.PRODUCTION_TODAY),
          state: stats.kwhProd,
        });
      }
      if (Number.isFinite(stats.productionIndex)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.PRODUCTION_INDEX),
          state: stats.productionIndex,
        });
      }
    }
    if (config.sub_consumption) {
      const declared = new Set(snapshot.capabilities.periods.map(slugify));
      for (const period of stats.periods ?? []) {
        // A label that was not there at discovery has no feature yet: skip it,
        // the next discovery (config save, restart) will add it.
        if (declared.has(slugify(period.label)) && Number.isFinite(period.kwh)) {
          states.push({
            device_feature_external_id: ids.feature(FEATURE.periodKey(period.label)),
            state: period.kwh,
          });
        }
      }
    }
    return states;
  },
};
