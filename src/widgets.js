// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+), content builders — pure functions.
//
//   - energy  : live power, today's consumption (and surplus) as live tiles,
//               the power curve, today's tariff periods and the last reading;
//   - week    : the seven days of the current week as bars (consumption, and
//               the exported surplus when the account reports one), with the
//               totals in a status list;
//   - ambient : the indoor/outdoor temperature and humidity as live tiles and
//               the temperature curve of the day.
//
// The builders read the LAST READINGS the engine keeps in memory
// (`engine.getLastReadings()`): a widget never costs an ecojoko request. The
// tiles and the power/temperature charts are bound to the published device
// features (`device_feature` / `device_features`), so they follow the states
// the scheduler pushes without any refresh of the content itself.
//
// Rules of the core worth remembering here: 8 components at most, 1 focal
// (chart), 6 tiles, 2 texts, 1 status of 10 rows; labels ≤ 24 characters,
// status values ≤ 40, series names ≤ 24; `ttl_seconds` 10–3600.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { powerMeter, FEATURE as METER_FEATURE } from './devices/power-meter.js';
import { ambient, FEATURE as AMBIENT_FEATURE } from './devices/ambient.js';
import { TIMEZONE, compareDates, parisDate, parisNoonIso } from './dates.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = {
  ENERGY: 'energy',
  WEEK: 'week',
  AMBIENT: 'ambient',
};

/** `interval` setting of the energy widget: the window of the power chart. */
export const ENERGY_INTERVALS = ['last-hour', 'last-day', 'last-week'];
export const DEFAULT_ENERGY_INTERVAL = 'last-day';

const TTL = {
  energy: 30,
  week: 900,
  ambient: 300,
};

// Rows of a status list, minus the "last reading" row of the energy widget.
const MAX_PERIOD_ROWS = 9;
const MAX_STATUS_VALUE = 40;
// A reading older than this many statistics cycles is flagged (warning).
const STALE_AFTER_CYCLES = 3;

const TEXTS = {
  power: { en: 'Grid power', fr: 'Puissance' },
  today: { en: 'Consumption today', fr: 'Consommation du jour' },
  productionToday: { en: 'Exported today', fr: 'Surplus injecté du jour' },
  powerChart: { en: 'Grid power', fr: 'Puissance réseau' },
  lastReading: { en: 'Last reading', fr: 'Dernier relevé' },
  consumption: { en: 'Consumption', fr: 'Consommation' },
  exported: { en: 'Exported', fr: 'Injecté' },
  weekTotal: { en: 'Week total', fr: 'Total de la semaine' },
  dailyAverage: { en: 'Daily average', fr: 'Moyenne par jour' },
  hungriestDay: { en: 'Hungriest day', fr: 'Jour le plus gourmand' },
  previousWeek: { en: 'Last week', fr: 'Semaine dernière' },
  weekExported: { en: 'Exported this week', fr: 'Injecté cette semaine' },
  temperatureIndoor: { en: 'Indoor temperature', fr: 'Température intérieure' },
  temperatureOutdoor: { en: 'Outdoor temperature', fr: 'Température extérieure' },
  humidityIndoor: { en: 'Indoor humidity', fr: 'Humidité intérieure' },
  humidityOutdoor: { en: 'Outdoor humidity', fr: 'Humidité extérieure' },
  temperatureChart: { en: 'Temperature', fr: 'Température' },
  notConnected: {
    en: 'ecojoko is not connected yet: enter your credentials in the configuration and wait for the first reading.',
    fr: "ecojoko n'est pas encore connecté : renseignez vos identifiants dans la configuration et attendez le premier relevé.",
  },
  noStatsYet: {
    en: 'No statistics read yet: the first weekly reading comes within a few minutes.',
    fr: 'Aucune statistique lue pour le moment : le premier relevé hebdomadaire arrive dans quelques minutes.',
  },
  noWeekYet: {
    en: 'No consumption recorded this week yet.',
    fr: 'Aucune consommation relevée cette semaine pour le moment.',
  },
  noAmbient: {
    en: 'No ambient sensor: enable the Environment option in the configuration if your ecojoko has one.',
    fr: "Aucun capteur d'ambiance : activez l'option Environnement dans la configuration si votre ecojoko en a un.",
  },
};

/**
 * The feature external_ids the widgets bind to, exactly as src/devices/
 * publishes them (same `gladys.externalIds(type, platformId)` derivation).
 * @param {object} gladys - the SDK object (or the test stand-in)
 * @param {object} snapshot - the engine's discovery snapshot
 */
export function widgetFeatureIds(gladys, snapshot) {
  const meter = gladys.externalIds(powerMeter.key, powerMeter.platformId(snapshot));
  const ids = {
    power: meter.feature(METER_FEATURE.POWER),
    today: meter.feature(METER_FEATURE.TODAY),
    productionToday: meter.feature(METER_FEATURE.PRODUCTION_TODAY),
  };
  if (snapshot.gateway.tempHumId) {
    const climate = gladys.externalIds(ambient.key, ambient.platformId(snapshot));
    ids.temperatureIndoor = climate.feature(AMBIENT_FEATURE.TEMPERATURE_INDOOR);
    ids.temperatureOutdoor = climate.feature(AMBIENT_FEATURE.TEMPERATURE_OUTDOOR);
    ids.humidityIndoor = climate.feature(AMBIENT_FEATURE.HUMIDITY_INDOOR);
    ids.humidityOutdoor = climate.feature(AMBIENT_FEATURE.HUMIDITY_OUTDOOR);
  }
  return ids;
}

