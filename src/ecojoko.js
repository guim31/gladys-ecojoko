// -----------------------------------------------------------------------------
// ecojoko cloud client.
//
// ecojoko publishes no API: this is the private HTTP interface the web app at
// service.ecojoko.com uses, reverse-engineered by the community (the Home
// Assistant "little_monkey" integration is the reference). Everything is
// read-only: this client never writes anything to the ecojoko account.
//
//   POST /login {l, p}                       -> Set-Cookie: LKS=<session>
//   GET  /gateways                           -> { gateways: [{ gateway_id,
//                                               gateway_firmware_version,
//                                               devices: [{ device_id,
//                                               device_type }] }] }
//   GET  /gateway/<gw>/device/<pm>/realtime_conso
//                                            -> { real_time: { value: W } }
//   GET  /gateway/<gw>/device/<pm>/powerstat/w/<YYYY-MM-DD>
//                                            -> { stat: { data: [7 days,
//                                               { kwh, kwh_prod?,
//                                               subconsumption?: [{label, kwh}] }]}}
//   GET  /gateway/<gw>/device/<th>/tempstat/d4/<YYYY-MM-DD>
//   GET  /gateway/<gw>/device/<th>/humstat/d4/<YYYY-MM-DD>
//                                            -> { stat: { data: [{ value,
//                                               ext_value }] } }
//
// Error contract observed on the live service (probed 2026-09-08):
//   400 { error_id: 102 }  invalid email format
//   401 { error_id: 101 }  unknown email/password
//   401 { error_id: 305 }  session expired  -> log in again, retry once
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

export const BASE_URL = 'https://service.ecojoko.com';
export const REQUEST_TIMEOUT_MS = 15000;

const DEVICE_TYPES = {
  POWER_METER: 'POWER_METER',
  TEMP_HUM: 'TEMP_HUM',
};

const logger = createLogger({ name: 'ecojoko' });

/** Bad credentials: retrying will not help, the user has to act. */
export class EcojokoAuthError extends Error {
  constructor(message, errorId) {
    super(message);
    this.name = 'EcojokoAuthError';
    this.errorId = errorId;
  }
}

/** Anything else: transient (network, 5xx) or a response we cannot parse. */
export class EcojokoApiError extends Error {
  constructor(message, status, errorId) {
    super(message);
    this.name = 'EcojokoApiError';
    this.status = status;
    this.errorId = errorId;
  }
}

/**
 * Extract the LKS session cookie from a login response. The service sets the
 * cookie twice (a value, then an expired duplicate): keep the non-empty one.
 */
export function extractSessionCookie(setCookieHeaders) {
  let session = null;
  for (const header of setCookieHeaders ?? []) {
    const match = /^LKS=([^;]*)/.exec(header);
    if (match && match[1] && !/expires=Thu, 01-Jan-1970/i.test(header)) {
      session = match[1];
    }
  }
  return session;
}

/**
 * Parse a JSON body, tolerating empty or non-JSON responses.
 */
async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeError(body, status) {
  const desc = body?.error_desc ? ` ${body.error_desc}` : '';
  return `ecojoko HTTP ${status}${body?.error_id ? ` (error ${body.error_id})` : ''}${desc}`;
}

/**
 * Create a client bound to one account. `fetchImpl` is injectable for tests.
 */
