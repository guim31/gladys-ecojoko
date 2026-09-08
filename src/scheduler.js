// -----------------------------------------------------------------------------
// Scheduler: the two timers of the integration, inside the container.
//
// Gladys polling only accepts sub-minute intervals and one frequency per
// device; this integration needs two cadences on the same device (live power
// every few seconds, daily statistics every few minutes), so it schedules
// itself and pushes states to Gladys.
//
// Failure policy:
//   - bad credentials (EcojokoAuthError) -> report it, stop everything: the
//     user must fix the configuration, retrying would only lock the account;
//   - anything else -> log, keep the timers, and flag the integration as
//     disconnected after 3 consecutive failures (back to connected on the
//     next success), so a cloud outage is visible in Gladys.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { EcojokoAuthError } from './ecojoko.js';
import { buildDiscoveredDevices, powerMeter, ambient } from './devices/index.js';

const logger = createLogger({ name: 'scheduler' });

const FAILURES_BEFORE_DISCONNECTED = 3;

export const MESSAGES = {
  badCredentials: {
    en: 'ecojoko rejected the email or password. Check the configuration.',
    fr: "ecojoko refuse l'identifiant ou le mot de passe. Vérifiez la configuration.",
  },
  unreachable: {
    en: 'ecojoko cloud not answering, retrying at the next schedule.',
    fr: 'Le cloud ecojoko ne répond pas, nouvelle tentative au prochain cycle.',
  },
  missingCredentials: {
    en: 'Enter your ecojoko email and password to start.',
    fr: 'Renseignez votre e-mail et votre mot de passe ecojoko pour démarrer.',
  },
};

/**
 * Discover the account, publish the devices, start both timers.
 * @returns {Promise<() => void>} stop function
 */
export async function startScheduler({ gladys, config, engine }) {
  const snapshot = await engine.discover();
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, snapshot, config));

  let stopped = false;
  let consecutiveFailures = 0;
  let connected = null; // last status reported to Gladys (null = none yet)
  let realtimeRunning = false;
  let statsRunning = false;
  const timers = [];

  async function reportConnected(value, message) {
    if (connected === value) {
      return;
    }
    connected = value;
    try {
      await gladys.setConnectionStatus(value, message);
    } catch (err) {
      logger.warn(`setConnectionStatus failed: ${err.message}`);
    }
  }

  function stop() {
    stopped = true;
    for (const timer of timers) {
      clearInterval(timer);
    }
    timers.length = 0;
  }

  async function guarded(label, fn) {
    if (stopped) {
      return;
    }
    try {
      await fn();
      consecutiveFailures = 0;
      await reportConnected(true);
    } catch (err) {
      if (err instanceof EcojokoAuthError) {
        logger.error(`${label}: ${err.message} -> stopping, configuration needed`);
        stop();
        await reportConnected(false, MESSAGES.badCredentials);
        return;
      }
      consecutiveFailures += 1;
      logger.warn(`${label} failed (${consecutiveFailures}): ${err.message}`);
      if (consecutiveFailures >= FAILURES_BEFORE_DISCONNECTED) {
        await reportConnected(false, MESSAGES.unreachable);
      }
    }
  }

  async function realtimeTick() {
    if (realtimeRunning) {
      return;
    }
    realtimeRunning = true;
    try {
      await guarded('live power', async () => {
        const watts = await engine.readRealtime();
        await gladys.publishStates(powerMeter.statesFromRealtime(gladys, snapshot, watts));
      });
    } finally {
      realtimeRunning = false;
    }
  }

  async function statsTick() {
    if (statsRunning) {
      return;
    }
    statsRunning = true;
    try {
      await guarded('daily statistics', async () => {
        const stats = await engine.readStats();
        const states = powerMeter.statesFromStats(gladys, snapshot, config, stats);
        if (stats.ambient && ambient.isAvailable(snapshot, config)) {
          states.push(...ambient.statesFromReading(gladys, snapshot, stats.ambient));
        }
        if (states.length > 0) {
          await gladys.publishStates(states);
        }
      });
    } finally {
      statsRunning = false;
    }
  }

  // First readings right away (a config save must show values without waiting
  // a full interval), then on schedule.
  await statsTick();
  await realtimeTick();
  if (!stopped) {
    timers.push(setInterval(realtimeTick, config.poll_frequency * 1000));
    timers.push(setInterval(statsTick, config.stats_frequency * 1000));
    logger.info(
      `Scheduled: live power every ${config.poll_frequency} s, statistics every ${config.stats_frequency} s`,
    );
  }
  return stop;
}
