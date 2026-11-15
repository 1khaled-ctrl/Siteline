import type { ModelsFile, NasaModel } from '@siteline/data-client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../i18n';
import { cardModels, MANIFEST } from '../nasaModels';
import { MoonModelsSection } from './NasaModels';

// The turntable needs WebGL; the rows only open it on a click, which a static render never makes.
vi.mock('./ModelBox', () => ({ ModelBox: () => null }));

const models = cardModels(MANIFEST as ModelsFile);
const words = (list: readonly NasaModel[]) =>
  renderToStaticMarkup(createElement(MoonModelsSection, { models: list, title: 'Spacecraft and concepts' }))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe("the Moon card's NASA 3D models", () => {
  it('names each model and gives each its credit line, linked to its NASA page', () => {
    const html = renderToStaticMarkup(createElement(MoonModelsSection, { models, title: 'x' }));
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(words([m])).toContain(m.name);
      expect(words([m])).toContain(`Credit: ${m.credit}`);
      expect(html).toContain(`href="${m.sourceUrl}"`);
    }
    expect(html).not.toMatch(/nasaModels\.[a-zA-Z]+/);
  });

  it('says "flew" only for models whose status is flew, with the NASA page that says so', () => {
    for (const m of models) {
      const w = words([m]);
      if (m.status === 'flew') {
        expect(w).toContain(' flew ');
        expect(w).toContain(m.statusNote);
        expect(renderToStaticMarkup(createElement(MoonModelsSection, { models: [m], title: 'x' }))).toContain(
          `href="${m.statusSource}"`,
        );
      } else {
        expect(w).not.toMatch(/\bflew\b/);
        expect(w).toContain('being checked');
      }
    }
  });

  it('shows the note of a model being checked, such as the IBEX question for LRO (B)', () => {
    const lroB = models.find((m) => m.id === 'lro_b');
    expect(lroB?.note).toBeTruthy();
    expect(words(lroB ? [lroB] : [])).toContain('IBEX');
  });

  it('never says "orbiter" unless it is part of the name NASA gives the model', () => {
    for (const m of models) {
      // LRO (B)'s note names the title "Lunar Reconnaissance Orbiter": a name, not a claim about the model.
      const w = words([m]).replaceAll(m.name, '').replaceAll('Lunar Reconnaissance Orbiter', '');
      expect(w.toLowerCase()).not.toContain('orbiter');
    }
  });

  it('says what the list is, and offers each model in 3D with its size', () => {
    const w = words(models);
    expect(w).toContain("None of them is or was on the Moon's surface unless its row says so.");
    expect(w.match(/View in 3D \(\d+(\.\d)? MB\)/g)).toHaveLength(models.length);
  });
});
