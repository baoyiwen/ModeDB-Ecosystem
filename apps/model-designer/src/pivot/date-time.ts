import dayjs, { type Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);

const DATE_ONLY_PATTERN = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function parseDateTime(value: string): Dayjs | undefined {
  const text = value.trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const parsed = dayjs(text, 'YYYY-MM-DD', true);
    return parsed.isValid() ? parsed : undefined;
  }
  const match = DATE_TIME_PATTERN.exec(text);
  if (!match) return undefined;
  const [, date, hours, minutes, seconds, fraction, zone] = match;
  // Day.js strict parsing uses SSS for milliseconds. Padding also makes the
  // human input forms .1 and .12 deterministic while preserving millisecond
  // precision supported by JavaScript Date.
  const milliseconds = fraction ? fraction.slice(0, 3).padEnd(3, '0') : '000';
  const hasFraction = Boolean(fraction);
  const clock = `${date}T${hours}:${minutes}:${seconds ?? '00'}${hasFraction ? `.${milliseconds}` : ''}`;
  const clockFormat = `YYYY-MM-DDTHH:mm:ss${hasFraction ? '.SSS' : ''}`;
  // Validate the calendar and clock strictly before asking Day.js to apply an
  // offset. Day.js's strict `Z` token rejects some valid negative offsets, so
  // numeric offsets are parsed by its ISO parser only after this validation.
  const validClock = dayjs(clock, clockFormat, true);
  if (!validClock.isValid()) return undefined;
  if (!zone) return validClock;
  if (zone.toUpperCase() === 'Z') return dayjs.utc(clock, clockFormat, true);
  const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!offset || Number(offset[2]) > 23 || Number(offset[3]) > 59) return undefined;
  const parsed = dayjs(`${clock}${zone}`);
  return parsed.isValid() ? parsed : undefined;
}

/** Validate a calendar date without relying on the browser's date rollover. */
export function isValidDateOnly(value: string): boolean {
  return parseDateTime(value) !== undefined && DATE_ONLY_PATTERN.test(value.trim());
}

/** Convert a user-entered date-only value to its canonical date representation. */
export function toStoredDateOnly(value: string): string | undefined {
  return isValidDateOnly(value) ? value.trim() : undefined;
}

/** Convert a stored or user-entered date/time to an ISO instant for transport. */
export function toStoredDateTime(value: string): string | undefined {
  const parsed = parseDateTime(value);
  return parsed?.isValid() ? parsed.toISOString() : undefined;
}

/**
 * Format a date/time for people using the browser's local timezone.
 *
 * The stored value is never changed by this function. Explicit UTC/offset
 * values are converted to local calendar fields, so the transport marker (`Z`)
 * is not exposed in the table. Milliseconds are retained when present.
 */
export function formatDateTimeForDisplay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseDateTime(value);
  if (!parsed) return undefined;
  if (DATE_ONLY_PATTERN.test(value.trim())) return parsed.format('YYYY-MM-DD');
  const local = parsed.local();
  const base = local.format('YYYY-MM-DD HH:mm:ss');
  return local.millisecond() ? `${base}.${local.format('SSS')}` : base;
}
