// -----------------------------------------------------------------------------
// Engine: everything that talks to ecojoko on behalf of the integration.
//
// The engine owns the API client and the cumulative-index store, and exposes
// three high-level operations the scheduler and the manifest actions call:
//   - discover()     : log in, find the gateway, take a capabilities snapshot
//   - readRealtime() : live power (W)
//   - readStats()    : today's totals, the synthesized index, ambient values
// It also keeps the LAST readings in memory (`getLastReadings()`): the
// dashboard widgets read them instead of calling ecojoko again, so a widget
// never adds a request to the two scheduled cadences.
// Nothing here knows about Gladys device payloads (see src/devices/).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createClient, parseDayStats, toNumberOrNull } from './ecojoko.js';
import { createIndexStore, weekToDailyKwh } from './index-store.js';
import { addDays, mondayOf, parisDate, weekDates, weekdayIndex } from './dates.js';

const logger = createLogger({ name: 'engine' });

/**
 * @param {object} params
 * @param {object} params.config - normalized configuration (credentials...)
 * @param {string} params.dataDir - writable folder for the index state
 * @param {Function} [params.clientFactory] - injectable for tests
 * @param {Function} [params.now] - injectable clock for tests
 */
export function createEngine({
  config,
  dataDir,
  clientFactory = createClient,
  now = () => new Date(),
}) {
  const client = clientFactory({ email: config.email, password: config.password });
  let snapshot = null;
  let indexStore = null;
  // Second, independent fold for the exported solar surplus. Only created
  // when the account actually reports one (`kwh_prod`).
  let productionStore = null;
  // Last readings, for the dashboard widgets (never an extra API call).
  let lastPower = null; // { watts, at }
  let lastStats = null; // see getLastReadings()
  // Raw week statistics seen lately, keyed by their Monday: the current week
  // (every readStats) and, when the index backfill fetched it, the previous
  // one. Nothing else is ever kept.
  const weeksByMonday = new Map();

  const today = () => parisDate(now());

  /**
   * Remember a raw 7-entry week and forget anything older than last week.
   */
  function rememberWeek(anyDateOfThatWeek, entries) {
    if (!Array.isArray(entries) || entries.length !== 7) {
      return;
    }
    const monday = mondayOf(anyDateOfThatWeek);
    weeksByMonday.set(monday, entries);
    const keep = new Set([
      monday,
      addDays(monday, -7),
      mondayOf(today()),
      addDays(mondayOf(today()), -7),
    ]);
    for (const key of weeksByMonday.keys()) {
      if (!keep.has(key)) {
        weeksByMonday.delete(key);
      }
    }
  }

  /**
   * The seven days (Monday..Sunday) of a remembered week, parsed, or null.
   * @returns {{ monday: string, days: Array<{ date, kwh, kwhProd, periods }> }|null}
   */
  function parsedWeek(monday) {
    const entries = weeksByMonday.get(monday);
    if (!entries) {
      return null;
    }
    const days = weekDates(monday).map((date, i) => {
      const day = parseDayStats(entries[i]);
      return { date, kwh: day.kwh, kwhProd: day.kwhProd, periods: day.periods };
    });
    return { monday, days };
  }

  /**
   * Log in, locate the gateway and read this week's statistics once to learn
   * what the account reports (tariff periods, solar surplus).
   */
  async function discover() {
    const gateway = await client.getGateway();
    const week = await client.getWeekStats(gateway, today());
    rememberWeek(today(), week);
    const todayStats = parseDayStats(week[weekdayIndex(today())]);
    snapshot = {
      gateway,
      capabilities: {
        periods: todayStats.periods.map((p) => p.label),
        hasProduction: Boolean(todayStats.hasProduction),
        hasTempHum: Boolean(gateway.tempHumId),
      },
      discoveredAt: now().toISOString(),
    };
    const meterKey = `${gateway.gatewayId}-${gateway.powerMeterId}`;
    indexStore = createIndexStore({ dataDir, meterKey });
    await indexStore.load();
    productionStore = null;
    if (todayStats.hasProduction) {
      productionStore = createIndexStore({
        dataDir,
        meterKey: `${meterKey}-production`,
        label: 'production',
      });
      await productionStore.load();
    }
    logger.info(
      `Gateway ${gateway.gatewayId} (firmware ${gateway.firmware ?? '?'}), meter ${gateway.powerMeterId}` +
        `${gateway.tempHumId ? `, ambient ${gateway.tempHumId}` : ''}` +
        `, periods: [${snapshot.capabilities.periods.join(', ')}]` +
        `${snapshot.capabilities.hasProduction ? ', solar surplus reported' : ''}`,
    );
    return snapshot;
  }

  function requireSnapshot() {
    if (!snapshot) {
      throw new Error('Engine not discovered yet');
    }
    return snapshot;
  }

  async function readRealtime() {
    const { gateway } = requireSnapshot();
    const watts = await client.getRealtimePower(gateway);
    lastPower = { watts, at: now().toISOString() };
    return watts;
  }

  /**
   * Refresh the daily statistics and the cumulative index.
   * @returns {Promise<{ index, todayKwh, kwhProd, periods, ambient }>}
   */
  async function readStats() {
    const { gateway } = requireSnapshot();
    const date = today();
    const week = await client.getWeekStats(gateway, date);
    rememberWeek(date, week);
    const dayStats = parseDayStats(week[weekdayIndex(date)]);
    const dailyKwh = weekToDailyKwh(week, date, (entry) => toNumberOrNull(entry?.kwh));
    const { index, todayKwh } = await indexStore.update({
      today: date,
      dailyKwh,
      fetchWeek: async (isoDate) => {
        const entries = await client.getWeekStats(gateway, isoDate);
        rememberWeek(isoDate, entries);
        return weekToDailyKwh(entries, isoDate, (entry) => toNumberOrNull(entry?.kwh));
      },
    });

    // Cumulative exported-energy index, folded exactly like the consumption
    // one. ecojoko reports the daily surplus with a sign that varies, so the
    // magnitude is what gets folded (parseDayStats already does the abs()).
    let productionIndex = null;
    if (productionStore) {
      const productionDaily = weekToDailyKwh(week, date, (entry) => {
        const value = toNumberOrNull(entry?.kwh_prod);
        return value === null ? null : Math.abs(value);
      });
      const folded = await productionStore.update({
        today: date,
        dailyKwh: productionDaily,
        fetchWeek: async (isoDate) => {
          const entries = await client.getWeekStats(gateway, isoDate);
          rememberWeek(isoDate, entries);
          return weekToDailyKwh(entries, isoDate, (entry) => {
            const value = toNumberOrNull(entry?.kwh_prod);
            return value === null ? null : Math.abs(value);
          });
        },
      });
      productionIndex = folded.index;
    }

    let ambient = null;
    if (gateway.tempHumId && config.environment) {
      try {
        const [temperature, humidity] = await Promise.all([
          client.getTemperature(gateway, date),
          client.getHumidity(gateway, date),
        ]);
        ambient = { temperature, humidity };
      } catch (err) {
        // Ambient values are a bonus: never let them break the energy refresh.
        logger.warn(`Ambient reading failed: ${err.message}`);
      }
    }

    const stats = {
      index,
      todayKwh: todayKwh ?? dayStats.kwh,
      kwhProd: dayStats.kwhProd,
      productionIndex,
      periods: dayStats.periods,
      ambient,
    };
    lastStats = { ...stats, date, at: now().toISOString() };
    return stats;
  }

  /**
   * What the widgets display: the last live power, the last statistics and
   * the week(s) in memory. Null fields mean "not read yet". Never triggers a
   * request.
   * @returns {{
   *   power: { watts: number, at: string }|null,
   *   stats: { date, at, todayKwh, kwhProd, periods, ambient }|null,
   *   week: { monday, days }|null,
   *   previousWeek: { monday, days }|null,
   * }}
   */
  function getLastReadings() {
    const monday = lastStats ? mondayOf(lastStats.date) : mondayOf(today());
    return {
      power: lastPower,
      stats: lastStats,
      week: parsedWeek(monday),
      previousWeek: parsedWeek(addDays(monday, -7)),
    };
  }

  return {
    discover,
    readRealtime,
    readStats,
    getLastReadings,
    getSnapshot: () => snapshot,
    getIndexState: () => indexStore?.getState() ?? null,
    getProductionIndexState: () => productionStore?.getState() ?? null,
  };
}