function locale(language) {
  return language === 'fr' ? 'fr-FR' : 'en-GB';
}

/** "11,3 kWh" / "11.3 kWh": at most one decimal, the way the ecojoko app does. */
export function formatKwh(value, language) {
  const number = new Intl.NumberFormat(locale(language), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
  return `${number} kWh`;
}

/**
 * "14:35" in Paris time, the civil time of the ecojoko statistics, with the
 * day ("07/09 14:35") when the reading is not from today (Paris).
 */
export function formatTime(iso, language, now) {
  const sameDay = now === undefined || parisDate(new Date(iso)) === parisDate(new Date(now));
  return new Intl.DateTimeFormat(locale(language), {
    timeZone: TIMEZONE,
    ...(sameDay ? {} : { day: '2-digit', month: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** True when `iso` is older than STALE_AFTER_CYCLES statistics refreshes. */
export function isStale(iso, now, statsFrequencySeconds) {
  const age = new Date(now).getTime() - new Date(iso).getTime();
  return age > STALE_AFTER_CYCLES * statsFrequencySeconds * 1000;
}

/** Localized name of the weekday of 'YYYY-MM-DD', capitalized ("Mardi"). */
export function weekdayName(isoDate, language) {
  const name = new Intl.DateTimeFormat(locale(language), {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(new Date(`${isoDate}T00:00:00Z`));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function body(text) {
  return { type: 'text', variant: 'body', text };
}

function content(key, components) {
  return { version: 1, ttl_seconds: TTL[key], components };
}

/**
 * Content of the energy widget.
 * @param {object} input
 * @param {object|null} input.snapshot - engine discovery snapshot (null = not connected)
 * @param {object|null} input.readings - engine.getLastReadings() (null = not connected)
 * @param {object} input.config - normalized configuration
 * @param {object} input.ids - widgetFeatureIds()
 * @param {string} input.language - ISO 639-1 of the requesting user
 * @param {object} [input.settings] - widget instance settings ({ interval })
 * @param {Date|string} [input.now] - current instant (injectable: the builder stays pure)
 */
export function buildEnergyContent({
  snapshot,
  readings,
  config,
  ids,
  language,
  settings = {},
  now = new Date(),
}) {
  if (!snapshot || !readings) {
    return content('energy', [body(TEXTS.notConnected)]);
  }
  const interval = ENERGY_INTERVALS.includes(settings.interval)
    ? settings.interval
    : DEFAULT_ENERGY_INTERVAL;
  const components = [
    { type: 'value', device_feature: ids.power, label: TEXTS.power, icon: 'zap' },
    { type: 'value', device_feature: ids.today, label: TEXTS.today, icon: 'activity' },
  ];
  if (snapshot.capabilities.hasProduction) {
    components.push({
      type: 'value',
      device_feature: ids.productionToday,
      label: TEXTS.productionToday,
      icon: 'sun',
    });
  }
  components.push({
    type: 'chart',
    device_features: [ids.power],
    interval,
    chart_type: 'area',
    title: TEXTS.powerChart,
    unit: 'W',
  });

  const items = [];
  if (config.sub_consumption && readings.stats) {
    for (const period of (readings.stats.periods ?? []).slice(0, MAX_PERIOD_ROWS)) {
      if (Number.isFinite(period.kwh)) {
        items.push({
          label: clip(period.label, 40),
          value: formatKwh(period.kwh, language),
          icon: 'clock',
        });
      }
    }
  }
  // Green while fresh; orange once older than a few statistics cycles (the
  // cloud or the sensor stopped answering), with the day when not today.
  const lastReadingAt = latestOf(readings.power?.at, readings.stats?.at);
  if (lastReadingAt) {
    const stale = isStale(lastReadingAt, now, config.stats_frequency);
    items.push({
      label: TEXTS.lastReading,
      value: formatTime(lastReadingAt, language, now),
      icon: stale ? 'alert-triangle' : 'refresh-cw',
      color: stale ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
    });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  return content('energy', components);
}

function latestOf(...isoDates) {
  const known = isoDates.filter(Boolean).sort();
  return known.length > 0 ? known[known.length - 1] : null;
}

/**
 * Series and status rows describing one week (its days with a known kWh).
 * `name` is the consumption series name / total row label.
 */
function weekSummary({ days, name, hasProduction, language }) {
  const series = [
    {
      name,
      points: days.map((day) => ({ t: parisNoonIso(day.date), v: round1(day.kwh) })),
    },
  ];
  const exported = days.filter((day) => Number.isFinite(day.kwhProd));
  if (hasProduction && exported.length > 0) {
    series.push({
      name: TEXTS.exported,
      points: exported.map((day) => ({ t: parisNoonIso(day.date), v: round1(day.kwhProd) })),
    });
  }
  const total = days.reduce((sum, day) => sum + day.kwh, 0);
  const hungriest = days.reduce((best, day) => (day.kwh > best.kwh ? day : best), days[0]);
  const items = [
    { label: name, value: formatKwh(total, language), icon: 'bar-chart-2' },
    {
      label: TEXTS.dailyAverage,
      value: formatKwh(total / days.length, language),
      icon: 'trending-up',
    },
    {
      label: TEXTS.hungriestDay,
      value: clip(
        `${weekdayName(hungriest.date, language)} · ${formatKwh(hungriest.kwh, language)}`,
        MAX_STATUS_VALUE,
      ),
      icon: 'alert-circle',
      color: WIDGET_COLORS.WARNING,
    },
  ];
  if (series.length > 1) {
    const exportedTotal = exported.reduce((sum, day) => sum + day.kwhProd, 0);
    items.push({
      label: TEXTS.weekExported,
      value: formatKwh(exportedTotal, language),
      icon: 'sun',
      color: WIDGET_COLORS.SUCCESS,
    });
  }
  return { series, items };
}

/**
 * Content of the week widget: one bar per day of the current week. Early on
 * a Monday, before any day of the week has a value, the previous week is
 * shown instead when it is in memory.
 * @param {object} input - see buildEnergyContent
 */
export function buildWeekContent({ snapshot, readings, language }) {
  if (!snapshot || !readings) {
    return content('week', [body(TEXTS.notConnected)]);
  }
  const { week, previousWeek, stats } = readings;
  if (!week || !stats) {
    return content('week', [body(TEXTS.noStatsYet)]);
  }
  const { hasProduction } = snapshot.capabilities;
  // Days up to today only: the future entries of the week carry nothing.
  const days = week.days.filter(
    (day) => compareDates(day.date, stats.date) <= 0 && Number.isFinite(day.kwh),
  );
  // The previous week is only in memory when the index backfill read it
  // (first statistics of a Monday, or after a stop): never fetched for this.
  const previousDays = previousWeek?.days.filter((day) => Number.isFinite(day.kwh)) ?? [];

  if (days.length === 0) {
    if (previousDays.length === 0) {
      return content('week', [body(TEXTS.noWeekYet)]);
    }
    const previous = weekSummary({
      days: previousDays,
      name: TEXTS.previousWeek,
      hasProduction,
      language,
    });
    return content('week', [
      {
        type: 'chart',
        series: previous.series,
        chart_type: 'bar',
        unit: 'kWh',
        title: TEXTS.previousWeek,
      },
      { type: 'status', items: previous.items },
    ]);
  }

  const { series, items } = weekSummary({ days, name: TEXTS.consumption, hasProduction, language });
  items[0].label = TEXTS.weekTotal;
  if (previousDays.length > 0) {
    const previousTotal = previousDays.reduce((sum, day) => sum + day.kwh, 0);
    items.push({
      label: TEXTS.previousWeek,
      value: formatKwh(previousTotal, language),
      icon: 'calendar',
    });
  }
  return content('week', [
    { type: 'chart', series, chart_type: 'bar', unit: 'kWh' },
    { type: 'status', items },
  ]);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Content of the ambient widget.
 * @param {object} input - see buildEnergyContent
 */
export function buildAmbientContent({ snapshot, readings, config, ids }) {
  if (!snapshot || !readings) {
    return content('ambient', [body(TEXTS.notConnected)]);
  }
  if (!ambient.isAvailable(snapshot, config)) {
    return content('ambient', [body(TEXTS.noAmbient)]);
  }
  const reading = readings.stats?.ambient ?? null;
  const tiles = [
    ['temperatureIndoor', reading?.temperature?.indoor, 'thermometer'],
    ['temperatureOutdoor', reading?.temperature?.outdoor, 'thermometer'],
    ['humidityIndoor', reading?.humidity?.indoor, 'droplet'],
    ['humidityOutdoor', reading?.humidity?.outdoor, 'droplet'],
  ];
  // Before the first reading, every sensor is a candidate; afterwards only
  // the ones ecojoko actually reports (outdoor values may be missing).
  const shown = reading ? tiles.filter(([, value]) => Number.isFinite(value)) : tiles;
  const components = shown.map(([key, , icon]) => ({
    type: 'value',
    device_feature: ids[key],
    label: TEXTS[key],
    icon,
  }));
  const curves = shown.filter(([key]) => key.startsWith('temperature')).map(([key]) => ids[key]);
  if (curves.length > 0) {
    components.push({
      type: 'chart',
      device_features: curves,
      interval: 'last-day',
      chart_type: 'line',
      title: TEXTS.temperatureChart,
      unit: '°C',
    });
  }
  return content('ambient', components);
}

/** Builder of each widget key, for index.js and the manifest test. */
export const WIDGET_BUILDERS = {
  [WIDGET.ENERGY]: buildEnergyContent,
  [WIDGET.WEEK]: buildWeekContent,
  [WIDGET.AMBIENT]: buildAmbientContent,
};
