import { describe, expect, it } from 'vitest';
import { allSettled, firstPending } from './boot';

describe('the opening waits for what the first view loads', () => {
  it('holds while anything counted is still loading', () => {
    expect(allSettled({ fonts: 'done', positions: 'pending' })).toBe(false);
    expect(allSettled({ fonts: 'done', positions: 'done' })).toBe(true);
  });

  it('counts a failure as settled, so the view underneath can say what went wrong', () => {
    expect(allSettled({ view: 'failed', fonts: 'done' })).toBe(true);
  });

  it('names the view first, then the data, then the small things', () => {
    expect(firstPending({ fonts: 'pending', orbits: 'pending', view: 'pending' })).toBe('view');
    expect(firstPending({ fonts: 'pending', orbits: 'pending', view: 'done' })).toBe('orbits');
    expect(firstPending({ fonts: 'done' })).toBeUndefined();
  });
});
