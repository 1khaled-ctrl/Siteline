const LOCALE = 'en-GB';
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const dateOnly = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });

export const formatDate = (utcMs: number): string => dateOnly.format(new Date(utcMs));

export const formatUtc = (iso: string): string => `${dateTime.format(new Date(iso))} UTC`;

export const formatNumber = (value: number, maximumFractionDigits = 1): string =>
  new Intl.NumberFormat(LOCALE, { maximumFractionDigits }).format(value);
