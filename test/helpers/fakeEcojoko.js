// -----------------------------------------------------------------------------
// A scripted `fetch` reproducing the ecojoko service, for unit tests of the
// client: login with cookie, session check, the data endpoints, and the error
// shapes observed on the live service (probed 2026-09-08).
// -----------------------------------------------------------------------------

export const GOOD = { email: 'me@example.com', password: 'secret' };
export const SESSION = 'abc123session';

export const GATEWAYS = {
  gateways: [
    {
      gateway_id: 4242,
      gateway_firmware_version: '1.4.2',
      devices: [
        { device_id: 11, device_type: 'POWER_METER' },
        { device_id: 12, device_type: 'TEMP_HUM' },
      ],
    },
  ],
};

export function weekEntries(overrides = {}) {
  const base = Array.from({ length: 7 }, (_, i) => ({
    kwh: 10 + i,
    subconsumption: [
      { label: 'Heures Creuses', kwh: 4 + i },
      { label: 'Heures Pleines', kwh: 6 },
    ],
  }));
  for (const [index, entry] of Object.entries(overrides)) {
    base[Number(index)] = entry;
  }
  return base;
}

function json(status, body, extraHeaders = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...extraHeaders });
  const response = new Response(JSON.stringify(body), { status, headers });
  return response;
}

/**
 * Build a fake fetch. `state` lets tests inspect calls and expire the session.
 */
export function createFakeFetch({ week = weekEntries(), realtime = 1234, weeksByDate = {} } = {}) {
  const state = {
    calls: [],
    sessionValid: true,
    loginCount: 0,
  };

  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    state.calls.push({ path: pathname, method: options.method ?? 'GET', headers: options.headers });

    if (pathname === '/login') {
      state.loginCount += 1;
      const body = JSON.parse(options.body);
      if (!/^[^@]+@[^@]+\.[a-z]+$/i.test(body.l)) {
        return json(400, { error_id: 102, error_desc: "Format d'email invalide." });
      }
      if (body.l !== GOOD.email || body.p !== GOOD.password) {
        return json(401, { error_id: 101, error_desc: 'Email ou mot de passe inconnu.' });
      }
      state.sessionValid = true;
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', `LKS=${SESSION}; path=/; domain=ecojoko.com; secure`);
      headers.append(
        'Set-Cookie',
        'LKS=; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/; domain=ecojoko.com; secure',
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    const cookie = options.headers?.Cookie ?? '';
    if (cookie !== `LKS=${SESSION}` || !state.sessionValid) {
      return json(401, { error_id: 305, error_desc: 'Votre session a expiré.' });
    }

    if (pathname === '/gateways') {
      return json(200, GATEWAYS);
    }
    let match = /^\/gateway\/4242\/device\/11\/realtime_conso$/.exec(pathname);
    if (match) {
      return json(200, { real_time: { value: realtime } });
    }
    match = /^\/gateway\/4242\/device\/11\/powerstat\/w\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (match) {
      const entries = weeksByDate[match[1]] ?? week;
      return json(200, { stat: { data: entries } });
    }
    match = /^\/gateway\/4242\/device\/12\/(tempstat|humstat)\/d4\/(\d{4}-\d{2}-\d{2})$/.exec(
      pathname,
    );
    if (match) {
      const isTemp = match[1] === 'tempstat';
      return json(200, {
        stat: {
          data: [
            { value: isTemp ? 20.5 : 50, ext_value: isTemp ? 12.1 : 70 },
            { value: isTemp ? 21.5 : 55, ext_value: isTemp ? 13.4 : 72 },
          ],
        },
      });
    }
    return json(404, { error_id: 404, error_desc: 'not found' });
  };

  return { fetchImpl, state };
}
