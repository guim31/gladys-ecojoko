// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG, LIMITS, normalizeConfig } from '../src/config.js';
import {
  WIDGET,
  WIDGET_BUILDERS,
  ENERGY_INTERVALS,
  DEFAULT_ENERGY_INTERVAL,
} from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler, and vice versa', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  const handled = new Set(Object.keys(ACTIONS));
  assert.deepEqual([...declared].sort(), [...handled].sort());
});

test('manifest version stays in lockstep with package.json and the image tag', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('dashboard widgets (and catalog categories) require Gladys >= 5.1.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion);
  const [, major, minor] = minVersion.map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1));
  assert.ok(pkg.dependencies['@gladysassistant/integration-sdk'].startsWith('^0.14'));
});

test('every declared widget has a builder and a registered handler, and vice versa', () => {
  const declared = manifest.widgets.map((w) => w.key).sort();
  assert.deepEqual(declared, Object.values(WIDGET).sort());
  assert.deepEqual(Object.keys(WIDGET_BUILDERS).sort(), declared);
  // index.js registers one onWidgetGet per WIDGET key, in a loop.
  assert.ok(indexSource.includes('for (const key of Object.values(WIDGET))'));
  assert.ok(indexSource.includes('gladys.onWidgetGet(key'));
  assert.ok(manifest.widgets.length <= 5, 'the core accepts 5 widgets at most');
});

test('widget declarations respect the store and core constraints', () => {
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    for (const lang of ['en', 'fr']) {
      const label = widget.label[lang];
      assert.ok(label && label.length >= 3 && label.length <= 30, `${widget.key} label.${lang}`);
      const description = widget.description?.[lang] ?? '';
      assert.ok(description.length <= 100, `${widget.key} description.${lang}`);
    }
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/);
    // No button in any content: no action timeout to declare.
    assert.equal(widget.action_timeout_seconds, undefined);
    for (const setting of widget.settings ?? []) {
      assert.ok(['string', 'number', 'boolean', 'select', 'section'].includes(setting.type));
      if (setting.type === 'number') {
        for (const bound of ['min', 'max', 'default']) {
          if (setting[bound] !== undefined) {
            assert.ok(Number.isInteger(setting[bound]), `${setting.key}.${bound}`);
          }
        }
      }
    }
  }
});

test('the energy interval options match what the builder understands', () => {
  const energy = manifest.widgets.find((w) => w.key === WIDGET.ENERGY);
  const interval = energy.settings.find((s) => s.key === 'interval');
  assert.equal(interval.type, 'select');
  assert.deepEqual(
    interval.options.map((o) => o.value),
    ENERGY_INTERVALS,
  );
  assert.equal(interval.default, DEFAULT_ENERGY_INTERVAL);
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
