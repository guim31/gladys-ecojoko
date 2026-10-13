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
//
// Logs: a normal cycle writes nothing at info level (debug only). A failing
// reading is logged once as a warning when it starts failing, then in debug
// on each further attempt, and once at info level when it works again.
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
    de: 'ecojoko lehnt die E-Mail-Adresse oder das Passwort ab. Überprüfe die Konfiguration.',
    es: 'ecojoko rechaza el correo electrónico o la contraseña. Compruebe la configuración.',
  },
  unreachable: {
    en: 'ecojoko cloud not answering, retrying at the next schedule.',
    fr: 'Le cloud ecojoko ne répond pas, nouvelle tentative au prochain cycle.',
    de: 'Die ecojoko-Cloud antwortet nicht, neuer Versuch beim nächsten Zyklus.',
    es: 'La nube de ecojoko no responde, nuevo intento en el próximo ciclo.',
  },
  missingCredentials: {
    en: 'Enter your ecojoko email and password to start.',
    fr: 'Renseignez votre e-mail et votre mot de passe ecojoko pour démarrer.',
    de: 'Gib deine ecojoko-E-Mail-Adresse und dein Passwort ein, um zu starten.',
    es: 'Introduzca su correo electrónico y su contraseña de ecojoko para empezar.',
  },
};

/**
 * Discover the account, publish the devices, start both timers.
 * @returns {Promise<{ stop: () => void, poll: (device: object) => Promise<void> }>}
 *   `stop` clears the timers; `poll` runs the reading matching one device
 *   right away (the `onPoll` fallback, if Gladys polling is ever enabled).
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
  // Readings currently failing, by label: only the first failure of a streak
  // is a warning, the next ones are debug lines.
  const failing = new Set();
  // When each reading was last attempted (Date.now()), so the onPoll fallback
  // never reads ecojoko twice within one scheduled interval, outage included
  // (the timers retry on their own).
  let realtimeAt = 0;
  let statsAt = 0;

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
      if (failing.delete(label)) {
        logger.info(`${label}: back to normal`);
      }
      await reportConnected(true);
    } catch (err) {
      if (err instanceof EcojokoAuthError) {
        logger.error(`${label}: ${err.message} -> stopping, configuration needed`);
        stop();
        await reportConnected(false, MESSAGES.badCredentials);
        return;
      }
      consecutiveFailures += 1;
      if (failing.has(label)) {
        logger.debug(`${label} failed again (${consecutiveFailures}): ${err.message}`);
      } else {
        failing.add(label);
        logger.warn(`${label} failed: ${err.message} (further failures logged in debug)`);
      }
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
        realtimeAt = Date.now();
        const watts = await engine.readRealtime();
        logger.debug(`live power: ${watts} W`);
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
        statsAt = Date.now();
        const stats = await engine.readStats();
        const states = powerMeter.statesFromStats(gladys, snapshot, config, stats);
        if (stats.ambient && ambient.isAvailable(snapshot, config)) {
          states.push(...ambient.statesFromReading(gladys, snapshot, stats.ambient));
        }
        logger.debug(`daily statistics: ${states.length} state(s) published`);
        if (states.length > 0) {
          await gladys.publishStates(states);
        }
      });
    } finally {
      statsRunning = false;
    }
  }

  /**
   * Gladys asked to poll one of our devices. Not expected (the devices are
   * published with `should_poll: false`), but if a user turns polling on from
   * the device page, answer with the matching reading instead of "not
   * implemented": live power for the meter, statistics for the ambient device.
   * The timers keep running either way, so a poll that comes within the
   * interval of the last attempted reading is answered without a request:
   * those states are already in Gladys, or the timer will retry.
   */
  async function poll(device) {
    if (stopped) {
      return;
    }
    const externalId = device?.external_id;
    if (externalId === powerMeter.deviceExternalId(gladys, snapshot)) {
      if (Date.now() - realtimeAt < config.poll_frequency * 1000) {
        logger.debug('poll: live power read recently, nothing to do');
        return;
      }
      await realtimeTick();
    } else if (
      ambient.isAvailable(snapshot, config) &&
      externalId === ambient.deviceExternalId(gladys, snapshot)
    ) {
      if (Date.now() - statsAt < config.stats_frequency * 1000) {
        logger.debug('poll: statistics read recently, nothing to do');
        return;
      }
      await statsTick();
    } else {
      logger.warn(`Poll requested for an unknown device: ${externalId}`);
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
  return { stop, poll };
}
