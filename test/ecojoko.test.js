import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient,
  extractSessionCookie,
  parseDayStats,
  EcojokoAuthError,
  EcojokoApiError,
} from '../src/ecojoko.js';
import { createFakeFetch, GOOD, SESSION, weekEntries } from './helpers/fakeEcojoko.js';

test('extractSessionCookie keeps the real LKS value, not the expired duplicate', () => {
  const headers = [
    'LKS=abc; path=/; domain=ecojoko.com; secure',
    'LKS=; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/; domain=ecojoko.com; secure',
  ];
  assert.equal(extractSessionCookie(headers), 'abc');
  assert.equal(extractSessionCookie([headers[1]]), null);
  assert.equal(extractSessionCookie([]), null);
});

test('login posts the credentials and stores the session cookie', async () => {
  const { fetchImpl, state } = createFakeFetch();
  const client = createClient(GOOD, { fetchImpl });
  await client.login();
  assert.equal(client.hasSession(), true);
  assert.equal(state.calls[0].method, 'POST');
  assert.equal(state.calls[0].path, '/login');
  assert.equal(state.calls[0].headers.Cookie, undefined, 'no stale cookie on login');
});

test('bad credentials raise EcojokoAuthError with the service error id', async () => {
  const { fetchImpl } = createFakeFetch();
  const client = createClient({ email: GOOD.email, password: 'nope' }, { fetchImpl });
  await assert.rejects(client.getGateway(), (err) => {
    assert.ok(err instanceof EcojokoAuthError);
    assert.equal(err.errorId, 101);
    return true;
  });
  const badEmail = createClient({ email: 'not-an-email', password: 'x' }, { fetchImpl });
  await assert.rejects(badEmail.getGateway(), (err) => err.errorId === 102);
});

test('getGateway logs in lazily and finds the meter and ambient device ids', async () => {
  const { fetchImpl, state } = createFakeFetch();
  const client = createClient(GOOD, { fetchImpl });
  const gateway = await client.getGateway();
  assert.deepEqual(gateway, {
    gatewayId: '4242',
    firmware: '1.4.2',
    powerMeterId: '11',
    tempHumId: '12',
    gatewayCount: 1,
  });
  assert.deepEqual(
    state.calls.map((c) => c.path),
    ['/login', '/gateways'],
  );
  assert.equal(state.calls[1].headers.Cookie, `LKS=${SESSION}`);
});

test('an expired session triggers exactly one re-login, then the call succeeds', async () => {
  const { fetchImpl, state } = createFakeFetch({ realtime: 987 });
  const client = createClient(GOOD, { fetchImpl });
  const gateway = await client.getGateway();
  state.sessionValid = false; // the service forgets the session
  const watts = await client.getRealtimePower(gateway);
  assert.equal(watts, 987);
  assert.equal(state.loginCount, 2);
  assert.deepEqual(
    state.calls.slice(2).map((c) => c.path),
    ['/gateway/4242/device/11/realtime_conso', '/login', '/gateway/4242/device/11/realtime_conso'],
  );
});

test('a session refused twice in a row is an auth error, not an infinite loop', async () => {
  const { fetchImpl, state } = createFakeFetch();
  const client = createClient(GOOD, { fetchImpl });
  const gateway = await client.getGateway();
  // Login "works" but every authenticated call is rejected afterwards.
  const original = fetchImpl;
  const flaky = async (url, options) => {
    const response = await original(url, options);
    if (new URL(url).pathname !== '/login') {
      state.sessionValid = false;
      return original(url, options);
    }
    return response;
  };
  const client2 = createClient(GOOD, { fetchImpl: flaky });
  await assert.rejects(client2.getRealtimePower(gateway), EcojokoAuthError);
});

test('week statistics and ambient readings are returned raw / as last sample', async () => {
  const { fetchImpl } = createFakeFetch();
  const client = createClient(GOOD, { fetchImpl });
  const gateway = await client.getGateway();
  const week = await client.getWeekStats(gateway, '2026-09-08');
  assert.equal(week.length, 7);
  assert.equal(week[1].kwh, 11);
  assert.deepEqual(await client.getTemperature(gateway, '2026-09-08'), {
    indoor: 21.5,
    outdoor: 13.4,
  });
  assert.deepEqual(await client.getHumidity(gateway, '2026-09-08'), { indoor: 55, outdoor: 72 });
});

test('network failures surface as EcojokoApiError, never as a crash', async () => {
  const client = createClient(GOOD, {
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(client.getGateway(), (err) => {
    assert.ok(err instanceof EcojokoApiError);
    assert.match(err.message, /ECONNRESET/);
    return true;
  });
});

test('parseDayStats normalizes one daily entry', () => {
  const entry = weekEntries()[1];
  assert.deepEqual(parseDayStats(entry), {
    kwh: 11,
    kwhProd: null,
    hasProduction: false,
    periods: [
      { label: 'Heures Creuses', kwh: 5 },
      { label: 'Heures Pleines', kwh: 6 },
    ],
  });
  const solar = parseDayStats({ kwh: '3.5', kwh_prod: '-1.25', subconsumption: [] });
  assert.equal(solar.kwh, 3.5);
  assert.equal(solar.kwhProd, 1.25, 'surplus is a magnitude whatever the sign');
  assert.equal(solar.hasProduction, true);
  assert.deepEqual(parseDayStats(undefined), { kwh: null, kwhProd: null, periods: [] });
});
