// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG, LIMITS, normalizeConfig } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('every manifest action has a registered handler, and vice versa', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  const handled = new Set(Object.keys(ACTIONS));
  assert.deepEqual([...declared].sort(), [...handled].sort());
});

test('manifest version stays in lockstep with package.json and the image tag', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion);
  const [, major, minor] = minVersion.map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 86));
});

test('config_schema defaults and bounds stay consistent with the code', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, `default of ${field.key}`);
    }
    if (field.type === 'number') {
      assert.deepEqual(
        LIMITS[field.key],
        { min: field.min, max: field.max },
        `bounds of ${field.key}`,
      );
    }
  }
});

test('every value-bearing config_schema field is normalized by the code', () => {
  const normalized = normalizeConfig({});
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(field.key in normalized, `normalizeConfig ignores "${field.key}"`);
  }
});

test('the password is a secret and the credentials are required', () => {
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(password.type, 'secret');
  assert.equal(password.required, true);
  assert.equal(manifest.config_schema.find((f) => f.key === 'email').required, true);
});
