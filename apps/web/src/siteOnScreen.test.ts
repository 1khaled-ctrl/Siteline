import { describe, expect, it } from 'vitest';
import { siteOnScreen } from './landingAgent';

describe('siteOnScreen', () => {
  it('counts a selected site only on the Moon, not from the solar system, Earth or Mars', () => {
    expect(siteOnScreen('pole')).toBe(true);
    expect(siteOnScreen('site')).toBe(true);
    expect(siteOnScreen('globe')).toBe(true);
    expect(siteOnScreen('solar')).toBe(false);
    expect(siteOnScreen('earth')).toBe(false);
    expect(siteOnScreen('mars')).toBe(false);
  });
});
