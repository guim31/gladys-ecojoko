// -----------------------------------------------------------------------------
// Device registry.
//
// Two device types, both built from the `snapshot` the engine takes when it
// connects to the account (gateway ids, tariff periods, solar surplus, ambient
// sensor present or not):
//   - powerMeter : live power, cumulative index, today's consumption...
//   - ambient    : temperature / humidity, when the account reports them
// -----------------------------------------------------------------------------

import { powerMeter } from './power-meter.js';
import { ambient } from './ambient.js';

export { powerMeter, ambient };

export const DEVICE_BLUEPRINTS = [powerMeter, ambient];

/**
 * Build the discovery payload for Gladys (all devices available on the account).
 */
export function buildDiscoveredDevices(gladys, snapshot, config) {
  const devices = [powerMeter.buildDevice(gladys, snapshot, config)];
  if (ambient.isAvailable(snapshot, config)) {
    devices.push(ambient.buildDevice(gladys, snapshot));
  }
  return devices;
}
