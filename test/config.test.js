import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, LIMITS, hasCredentials, normalizeConfig } from '../src/config.js';

test('normalizeConfig returns the defaults for an empty config', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test('numbers arriving as strings are parsed and clamped', () => {
  const config = normalizeConfig({ poll_frequency: '10', stats_frequency: '99999' });
  assert.equal(config.poll_frequency, 10);
  assert.equal(config.stats_frequency, LIMITS.stats_frequency.max);
  assert.equal(normalizeConfig({ poll_frequency: 1 }).poll_frequency, LIMITS.poll_frequency.min);
  assert.equal(
    normalizeConfig({ poll_frequency: 'abc' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('booleans accept the string form sent by some forms', () => {
  assert.equal(normalizeConfig({ environment: 'false' }).environment, false);
  assert.equal(normalizeConfig({ environment: false }).environment, false);
  assert.equal(normalizeConfig({ environment: 'true' }).environment, true);
  assert.equal(normalizeConfig({ sub_consumption: null }).sub_consumption, true);
});

test('credentials are trimmed (email) but never altered (password)', () => {
  const config = normalizeConfig({ email: '  me@example.com ', password: ' p a s s ' });
  assert.equal(config.email, 'me@example.com');
  assert.equal(config.password, ' p a s s ');
  assert.equal(hasCredentials(config), true);
  assert.equal(hasCredentials(normalizeConfig({ email: 'me@example.com' })), false);
  assert.equal(hasCredentials(normalizeConfig({ password: 'x' })), false);
});
