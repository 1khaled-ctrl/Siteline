import { KM_PER_AU, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../i18n';
import { FACT_BODIES, type FactBody } from '../bodyFacts';
import { landersOn, MISSIONS } from '../landers';
import { BodyFacts } from './BodyFacts';

describe('the facts card, as the panel first shows it', () => {
  it('starts folded: only its heading and the arrow that opens it', () => {
    const html = renderToStaticMarkup(createElement(BodyFacts, { body: 'Moon' }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="body-facts-body"');
    // A planet's card, opened by a click (it has a close button), starts open.
    expect(renderToStaticMarkup(createElement(BodyFacts, { body: 'Moon', onClose: () => undefined }))).toContain(
      'id="body-facts-body"',
    );
  });
});

/** A made-up sky: each planet on one line from the Sun at a round distance, the Earth at 1 AU. */
const AU: Record<SolarBodyKey, number> = {
  mercury: 0.4,
  venus: 0.7,
  earth: 1,
  moon: 0,
  mars: 1.5,
  jupiter: 5.2,
  saturn: 9.5,
  uranus: 19.2,
  neptune: 30.1,
};
const positions = Object.fromEntries(
  Object.entries(AU).map(([k, au]) => [k, (k === 'moon' ? [384_400, 0, 0] : [au * KM_PER_AU, 0, 0]) as Vec3]),
) as Record<SolarBodyKey, Vec3>;

// The planets table comes from the physics worker in the app; here it is the sky above. The panel's class names do
// not matter to what the card says.
vi.mock('../physics', () => ({ usePlanetsAtHour: () => positions }));
vi.mock('./Controls', () => ({ panel: '' }));
// The app's store reads the page's address; the card only asks it to open the sources dialog.
vi.mock('../store', () => ({ useApp: { getState: () => ({ setSources: () => undefined }) } }));

// Opened from a click (it has a close button), the card starts open, as these tests need to read it.
const card = (body: FactBody) => renderToStaticMarkup(createElement(BodyFacts, { body, onClose: () => undefined }));
/** The card's words, without the markup. */
const words = (body: FactBody) =>
  card(body)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('the facts card', () => {
  it.each(FACT_BODIES)('renders for %s with every string found and no reading left pending', (body) => {
    const html = card(body);
    expect(html).toContain(`data-body="${body}"`);
    // A missing i18n key shows as its own path, such as facts.temp.Saturn.
    expect(html).not.toMatch(/facts\.[a-zA-Z]+/);
    expect(words(body)).not.toMatch(/ – /);
  });

  it('shows Jupiter as NASA does: 59.5 km/s to leave, no surface, the temperature at 1 bar, no landings', () => {
    const w = words('Jupiter');
    expect(w).toContain('59.5 km/s');
    expect(w).toContain('No solid surface to land on');
    expect(w).toContain('−108 °C at the 1 bar level');
    expect(w).toContain('Gravity at the 1 bar level');
    expect(w).toContain('No landings in our mission list');
    expect(w).not.toContain('retrograde');
  });

  it('says Venus and Uranus spin backwards, and gives Mercury its 4.25 km/s', () => {
    expect(words('Venus')).toContain('Spins backwards (retrograde)');
    expect(words('Venus')).toContain('92,000 mbar');
    expect(words('Uranus')).toContain('Spins backwards (retrograde)');
    expect(words('Mercury')).toContain('4.25 km/s');
  });

  it("sets the distance, the delay and the sunlight from the planets table: Jupiter 4.2 AU away, at 3.7% of Earth's sunlight", () => {
    const w = words('Jupiter');
    // 5.2 AU from the Sun and 4.2 AU from the Earth on this made-up sky.
    expect(w).toContain(`${(Math.round((4.2 * KM_PER_AU) / 1e5) / 10).toLocaleString('en')} million km`);
    expect(w).toContain(`${Math.round(1361 / 5.2 ** 2)} W/m², 3.7% of Earth's`);
  });

  it('counts landers only from the mission list, and leaves the row off the Earth', () => {
    const moon = landersOn(MISSIONS, 'Moon');
    expect(words('Moon')).toContain(`${moon.past} that have gone, ${moon.toCome} still to come`);
    expect(words('Earth')).not.toContain('Landers');
    expect(words('Earth')).not.toContain('Distance from Earth');
  });

  it('tells the Moon card why its low tilt matters to SiteLine', () => {
    expect(words('Moon')).toContain('6.68°');
    expect(words('Moon')).toContain('SiteLine checks for');
    expect(words('Mars')).not.toContain('SiteLine checks for');
  });
});
