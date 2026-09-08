// -----------------------------------------------------------------------------
// Calendar helpers, pinned to Europe/Paris.
//
// ecojoko is a French product and its statistics endpoints are keyed by the
// civil date in France (`/powerstat/w/2026-09-08`), whatever the timezone of
// the container. Everything here works on 'YYYY-MM-DD' strings so the rest of
// the code never manipulates Date objects across a DST change.
// -----------------------------------------------------------------------------

export const TIMEZONE = 'Europe/Paris';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The civil date in Paris for a given instant (default: now), as 'YYYY-MM-DD'.
 */
export function parisDate(instant = new Date()) {
  return dayFormatter.format(instant);
}

/**
 * Validate a 'YYYY-MM-DD' string strictly: `2026-02-30` must be rejected, not
 * silently rolled over to March 2nd.
 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return toIsoDate(fromIsoDate(value)) === value;
}

/**
 * Parse 'YYYY-MM-DD' into a UTC-midnight Date (day arithmetic only).
 */
function fromIsoDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Add (or subtract) whole days to a 'YYYY-MM-DD' string.
 */
export function addDays(isoDate, days) {
  const date = fromIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/**
 * Compare two 'YYYY-MM-DD' strings (ISO dates sort lexicographically).
 */
export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Index of the day in an ISO week: Monday = 0 ... Sunday = 6. This is the
 * position of the day in the 7-entry array returned by `/powerstat/w/<date>`.
 */
export function weekdayIndex(isoDate) {
  const jsDay = fromIsoDate(isoDate).getUTCDay(); // Sunday = 0
  return (jsDay + 6) % 7;
}

/**
 * The Monday of the ISO week containing `isoDate`.
 */
export function mondayOf(isoDate) {
  return addDays(isoDate, -weekdayIndex(isoDate));
}

/**
 * The seven dates (Monday..Sunday) of the ISO week containing `isoDate`.
 */
export function weekDates(isoDate) {
  const monday = mondayOf(isoDate);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
