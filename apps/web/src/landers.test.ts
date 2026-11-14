import type { Mission } from '@siteline/engine';
import { describe, expect, it } from 'vitest';
import { FACT_BODIES } from './bodyFacts';
import { landersOn, MISSIONS } from './landers';

const mission = (body: string, status: string) => ({ body, status }) as unknown as Mission;

describe('landersOn', () => {
  it('counts the missions that went to a body apart from the ones still to come', () => {
    const list = [
      mission('Moon', 'landed'),
      mission('Moon', 'crashed'),
      mission('Moon', 'crew'),
      mission('Moon', 'planned'),
      mission('Moon', 'next'),
      mission('Mars', 'onway'),
      mission('Mars', 'active'),
    ];
    expect(landersOn(list, 'Moon')).toEqual({ past: 3, toCome: 2 });
    expect(landersOn(list, 'Mars')).toEqual({ past: 1, toCome: 1 });
  });

  it('gives nothing, not a guess, for a body the list has no missions to', () => {
    expect(landersOn(MISSIONS, 'Venus')).toEqual({ past: 0, toCome: 0 });
    expect(landersOn(MISSIONS, 'Jupiter')).toEqual({ past: 0, toCome: 0 });
  });

  it('accounts for every mission in data/missions.json, on the Moon and Mars', () => {
    const total = FACT_BODIES.reduce((n, body) => {
      const { past, toCome } = landersOn(MISSIONS, body);
      return n + past + toCome;
    }, 0);
    expect(total).toBe(MISSIONS.length);
    expect(landersOn(MISSIONS, 'Moon').past).toBeGreaterThan(0);
    expect(landersOn(MISSIONS, 'Mars').past).toBeGreaterThan(0);
  });
});