export function createClient({ email, password }, { fetchImpl = globalThis.fetch } = {}) {
  let session = null;

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth && session) {
      headers.Cookie = `LKS=${session}`;
    }
    let response;
    try {
      response = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch (err) {
      throw new EcojokoApiError(`ecojoko unreachable (${path}): ${err.message}`, 0);
    }
    const json = await readJson(response);
    return { response, json };
  }

  async function login() {
    session = null;
    const { response, json } = await request('/login', {
      method: 'POST',
      body: { l: email, p: password },
      auth: false,
    });
    if (response.status === 401 || response.status === 400 || response.status === 403) {
      throw new EcojokoAuthError(describeError(json, response.status), json?.error_id);
    }
    if (!response.ok) {
      throw new EcojokoApiError(
        describeError(json, response.status),
        response.status,
        json?.error_id,
      );
    }
    const cookie = extractSessionCookie(response.headers.getSetCookie?.() ?? []);
    if (!cookie) {
      throw new EcojokoApiError('ecojoko login succeeded but returned no session cookie', 200);
    }
    session = cookie;
    logger.info('Logged in to ecojoko');
    return session;
  }

  /**
   * Authenticated GET. Logs in lazily, and once more when the session has
   * expired (error 305) before giving up.
   */
  async function get(path, { retried = false } = {}) {
    if (!session) {
      await login();
    }
    const { response, json } = await request(path);
    if (response.status === 401 || response.status === 403) {
      if (!retried) {
        logger.info(`Session rejected on ${path}, logging in again`);
        session = null;
        return get(path, { retried: true });
      }
      throw new EcojokoAuthError(describeError(json, response.status), json?.error_id);
    }
    if (!response.ok) {
      throw new EcojokoApiError(
        describeError(json, response.status),
        response.status,
        json?.error_id,
      );
    }
    if (json === null) {
      throw new EcojokoApiError(`ecojoko returned a non-JSON body on ${path}`, response.status);
    }
    return json;
  }

  /**
   * The first gateway of the account, with its power meter and (optional)
   * temperature/humidity device ids.
   */
  async function getGateway() {
    const json = await get('/gateways');
    const gateway = json?.gateways?.[0];
    if (!gateway || gateway.gateway_id === undefined) {
      throw new EcojokoApiError('No ecojoko gateway on this account', 200);
    }
    const devices = Array.isArray(gateway.devices) ? gateway.devices : [];
    const powerMeter = devices.find((d) => d.device_type === DEVICE_TYPES.POWER_METER);
    const tempHum = devices.find((d) => d.device_type === DEVICE_TYPES.TEMP_HUM);
    if (!powerMeter) {
      throw new EcojokoApiError('The ecojoko gateway has no power meter device', 200);
    }
    return {
      gatewayId: String(gateway.gateway_id),
      firmware: gateway.gateway_firmware_version ?? null,
      powerMeterId: String(powerMeter.device_id),
      tempHumId: tempHum ? String(tempHum.device_id) : null,
      gatewayCount: json.gateways.length,
    };
  }

  /** Live power draw in watts. */
  async function getRealtimePower(gateway) {
    const json = await get(
      `/gateway/${gateway.gatewayId}/device/${gateway.powerMeterId}/realtime_conso`,
    );
    const value = Number(json?.real_time?.value);
    if (!Number.isFinite(value)) {
      throw new EcojokoApiError('realtime_conso returned no numeric value', 200);
    }
    return value;
  }

  /**
   * The seven daily entries (Monday..Sunday) of the week containing `isoDate`,
   * raw, as returned by the service.
   */
  async function getWeekStats(gateway, isoDate) {
    const json = await get(
      `/gateway/${gateway.gatewayId}/device/${gateway.powerMeterId}/powerstat/w/${isoDate}`,
    );
    const data = json?.stat?.data;
    if (!Array.isArray(data)) {
      throw new EcojokoApiError('powerstat returned no data array', 200);
    }
    return data;
  }

  /** Last indoor/outdoor sample of a `tempstat` or `humstat` day series. */
  async function getAmbient(gateway, kind, isoDate) {
    const json = await get(
      `/gateway/${gateway.gatewayId}/device/${gateway.tempHumId}/${kind}/d4/${isoDate}`,
    );
    const data = json?.stat?.data;
    if (!Array.isArray(data) || data.length === 0) {
      return { indoor: null, outdoor: null };
    }
    const last = data[data.length - 1];
    return { indoor: toNumberOrNull(last.value), outdoor: toNumberOrNull(last.ext_value) };
  }

  return {
    login,
    getGateway,
    getRealtimePower,
    getWeekStats,
    getTemperature: (gateway, isoDate) => getAmbient(gateway, 'tempstat', isoDate),
    getHumidity: (gateway, isoDate) => getAmbient(gateway, 'humstat', isoDate),
    /** For tests and diagnostics only. */
    hasSession: () => session !== null,
  };
}

export function toNumberOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Turn one raw daily entry of `/powerstat/w/` into numbers we can publish.
 *   kwh        -> total grid consumption of the day so far
 *   kwh_prod   -> solar surplus exported (sign varies, take the magnitude)
 *   subconsumption[] -> per tariff-period split ("Heures Creuses", "HP Bleu"...)
 */
export function parseDayStats(entry) {
  if (!entry || typeof entry !== 'object') {
    return { kwh: null, kwhProd: null, periods: [] };
  }
  const kwhProdRaw = toNumberOrNull(entry.kwh_prod);
  const periods = Array.isArray(entry.subconsumption)
    ? entry.subconsumption
        .map((item) => ({
          label: String(item?.label ?? '').trim(),
          kwh: toNumberOrNull(item?.kwh),
        }))
        .filter((item) => item.label.length > 0)
    : [];
  return {
    kwh: toNumberOrNull(entry.kwh),
    kwhProd: kwhProdRaw === null ? null : Math.abs(kwhProdRaw),
    hasProduction: entry.kwh_prod !== undefined,
    periods,
  };
}
