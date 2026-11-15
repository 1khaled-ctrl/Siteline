import type { ModelsFile, NasaModel } from '@siteline/data-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import modelsJson from '../../../data/models.json';
import en from './i18n/en.json';
import {
  cardModels,
  fileThere,
  forgetFileChecks,
  MANIFEST,
  missionModel,
  modelFileUrl,
  readManifest,
  sourcedStatus,
  statusKey,
  TERRAIN_BUCKET_URL,
} from './nasaModels';

const file = MANIFEST as ModelsFile;
/** The manifest with its models changed, read as the app reads it. */
const withModels = (change: (models: Record<string, unknown>[]) => void): ModelsFile | undefined => {
  const copy = structuredClone(modelsJson) as unknown as { models: Record<string, unknown>[] };
  change(copy.models);
  return readManifest({ '../../../data/models.json': { default: copy } });
};

describe('the NASA 3D models manifest, as the app reads it', () => {
  it('is in the build, and the bucket address the app uses is the one the manifest names', () => {
    expect(file).toBeDefined();
    expect(TERRAIN_BUCKET_URL).toBe(file.baseUrl);
  });

  it('loads each model from <bucket>/models/v1/<id>.json', () => {
    for (const m of file.models) expect(modelFileUrl(m)).toBe(`${file.baseUrl}/models/v1/${m.id}.json`);
    expect(modelFileUrl(file.models[0], 'https://example.org')).toBe(`https://example.org/${file.models[0].key}`);
  });

  it('lists on the Moon card the built, logo-checked models that belong to no lander', () => {
    const listed = cardModels(file);
    expect(listed.length).toBeGreaterThan(0);
    for (const m of listed) expect(m.logoChecked && m.bytes !== null && m.mission === null).toBe(true);
    const unchecked = withModels((ms) => {
      ms[0].logoChecked = false;
    });
    expect(cardModels(unchecked).map((m) => m.id)).not.toContain(file.models[0].id);
  });

  it("gives a lander's card the model the manifest names for its mission, and none otherwise", () => {
    expect(missionModel('insight', file)).toBeUndefined();
    const tied = withModels((ms) => {
      ms[0].mission = 'insight';
    });
    expect(missionModel('insight', tied)?.id).toBe(file.models[0].id);
    expect(cardModels(tied).map((m) => m.id)).not.toContain(file.models[0].id);
  });

  it('gives no models for a missing manifest or one that fails to parse, with a warning rather than an error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readManifest({})).toBeUndefined();
    const broken = withModels((ms) => {
      delete ms[0].credit;
    });
    expect(broken).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/credit is missing/));
    warn.mockRestore();
  });

  it('shows each status as its own words, and only a sourced status with its NASA page', () => {
    for (const s of ['flew', 'prototype', 'concept', 'being checked'] as const) {
      const key = statusKey(s).replace('nasaModels.status.', '') as keyof typeof en.nasaModels.status;
      expect(en.nasaModels.status[key]).toBe(s);
    }
    const flew = { status: 'flew', statusSource: 'https://science.nasa.gov/x', statusNote: 'x' } as NasaModel;
    const concept = { ...flew, status: 'concept' } as NasaModel;
    const checking = { ...flew, status: 'being checked', statusSource: null } as NasaModel;
    expect([sourcedStatus(flew), sourcedStatus(concept), sourcedStatus(checking)]).toEqual([true, true, false]);
  });
});

describe('checking that a model file is there', () => {
  beforeEach(forgetFileChecks);

  it('keeps only answers of 200, and asks once per address', async () => {
    const answers: Record<string, () => Promise<Response>> = {
      'https://b/ok.json': async () => new Response(null, { status: 200 }),
      'https://b/missing.json': async () => new Response(null, { status: 404 }),
      'https://b/offline.json': async () => {
        throw new TypeError('Failed to fetch');
      },
    };
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return answers[String(url)]();
    }) as unknown as typeof fetch;
    expect(await fileThere('https://b/ok.json', fetcher)).toBe(true);
    expect(await fileThere('https://b/missing.json', fetcher)).toBe(false);
    expect(await fileThere('https://b/offline.json', fetcher)).toBe(false);
    expect(await fileThere('https://b/ok.json', fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
