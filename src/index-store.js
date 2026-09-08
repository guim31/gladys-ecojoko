// -----------------------------------------------------------------------------
// Synthesized cumulative energy index.
//
// Why: Gladys builds its energy dashboard (30-minute consumption, cost from the
// user's contract) from a CUMULATIVE meter index (`energy-sensor`/`index`, in
// kWh) — never from a "today so far" counter. ecojoko exposes no such index,
// only per-day totals. This store turns those daily totals into a monotonic
// index that starts at 0 when the integration is installed:
//
//   index(today) = sum of the final kWh of every completed day since install
//                  + kWh of today so far
//
// The completed days are folded once, when the calendar moves on, from the
// week statistics (which still hold yesterday's final value the next morning).
// The fold is persisted in /data (the only writable path of the sandbox) so a
// restart never rewinds the index. A downward revision of a value by ecojoko
// is clamped: the index never decreases, or the derived consumption would go
// negative.
// -----------------------------------------------------------------------------

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addDays, compareDates, isIsoDate, weekDates } from './dates.js';

const logger = createLogger({ name: 'index-store' });

const STATE_VERSION = 1;

// Beyond this many missing days (integration stopped for months), we give up
// filling the gap day by day and restart the fold from yesterday.
const MAX_BACKFILL_DAYS = 90;

function emptyState() {
  return {
    version: STATE_VERSION,
    completed_through: null, // 'YYYY-MM-DD' of the last day folded in `base_kwh`
    base_kwh: 0, // sum of the completed days
    last_index_kwh: 0, // last value published (monotonic clamp)
  };
}

function isValidState(state) {
  return (
    state &&
    state.version === STATE_VERSION &&
    (state.completed_through === null || isIsoDate(state.completed_through)) &&
    Number.isFinite(state.base_kwh) &&
    Number.isFinite(state.last_index_kwh)
  );
}

/**
 * Map a 7-entry week array (Monday..Sunday) to `{ 'YYYY-MM-DD': kwh }`.
 * `parseKwh(entry)` extracts the kWh of one raw entry (null when absent).
 */
export function weekToDailyKwh(weekEntries, anyDateOfThatWeek, parseKwh) {
  const dates = weekDates(anyDateOfThatWeek);
  const out = {};
  if (!Array.isArray(weekEntries) || weekEntries.length !== 7) {
    return out;
  }
  dates.forEach((date, i) => {
    const kwh = parseKwh(weekEntries[i]);
    if (kwh !== null && kwh !== undefined && Number.isFinite(kwh)) {
      out[date] = kwh;
    }
  });
  return out;
}

/**
 * Create the store for one meter. `dataDir` is the writable folder; the file
 * is `<dataDir>/index-<meterKey>.json`.
 */
export function createIndexStore({ dataDir, meterKey }) {
  const file = path.join(dataDir, `index-${meterKey}.json`);
  let state = null;

  async function load() {
    if (state) {
      return state;
    }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (isValidState(parsed)) {
        state = parsed;
        logger.info(
          `Loaded index state: ${state.base_kwh} kWh folded through ${state.completed_through}`,
        );
        return state;
      }
      logger.warn(`Ignoring invalid index state in ${file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${file}: ${err.message}`);
      }
    }
    state = emptyState();
    return state;
  }

  async function save() {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, file);
  }

  /**
   * Fold the completed days up to `yesterday` into the base, then compute the
   * index for `today`.
   *
   * @param {object} params
   * @param {string} params.today - 'YYYY-MM-DD' (Paris)
   * @param {Record<string, number>} params.dailyKwh - known daily totals, at least
   *   this week's (may include last week's when the caller fetched it)
   * @param {(isoDate: string) => Promise<Record<string, number>>} [params.fetchWeek]
   *   - fetch the daily totals of the week containing a date (backfill)
   * @returns {Promise<{ index: number, todayKwh: number|null }>}
   */
  async function update({ today, dailyKwh, fetchWeek }) {
    await load();
    const known = { ...dailyKwh };
    const yesterday = addDays(today, -1);

    if (state.completed_through === null) {
      // First run: the index starts today at "today so far".
      state.completed_through = yesterday;
      logger.info(`Index initialized: counting from ${today}`);
    } else if (compareDates(state.completed_through, yesterday) < 0) {
      const gap = daysBetween(state.completed_through, yesterday);
      if (gap > MAX_BACKFILL_DAYS) {
        logger.warn(
          `Index state is ${gap} days old, too many to backfill: restarting the fold from ${yesterday}`,
        );
        state.completed_through = yesterday;
      }
    }

    let changed = false;
    while (compareDates(state.completed_through, yesterday) < 0) {
      const day = addDays(state.completed_through, 1);
      if (known[day] === undefined && typeof fetchWeek === 'function') {
        try {
          Object.assign(known, await fetchWeek(day));
        } catch (err) {
          logger.warn(`Cannot backfill the week of ${day}: ${err.message}`);
        }
      }
      const kwh = known[day];
      if (kwh === undefined) {
        logger.warn(`No consumption known for ${day}, counting it as 0 kWh`);
      } else {
        state.base_kwh += kwh;
      }
      state.completed_through = day;
      changed = true;
    }

    const todayKwh = known[today] === undefined ? null : known[today];
    let index = state.base_kwh + (todayKwh ?? 0);
    if (index < state.last_index_kwh) {
      logger.warn(
        `Index would decrease (${index} < ${state.last_index_kwh} kWh), keeping the last value`,
      );
      index = state.last_index_kwh;
    }
    index = round3(index);
    if (index !== state.last_index_kwh) {
      state.last_index_kwh = index;
      changed = true;
    }
    if (changed) {
      await save();
    }
    return { index, todayKwh };
  }

  return {
    load,
    update,
    /** For tests and the connection-test action. */
    getState: () => (state ? { ...state } : null),
    file,
  };
}

function daysBetween(fromIso, toIso) {
  let count = 0;
  let cursor = fromIso;
  while (compareDates(cursor, toIso) < 0 && count <= MAX_BACKFILL_DAYS + 1) {
    cursor = addDays(cursor, 1);
    count += 1;
  }
  return count;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
