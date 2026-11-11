import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from './en.json';

const namesPath = fileURLToPath(new URL('../../../../pipeline/out/names/mars_names.json', import.meta.url));

describe.skipIf(!existsSync(namesPath))('Mars feature types', () => {
  it('each have the IAU definition in the English strings', () => {
    const { features } = JSON.parse(readFileSync(namesPath, 'utf8')) as {
      features: [string, number, number, number, string][];
    };
    const kinds = en.mars.kinds as Record<string, string>;
    const types = new Set(features.map((f) => f[4]));
    expect(types.size).toBeGreaterThan(20);
    for (const type of types) expect(kinds[type.replace(/\s/g, '')], `no definition for ${type}`).toBeTruthy();
  });
});
