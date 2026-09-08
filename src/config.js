// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`; the SDK fetches it (`gladys.getConfig()`)
// and pushes every change through `gladys.onConfigUpdated()`. This module only
// provides defaults and normalizes the received object so the rest of the code
// never deals with `undefined` or with numbers that arrived as strings.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a test enforces it).
export const DEFAULT_CONFIG = {
  email: '', // ecojoko account (service.ecojoko.com)
  password: '', // secret: never logged
  poll_frequency: 30, // seconds between two live power readings
  stats_frequency: 300, // seconds between two daily-statistics refreshes
  sub_consumption: true, // one "today" sensor per tariff period (HC/HP, Tempo...)
  environment: true, // publish the ambient temperature/humidity device
};

// Bounds of the numeric fields, shared with the manifest (`min`/`max`).
export const LIMITS = {
  poll_frequency: { min: 5, max: 300 },
  stats_frequency: { min: 60, max: 3600 },
};

/**
 * Clamp a numeric field coming from the form (may arrive as a string).
 */
function toNumber(raw, fallback, { min, max }) {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Anything but an explicit false means true.
 */
function toBoolean(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  return raw !== false && raw !== 'false';
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    poll_frequency: toNumber(
      raw.poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      LIMITS.poll_frequency,
    ),
    stats_frequency: toNumber(
      raw.stats_frequency,
      DEFAULT_CONFIG.stats_frequency,
      LIMITS.stats_frequency,
    ),
    sub_consumption: toBoolean(raw.sub_consumption, DEFAULT_CONFIG.sub_consumption),
    environment: toBoolean(raw.environment, DEFAULT_CONFIG.environment),
  };
}

/**
 * True when the user has filled in both credentials.
 */
export function hasCredentials(config) {
  return config.email.length > 0 && config.password.length > 0;
}
