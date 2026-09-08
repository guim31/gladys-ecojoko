// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Keyed by the `key` declared in the `actions` array of the manifest (a test
// keeps both in sync). Each handler resolves a multi-language message shown
// under the button.
// -----------------------------------------------------------------------------

import { hasCredentials } from './config.js';
import { MESSAGES } from './scheduler.js';

export const ACTIONS = {
  /**
   * Log in with the configured credentials, describe what the account
   * exposes and read the live power once. Uses a throwaway engine so a
   * running scheduler is never disturbed, and so the button works even when
   * the scheduler stopped on bad credentials.
   */
  async test_connection({ config, createEngine, dataDir }) {
    if (!hasCredentials(config)) {
      return MESSAGES.missingCredentials;
    }
    const engine = createEngine({ config, dataDir });
    const snapshot = await engine.discover();
    const watts = await engine.readRealtime();
    const { gateway, capabilities } = snapshot;
    const periods = capabilities.periods.length ? capabilities.periods.join(', ') : '-';
    const ambientEn = capabilities.hasTempHum ? 'yes' : 'no';
    const ambientFr = capabilities.hasTempHum ? 'oui' : 'non';
    const prodEn = capabilities.hasProduction ? 'yes' : 'no';
    const prodFr = capabilities.hasProduction ? 'oui' : 'non';
    return {
      en:
        `Connected. Gateway ${gateway.gatewayId} (firmware ${gateway.firmware ?? '?'}), ` +
        `live power ${Math.round(watts)} W.\n` +
        `Tariff periods: ${periods} · solar surplus: ${prodEn} · ambient sensor: ${ambientEn}`,
      fr:
        `Connexion réussie. Passerelle ${gateway.gatewayId} (firmware ${gateway.firmware ?? '?'}), ` +
        `puissance instantanée ${Math.round(watts)} W.\n` +
        `Périodes tarifaires : ${periods} · surplus solaire : ${prodFr} · capteur d'ambiance : ${ambientFr}`,
    };
  },
};
