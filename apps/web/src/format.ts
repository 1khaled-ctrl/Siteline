const LOCALE = 'en-GB';
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export const formatUtc = (iso: string): string => `${dateTime.format(new Date(iso))} UTC`;

export const formatNumber = (value: number, maximumFractionDigits = 1): string =>
  new Intl.NumberFormat(LOCALE, { maximumFractionDigits }).format(value);
