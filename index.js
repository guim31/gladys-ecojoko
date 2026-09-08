// -----------------------------------------------------------------------------
// Entry point of the Gladys ecojoko external integration.
//
// Role of this file: wire the SDK to the engine and the scheduler. It holds no
// business logic:
//   - src/ecojoko.js      the reverse-engineered cloud client
//   - src/index-store.js  the synthesized cumulative kWh index (persisted)
//   - src/engine.js       discovery + readings
//   - src/scheduler.js    the two timers, state publication, failure policy
//   - src/devices/        the Gladys device payloads
//   - src/actions.js      the Configuration-screen buttons
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
//     (read by the SDK: `new GladysIntegration()` is enough)
//   - DATA_DIR (optional, defaults to /data, the sandbox's only writable path)
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { hasCredentials, normalizeConfig } from './src/config.js';
import { createEngine } from './src/engine.js';
import { startScheduler, MESSAGES } from './src/scheduler.js';
import { buildDiscoveredDevices } from './src/devices/index.js';
import { ACTIONS } from './src/actions.js';

const DATA_DIR = process.env.DATA_DIR || '/data';

const gladys = new GladysIntegration();

let config = normalizeConfig();
let engine = null;
let stopScheduler = null;
// Serializes start/stop so a config update racing the connection handler
// never leaves two schedulers running.
let lifecycle = Promise.resolve();

function stopEverything() {
  if (stopScheduler) {
    stopScheduler();
    stopScheduler = null;
  }
  engine = null;
}

/**
 * (Re)start the integration with the current configuration.
 */
async function restart() {
  stopEverything();
  if (!hasCredentials(config)) {
    logger.info('No credentials configured yet');
    await gladys.setConnectionStatus(false, MESSAGES.missingCredentials);
    return;
  }
  engine = createEngine({ config, dataDir: DATA_DIR });
  try {
    stopScheduler = await startScheduler({ gladys, config, engine });
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Start failed', err);
    stopEverything();
    const message =
      err.name === 'EcojokoAuthError' ? MESSAGES.badCredentials : MESSAGES.unreachable;
    await gladys.setConnectionStatus(false, message).catch(() => {});
    if (err.name !== 'EcojokoAuthError') {
      // Transient: try again in a minute rather than staying idle until a
      // config change. Bad credentials wait for the user instead.
      setTimeout(() => queue(restart), 60000).unref();
    }
  }
}

function queue(task) {
  lifecycle = lifecycle.then(task).catch((err) => logger.error('Lifecycle task failed', err));
  return lifecycle;
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  const snapshot = engine?.getSnapshot();
  if (!snapshot) {
    logger.info('onScanRequest before discovery: nothing to publish yet');
    return;
  }
  logger.info('onScanRequest -> publishing discovered devices');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, snapshot, config));
});

// --- Command: every feature is read-only -------------------------------------
gladys.onSetValue(async (device, feature) => {
  throw new Error(`ecojoko sensors are read-only (${feature.external_id})`);
});

// --- Manifest actions --------------------------------------------------------
for (const [key, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(key, (fields) => handler({ fields, config, createEngine, dataDir: DATA_DIR }));
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> restarting with the new configuration');
  config = normalizeConfig(newConfig);
  await queue(restart);
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
  } catch (err) {
    logger.error('Cannot fetch the configuration', err);
    return;
  }
  await queue(restart);
});

gladys.on('disconnected', () => {
  queue(async () => stopEverything());
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopEverything();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the ecojoko integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
