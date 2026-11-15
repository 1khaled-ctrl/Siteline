import { describe, expect, it } from 'vitest';
import missionsJson from '../../../data/missions.json';
import modelsJson from '../../../data/models.json';
import { MODEL_STATUSES, modelFileUrl, parseModels, showableModels } from './models';

const MISSIONS = new Set((missionsJson as { missions: { id: string }[] }).missions.map((m) => m.id));

/** The real file with one model changed: `change` edits a copy of the first model. */
function withFirst(change: (m: Record<string, unknown>) => void): unknown {
  const file = structuredClone(modelsJson) as { models: Record<string, unknown>[] };
  change(file.models[0]);
  return file;
}

describe('data/models.json', () => {
  const file = parseModels(modelsJson, MISSIONS);

  it('reads, and every model names its NASA page and its credit line', () => {
    expect(file.models.length).toBeGreaterThan(0);
    for (const m of file.models) {
      expect(m.sourceUrl).toMatch(/^https:\/\/science\.nasa\.gov\/3d-resources\//);
      expect(m.credit).toMatch(/^NASA\//);
      expect(MODEL_STATUSES).toContain(m.status);
      if (m.status !== 'being checked') expect(m.statusSource).toMatch(/^https:\/\/(science|www)\.nasa\.gov\//);
    }
  });

  it('keeps every file in the bucket under the 5 MiB limit, at its versioned key', () => {
    expect(file.limitBytes).toBe(5 * 1024 * 1024);
    for (const m of file.models) {
      if (m.bytes !== null) expect(m.bytes).toBeLessThanOrEqual(file.limitBytes);
      expect(modelFileUrl(file, m)).toBe(`${file.baseUrl}/models/v1/${m.id}.json`);
    }
  });

  it('shows only built models whose logo check is recorded', () => {
    for (const m of showableModels(file)) expect(m.logoChecked && m.bytes !== null).toBe(true);
  });

  it('has no model whose texture was found to carry a logo', () => {
    expect(file.models.map((m) => m.id)).not.toContain('hdu_part_1');
    expect(file.models.map((m) => m.id)).not.toContain('insight_arm_deployed');
  });

  it('labels the models no NASA page places as "being checked"', () => {
    const status = Object.fromEntries(file.models.map((m) => [m.id, m.status]));
    expect(status.llcd).toBe('being checked');
    expect(status.hdu_part_2).toBe('being checked');
    expect(status.lro_b).toBe('being checked');
  });
});

describe('parseModels refuses', () => {
  it('a model with no credit line', () => {
    expect(() =>
      parseModels(
        withFirst((m) => delete m.credit),
        MISSIONS,
      ),
    ).toThrow(/credit is missing/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.credit = ' ')),
        MISSIONS,
      ),
    ).toThrow(/credit is missing/);
  });

  it('a model with no NASA page, or a page that is not NASA’s', () => {
    expect(() =>
      parseModels(
        withFirst((m) => delete m.sourceUrl),
        MISSIONS,
      ),
    ).toThrow(/sourceUrl is missing/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.sourceUrl = 'https://sketchfab.com/x')),
        MISSIONS,
      ),
    ).toThrow(/sourceUrl is not a NASA page/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.sourceUrl = 'https://nasa.gov.example.com/x')),
        MISSIONS,
      ),
    ).toThrow(/not a NASA page/);
  });

  it('a status it does not know, and a status other than "being checked" with no page saying so', () => {
    expect(() =>
      parseModels(
        withFirst((m) => (m.status = 'landed')),
        MISSIONS,
      ),
    ).toThrow(/is not one of/);
    const flew = withFirst((m) => {
      m.status = 'flew';
      m.statusSource = null;
      m.statusNote = null;
    });
    expect(() => parseModels(flew, MISSIONS)).toThrow(/names no NASA page/);
  });

  it('a mission that is not in data/missions.json', () => {
    expect(() =>
      parseModels(
        withFirst((m) => (m.mission = 'orion')),
        MISSIONS,
      ),
    ).toThrow(/"orion" is not in/);
  });

  it('a file over the limit, a size without a checksum, and a key that is not the id', () => {
    const big = withFirst((m) => {
      m.bytes = 5 * 1024 * 1024 + 1;
      m.sha256 = 'a'.repeat(64);
    });
    expect(() => parseModels(big, MISSIONS)).toThrow(/over the 5242880-byte limit/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.bytes = 10)),
        MISSIONS,
      ),
    ).toThrow(/bytes and sha256 come together/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.key = 'models/v1/other.json')),
        MISSIONS,
      ),
    ).toThrow(/key is not/);
  });

  it('a repeated id and a field it does not know', () => {
    const twice = structuredClone(modelsJson) as { models: unknown[] };
    twice.models.push(twice.models[0]);
    expect(() => parseModels(twice, MISSIONS)).toThrow(/listed twice/);
    expect(() =>
      parseModels(
        withFirst((m) => (m.credits = 'NASA')),
        MISSIONS,
      ),
    ).toThrow(/credits is not a field/);
  });
});
