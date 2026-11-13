const LOCALE = 'en-GB';
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const dateOnly = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });

export const formatDate = (utcMs: number): string => dateOnly.format(new Date(utcMs));

export const formatUtc = (iso: string): string => `${dateTime.format(new Date(iso))} UTC`;

const shortDateTime = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
/** Day, month and time without the year, for a narrow table cell. */
export const formatUtcShort = (iso: string): string => shortDateTime.format(new Date(iso));

// Building an Intl.NumberFormat costs far more than using one, and the time-lapse formats numbers on every frame.
const numberFormats = new Map<number, Intl.NumberFormat>();
export const formatNumber = (value: number, maximumFractionDigits = 1): string => {
  let format = numberFormats.get(maximumFractionDigits);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits });
    numberFormats.set(maximumFractionDigits, format);
  }
  return format.format(value);
};
