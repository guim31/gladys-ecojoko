// -----------------------------------------------------------------------------
// Translations: every multi-language text carries exactly en, fr, de and es.
//
// Gladys shows the user's language when the text has it, English otherwise:
// a missing `de` or `es` silently falls back to English. These tests walk the
// whole manifest and the message tables of the code, so an object added
// without its four languages fails here rather than in front of a user.
//
// Register: German says "du", Spanish says "usted" (decided for every
// integration of guim31). A capitalized polite German pronoun is a mistake.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { TEXTS, formatKwh, weekdayName } from '../src/widgets.js';
import { MESSAGES } from '../src/scheduler.js';
import { ACTIONS, YES, NO } from '../src/actions.js';

const LANGUAGES = ['de', 'en', 'es', 'fr'];
const POLITE_GERMAN = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** True when `value` looks like a multi-language text: an object with a language key. */
function isLocalized(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    LANGUAGES.some((lang) => typeof value[lang] === 'string')
  );
}

/** Every multi-language object under `node`, with its path. */
function collect(node, path = '', found = []) {
  if (isLocalized(node)) {
    found.push({ path, text: node });
  } else if (Array.isArray(node)) {
    node.forEach((child, i) => collect(child, `${path}[${i}]`, found));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      collect(child, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

/** Problems of one multi-language text (empty list when it is fine). */
function checkLocalized(text, maxLength, path) {
  const problems = [];
  const keys = Object.keys(text).sort();
  if (keys.join() !== LANGUAGES.join()) {
    problems.push(`${path}: languages [${keys}] instead of [${LANGUAGES}]`);
  }
  for (const lang of LANGUAGES) {
    const value = text[lang];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${path}.${lang}: empty`);
    } else if (value.length > maxLength) {
      problems.push(`${path}.${lang}: ${value.length} characters, ${maxLength} allowed`);
    }
  }
  if (typeof text.de === 'string' && POLITE_GERMAN.test(text.de)) {
    problems.push(`${path}.de: polite "Sie"/"Ihr" form, German says "du"`);
  }
  return problems;
}

/** Length bound of a manifest text, from its path. */
function manifestBound(path) {
  if (path === 'description') return 100; // store
  if (/^widgets\[\d+\]\.label$/.test(path)) return 30; // core
  if (/^widgets\[\d+\]\.description$/.test(path)) return 100; // core
  if (/\.(label|placeholder)$/.test(path)) return 60;
  return 500;
}

// Texts the widgets render as tile labels or series names (24 characters in
// the core); the others are status labels or chart titles (40) or bodies (300).
const WIDGET_BODIES = ['notConnected', 'noStatsYet', 'noWeekYet', 'noAmbient'];

test('the guard catches a missing language, an empty text, a long text and "Sie"', () => {
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'a', es: 'a' }, 10, 'ok').length, 0);
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'a' }, 10, 'x').length, 2);
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'a', es: ' ' }, 10, 'x').length, 1);
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'a', es: 'too long' }, 4, 'x').length, 1);
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 9, 'x').length, 1);
  for (const word of ['Sie', 'Ihr', 'Ihre', 'Ihren', 'Ihrem', 'Ihrer', 'Ihres']) {
    const text = { en: 'a', fr: 'a', de: `Prüfe ${word} Konto`, es: 'a' };
    assert.equal(checkLocalized(text, 99, 'x').length, 1, word);
  }
  // Lower case is the "du" register: "ihr" (plural) and "sie" (they) are fine.
  assert.equal(checkLocalized({ en: 'a', fr: 'a', de: 'sie und ihr', es: 'a' }, 99, 'x').length, 0);
  // The walk finds nested objects, including one missing a language.
  const found = collect({ a: [{ b: { en: 'x', fr: 'x' } }] });
  assert.deepEqual(
    found.map((f) => f.path),
    ['a[0].b'],
  );
});

test('every multi-language text of the manifest has en, fr, de and es', () => {
  const found = collect(manifest);
  assert.ok(found.length >= 27, `only ${found.length} texts found in the manifest`);
  const problems = found.flatMap(({ path, text }) =>
    checkLocalized(text, manifestBound(path), path),
  );
  assert.deepEqual(problems, []);
});

test('every widget text has en, fr, de and es, short enough for the core', () => {
  const problems = Object.entries(TEXTS).flatMap(([key, text]) =>
    checkLocalized(text, WIDGET_BODIES.includes(key) ? 300 : 24, `TEXTS.${key}`),
  );
  assert.deepEqual(problems, []);
});

test('every connection message and yes/no has en, fr, de and es', () => {
  const problems = [
    ...Object.entries(MESSAGES).flatMap(([key, text]) =>
      checkLocalized(text, 200, `MESSAGES.${key}`),
    ),
    ...checkLocalized(YES, 10, 'YES'),
    ...checkLocalized(NO, 10, 'NO'),
  ];
  assert.deepEqual(problems, []);
});

test('the test_connection result has en, fr, de and es', async () => {
  const createEngine = () => ({
    discover: async () => ({
      gateway: { gatewayId: 'gw', firmware: '1.0' },
      capabilities: { periods: ['HC', 'HP'], hasProduction: true, hasTempHum: false },
    }),
    readRealtime: async () => -1234.4,
  });
  const result = await ACTIONS.test_connection({
    config: { email: 'a@b.c', password: 'x' },
    createEngine,
  });
  assert.deepEqual(checkLocalized(result, 300, 'test_connection'), []);
  assert.match(result.de, /Solarüberschuss: ja · Raumklimasensor: nein/);
  assert.match(result.es, /excedente solar: sí · sensor ambiental: no/);
  const missing = await ACTIONS.test_connection({
    config: { email: '', password: '' },
    createEngine,
  });
  assert.deepEqual(checkLocalized(missing, 200, 'missingCredentials'), []);
});

test('no source file picks a text with a language test or forgets a language', async () => {
  const files = [
    '../index.js',
    ...(await readdir(new URL('../src/', import.meta.url), { recursive: true }))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `../src/${name}`),
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /language\s*===?\s*'(en|fr|de|es)'/, file);
    // Every `{ en: …, fr: … }` literal of the code carries the four keys.
    const counts = LANGUAGES.map((lang) => {
      const matches = source.match(new RegExp(`^\\s*${lang}:|[{,]\\s*${lang}:`, 'gm')) ?? [];
      return matches.length;
    });
    assert.ok(
      counts.every((count) => count === counts[0]),
      `${file}: ${LANGUAGES.map((l, i) => `${l}:${counts[i]}`).join(' ')}`,
    );
  }
});

test('numbers and weekdays follow German and Spanish too', () => {
  assert.equal(formatKwh(11.25, 'de'), '11,3 kWh');
  assert.equal(formatKwh(11.25, 'es'), '11,3 kWh');
  assert.equal(formatKwh(11.25, 'it'), '11.3 kWh');
  assert.equal(weekdayName('2026-10-12', 'de'), 'Montag');
  assert.equal(weekdayName('2026-10-12', 'es'), 'Lunes');
});
