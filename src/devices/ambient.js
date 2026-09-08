// -----------------------------------------------------------------------------
// Device type: AMBIENT (the ecojoko display, which carries a temperature and
// humidity sensor, and the outdoor values ecojoko attaches to the account).
//
// One Gladys device per TEMP_HUM ecojoko device, four read-only sensors:
// indoor/outdoor temperature (°C) and indoor/outdoor humidity (%).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'ecojoko-ambient';

export const FEATURE = {
  TEMPERATURE_INDOOR: 'temperature-indoor',
  TEMPERATURE_OUTDOOR: 'temperature-outdoor',
  HUMIDITY_INDOOR: 'humidity-indoor',
  HUMIDITY_OUTDOOR: 'humidity-outdoor',
};

function sensor(ids, key, name, category, unit, min, max) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit,
    min,
    max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

export const ambient = {
  key: DEVICE_TYPE,

  /** Only published when the account has a TEMP_HUM device and the user wants it. */
  isAvailable(snapshot, config) {
    return config.environment && Boolean(snapshot.gateway.tempHumId);
  },

  platformId(snapshot) {
    return `${snapshot.gateway.gatewayId}-${snapshot.gateway.tempHumId}`;
  },

  deviceExternalId(gladys, snapshot) {
    return gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot)).device;
  },

  buildDevice(gladys, snapshot) {
    const ids = gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot));
    const { TEMPERATURE_SENSOR, HUMIDITY_SENSOR } = DEVICE_FEATURE_CATEGORIES;
    return {
      name: 'ecojoko (ambiance)',
      external_id: ids.device,
      // Same choice as the meter: states are pushed by the scheduler, see
      // src/devices/power-meter.js for why Gladys polling stays off.
      should_poll: false,
      features: [
        sensor(
          ids,
          FEATURE.TEMPERATURE_INDOOR,
          'Température intérieure',
          TEMPERATURE_SENSOR,
          DEVICE_FEATURE_UNITS.CELSIUS,
          -40,
          80,
        ),
        sensor(
          ids,
          FEATURE.TEMPERATURE_OUTDOOR,
          'Température extérieure',
          TEMPERATURE_SENSOR,
          DEVICE_FEATURE_UNITS.CELSIUS,
          -50,
          60,
        ),
        sensor(
          ids,
          FEATURE.HUMIDITY_INDOOR,
          'Humidité intérieure',
          HUMIDITY_SENSOR,
          DEVICE_FEATURE_UNITS.PERCENT,
          0,
          100,
        ),
        sensor(
          ids,
          FEATURE.HUMIDITY_OUTDOOR,
          'Humidité extérieure',
          HUMIDITY_SENSOR,
          DEVICE_FEATURE_UNITS.PERCENT,
          0,
          100,
        ),
      ],
    };
  },

  /**
   * @param {object} reading - { temperature: {indoor, outdoor}, humidity: {indoor, outdoor} }
   */
  statesFromReading(gladys, snapshot, reading) {
    const ids = gladys.externalIds(DEVICE_TYPE, this.platformId(snapshot));
    const pairs = [
      [FEATURE.TEMPERATURE_INDOOR, reading.temperature?.indoor],
      [FEATURE.TEMPERATURE_OUTDOOR, reading.temperature?.outdoor],
      [FEATURE.HUMIDITY_INDOOR, reading.humidity?.indoor],
      [FEATURE.HUMIDITY_OUTDOOR, reading.humidity?.outdoor],
    ];
    return pairs
      .filter(([, value]) => Number.isFinite(value))
      .map(([key, value]) => ({ device_feature_external_id: ids.feature(key), state: value }));
  },
};
