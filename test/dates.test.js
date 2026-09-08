import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  compareDates,
  isIsoDate,
  mondayOf,
  parisDate,
  weekDates,
  weekdayIndex,
} from '../src/dates.js';

test('parisDate follows the civil date in France, not UTC', () => {
  // 2026-07-01T22:30Z is already July 2nd in Paris (UTC+2).
  assert.equal(parisDate(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
  // 2026-01-01T23:30Z is January 2nd in Paris (UTC+1).
  assert.equal(parisDate(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
  assert.equal(parisDate(new Date('2026-01-01T22:30:00Z')), '2026-01-01');
});

test('isIsoDate rejects overflowing dates instead of rolling them over', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-9-8'), false);
  assert.equal(isIsoDate(null), false);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
});

test('weekdayIndex is Monday-based like Python weekday()', () => {
  assert.equal(weekdayIndex('2026-09-07'), 0); // Monday
  assert.equal(weekdayIndex('2026-09-08'), 1); // Tuesday
  assert.equal(weekdayIndex('2026-09-13'), 6); // Sunday
});

test('weekDates lists Monday..Sunday of the ISO week', () => {
  assert.equal(mondayOf('2026-09-13'), '2026-09-07');
  assert.deepEqual(weekDates('2026-09-10'), [
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-13',
  ]);
});

test('compareDates orders ISO strings', () => {
  assert.equal(compareDates('2026-01-01', '2026-01-02'), -1);
  assert.equal(compareDates('2026-01-02', '2026-01-02'), 0);
  assert.equal(compareDates('2026-02-01', '2026-01-31'), 1);
});
