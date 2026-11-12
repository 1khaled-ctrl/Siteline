import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREDITS, creditsSection, parseCredits, spans } from './credits';

const md = readFileSync(new URL('../../../CREDITS.md', import.meta.url), 'utf8');

describe('parseCredits', () => {
  it('reads every row of the dataset table, with an id, a licence and a source', () => {
    const rows = parseCredits(md);
    const tableRows = md.split(/\r?\n/).filter((l) => /^\|\s*[a-z0-9][a-z0-9-]*\s*\|/.test(l));
    expect(rows.length).toBe(tableRows.length);
    for (const r of rows) {
      expect(r.id).toMatch(/^[a-z0-9-]+$/);
      expect(r.what.length).toBeGreaterThan(0);
      expect(r.licence.length).toBeGreaterThan(0);
      expect(r.source.length).toBeGreaterThan(0);
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('is what the app ships, and names the datasets the site check cites', () => {
    expect(CREDITS).toEqual(parseCredits(md));
    const ids = CREDITS.map((r) => r.id);
    for (const id of ['spice-de440s', 'lola-ldem-75s-240m', 'landfall-polar-maps', 'body-facts', 'spice-gm-de440']) {
      expect(ids).toContain(id);
    }
  });

  it('follows the columns by name, not by place', () => {
    const swapped =
      '| Source | Id | Licence | What |\n| - | - | - | - |\n| [x](https://x.org) | a-b | Public | A thing |\n';
    expect(parseCredits(swapped)).toEqual([
      { id: 'a-b', what: 'A thing', licence: 'Public', source: '[x](https://x.org)' },
    ]);
  });

  it('returns nothing when there is no table', () => {
    expect(parseCredits('# Credits\n\nNo table here.')).toEqual([]);
  });
});

describe('creditsSection', () => {
  it('joins the paragraphs under a heading and stops at the next one', () => {
    const text = '## A\n\nOne\ntwo.\n\n## B\n\nThree.';
    expect(creditsSection(text, 'A')).toBe('One two.');
    expect(creditsSection(text, 'B')).toBe('Three.');
    expect(creditsSection(text, 'C')).toBe('');
  });

  it('finds the fonts and libraries notes in the real file', () => {
    expect(creditsSection(md, 'Fonts')).toMatch(/SIL Open Font License/);
    expect(creditsSection(md, 'Libraries')).toMatch(/MIT/);
  });
});

describe('spans', () => {
  it('splits code, links and bare addresses out of plain text', () => {
    expect(spans('See `de440s.bsp` at [NAIF](https://naif.jpl.nasa.gov/) or https://example.org/a.txt.')).toEqual([
      { text: 'See ' },
      { code: 'de440s.bsp' },
      { text: ' at ' },
      { label: 'NAIF', url: 'https://naif.jpl.nasa.gov/' },
      { text: ' or ' },
      { label: 'https://example.org/a.txt', url: 'https://example.org/a.txt' },
      { text: '.' },
    ]);
  });

  it('leaves text without markup alone', () => {
    expect(spans('Public')).toEqual([{ text: 'Public' }]);
  });
});
