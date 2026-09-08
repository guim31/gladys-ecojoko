// -----------------------------------------------------------------------------
// Engine: everything that talks to ecojoko on behalf of the integration.
//
// The engine owns the API client and the cumulative-index store, and exposes
// three high-level operations the scheduler and the manifest actions call:
//   - discover()     : log in, find the gateway, take a capabilities snapshot
//   - readRealtime() : live power (W)
//   - readStats()    : today's totals, the synthesized index, ambient values
// Nothing here knows about Gladys device payloads (see src/devices/).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createClient, parseDayStats, toNumberOrNull } from './ecojoko.js';
import { createIndexStore, weekToDailyKwh } from './index-store.js';
import { parisDate, weekdayIndex } from './dates.js';

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

  const today = () => parisDate(now());

  /**
   * Log in, locate the gateway and read this week's statistics once to learn
   * what the account reports (tariff periods, solar surplus).
   */
  async function discover() {
    const gateway = await client.getGateway();
    const week = await client.getWeekStats(gateway, today());
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
    indexStore = createIndexStore({
      dataDir,
      meterKey: `${gateway.gatewayId}-${gateway.powerMeterId}`,
    });
    await indexStore.load();
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
    return client.getRealtimePower(gateway);
  }

  /**
   * Refresh the daily statistics and the cumulative index.
   * @returns {Promise<{ index, todayKwh, kwhProd, periods, ambient }>}
   */
  async function readStats() {
    const { gateway } = requireSnapshot();
    const date = today();
    const week = await client.getWeekStats(gateway, date);
    const dayStats = parseDayStats(week[weekdayIndex(date)]);
    const dailyKwh = weekToDailyKwh(week, date, (entry) => toNumberOrNull(entry?.kwh));
    const { index, todayKwh } = await indexStore.update({
      today: date,
      dailyKwh,
      fetchWeek: async (isoDate) => {
        const entries = await client.getWeekStats(gateway, isoDate);
        return weekToDailyKwh(entries, isoDate, (entry) => toNumberOrNull(entry?.kwh));
      },
    });

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

    return {
      index,
      todayKwh: todayKwh ?? dayStats.kwh,
      kwhProd: dayStats.kwhProd,
      periods: dayStats.periods,
      ambient,
    };
  }

  return {
    discover,
    readRealtime,
    readStats,
    getSnapshot: () => snapshot,
    getIndexState: () => indexStore?.getState() ?? null,
  };
}
