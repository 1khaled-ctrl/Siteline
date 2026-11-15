import { describe, expect, it } from 'vitest';
import { hintAllowed } from './LunaHint';

describe('hintAllowed', () => {
  const day = 24 * 3_600_000;
  it('shows to anyone who has never opened Luna', () => {
    expect(hintAllowed({}, 1_000)).toBe(true);
    expect(hintAllowed({ lastShownMs: 900 }, 1_000)).toBe(true);
  });
  it('after Luna has been opened, shows at most every three days', () => {
    expect(hintAllowed({ opened: true, lastShownMs: 0 }, 2 * day)).toBe(false);
    expect(hintAllowed({ opened: true, lastShownMs: 0 }, 3 * day)).toBe(true);
  });
});
