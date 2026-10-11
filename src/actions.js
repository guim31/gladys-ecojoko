// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Keyed by the `key` declared in the `actions` array of the manifest (a test
// keeps both in sync). Each handler resolves a multi-language message shown
// under the button.
// -----------------------------------------------------------------------------

import { hasCredentials } from './config.js';
import { MESSAGES } from './scheduler.js';

/** Yes / no in the result of test_connection. */
export const YES = { en: 'yes', fr: 'oui', de: 'ja', es: 'sí' };
export const NO = { en: 'no', fr: 'non', de: 'nein', es: 'no' };

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
    const live = Math.round(watts);
    const firmware = gateway.firmware ?? '?';
    const flag = (value) => (value ? YES : NO);
    const prod = flag(capabilities.hasProduction);
    const amb = flag(capabilities.hasTempHum);
    return {
      en:
        `Connected. Gateway ${gateway.gatewayId} (firmware ${firmware}), live power ${live} W.\n` +
        `Tariff periods: ${periods} · solar surplus: ${prod.en} · ambient sensor: ${amb.en}`,
      fr:
        `Connexion réussie. Passerelle ${gateway.gatewayId} (firmware ${firmware}), ` +
        `puissance instantanée ${live} W.\n` +
        `Périodes tarifaires : ${periods} · surplus solaire : ${prod.fr} · capteur d'ambiance : ${amb.fr}`,
      de:
        `Verbunden. Gateway ${gateway.gatewayId} (Firmware ${firmware}), ` +
        `aktuelle Leistung ${live} W.\n` +
        `Tarifzeiten: ${periods} · Solarüberschuss: ${prod.de} · Raumklimasensor: ${amb.de}`,
      es:
        `Conexión correcta. Pasarela ${gateway.gatewayId} (firmware ${firmware}), ` +
        `potencia instantánea ${live} W.\n` +
        `Periodos tarifarios: ${periods} · excedente solar: ${prod.es} · sensor ambiental: ${amb.es}`,
    };
  },
};
