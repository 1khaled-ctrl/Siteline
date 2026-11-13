import { describe, expect, it } from 'vitest';
import { formatUtcShort } from '../format';
import { reasonOf } from './ViewStatus';

describe('reasonOf', () => {
  it("gives an error's message, and anything else as text", () => {
    expect(reasonOf(new Error('/landfall/img/moon.jpg did not load'))).toBe('/landfall/img/moon.jpg did not load');
    expect(reasonOf('HTTP 503')).toBe('HTTP 503');
  });

  it('reads the first failure out of a "they all failed" error, not its generic message', () => {
    const all = new AggregateError([new Error('moon_color.jpg did not load'), new Error('moon.jpg did not load')]);
    expect(reasonOf(all)).toBe('moon_color.jpg did not load');
  });
});

describe('formatUtcShort', () => {
  it('writes day, month and 24-hour UTC time without the year', () => {
    expect(formatUtcShort('2028-04-09T14:05:00Z')).toBe('9 Apr, 14:05');
    expect(formatUtcShort('2028-12-31T23:59:00Z')).toBe('31 Dec, 23:59');
  });
});
