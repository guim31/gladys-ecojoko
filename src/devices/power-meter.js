// -----------------------------------------------------------------------------
// Device type: POWER METER (the ecojoko clamp on the Linky).
//
// One Gladys device per ecojoko power meter, read-only sensors:
//   - power            live draw, W                      (energy-sensor/power)
//   - index            synthesized cumulative kWh        (energy-sensor/index)
//                      -> Gladys derives its 30-min consumption + cost from it
//   - today            grid consumption today, kWh       (energy-sensor/index-today)
//   - production-today solar surplus exported today, kWh (energy-production-sensor/
//                      daily-production), only when the account reports one
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
  periodKey: (label) => `period-${slugify(label)}`,
};

// ecojoko clamps read up to 90 A: 30 kW leaves room for three-phase homes.
const MAX_POWER_W = 30000;
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

function sensor(ids, key, name, category, type, unit, max) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type,
    unit,
    min: 0,
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
    const { ENERGY_SENSOR, ENERGY_PRODUCTION_SENSOR } = DEVICE_FEATURE_CATEGORIES;
    const features = [
      sensor(
        ids,
        FEATURE.POWER,
        'Puissance instantanée',
        ENERGY_SENSOR,
        DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        DEVICE_FEATURE_UNITS.WATT,
        MAX_POWER_W,
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
      // No poll_frequency: the schedule lives in the container (src/scheduler.js),
      // one timer for the live power, another for the daily statistics.
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
    if (snapshot.capabilities.hasProduction && Number.isFinite(stats.kwhProd)) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.PRODUCTION_TODAY),
        state: stats.kwhProd,
      });
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
