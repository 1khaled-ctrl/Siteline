import type { StayResult } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import { aliasesOf, parseIntent, summarize } from './copilot';
import { MISSIONS } from './landers';
import type { StayResponse } from './physics.worker';

const names = MISSIONS.map((m) => ({ id: m.id, name: m.name }));
const ask = (text: string) => parseIntent(text, names);

describe('parseIntent', () => {
  it('flies to a body or view when asked to move, or when the message is just its name', () => {
    expect(ask('Fly to Mars')).toEqual({ tool: 'fly_to', input: { target: 'mars' } });
    expect(ask('take me to the south pole')).toEqual({ tool: 'fly_to', input: { target: 'pole' } });
    expect(ask('show me the solar system')).toEqual({ tool: 'fly_to', input: { target: 'solar' } });
    expect(ask('moon')).toEqual({ tool: 'fly_to', input: { target: 'moon' } });
  });

  it('opens a mission named in the message, even beside a body name', () => {
    const apollo = MISSIONS.find((m) => /apollo 11/i.test(m.name));
    expect(apollo).toBeDefined();
    expect(ask('Show me Apollo 11 on the Moon')).toEqual({ tool: 'show_mission', input: { id: apollo?.id } });
    const curiosity = MISSIONS.find((m) => /curiosity/i.test(m.name));
    expect(ask('where is curiosity?')).toEqual({ tool: 'show_mission', input: { id: curiosity?.id } });
  });

  it('answers small talk as small talk, typos included, and never as a site question', () => {
    const kind = (text: string) => {
      const i = ask(text);
      return i.tool === 'chat' ? i.input.kind : i.tool;
    };
    expect(kind('hello')).toBe('greet');
    expect(kind('HELOO!!')).toBe('greet');
    expect(kind('hey luna')).toBe('greet');
    expect(kind('good morning')).toBe('greet');
    expect(kind('how are you?')).toBe('howAreYou');
    expect(kind('thanks, great job')).toBe('thanks');
    expect(kind('who are you?')).toBe('about');
    expect(kind('what can you do')).toBe('about');
    expect(kind('bye')).toBe('bye');
    expect(kind('asdf qwerty')).toBe('unknown');
    // An introduction, however it is asked, and at any length.
    expect(kind('can you introduce the website?')).toBe('intro');
    expect(kind('Luna, could you please introduce the website to everyone here today')).toBe('intro');
    expect(kind('give us a tour')).toBe('intro');
    expect(kind('what is this website?')).toBe('intro');
    expect(kind('what am I looking at')).toBe('intro');
    expect(kind('explain the app')).toBe('intro');
  });

  it('reads a planet as a visit, and a facts question about any body as space facts', () => {
    expect(ask('show me Saturn')).toEqual({ tool: 'space', input: { body: 'saturn', show: true, facts: true } });
    expect(ask('How far is Jupiter?')).toEqual({ tool: 'space', input: { body: 'jupiter', show: true, facts: true } });
    expect(ask('how far away is Mars')).toEqual({ tool: 'space', input: { body: 'mars', show: false, facts: true } });
    expect(ask('how long does it take to get to the moon')).toMatchObject({ tool: 'space', input: { body: 'moon' } });
    // Still flights and site questions, as before.
    expect(ask('Fly to Mars')).toEqual({ tool: 'fly_to', input: { target: 'mars' } });
    expect(ask('When does the Sun set?')).toMatchObject({ tool: 'analyze_site', input: { aspect: 'events' } });
    expect(ask('Is Earth in view for radio?')).toMatchObject({ tool: 'analyze_site', input: { aspect: 'earth' } });
  });

  it('reads a request to find a landing site as the search, not a check of the selected site', () => {
    expect(ask('Find me a landing site that passes')).toEqual({ tool: 'find_landing_sites' });
    expect(ask('Where should I land a rover?')).toEqual({ tool: 'find_landing_sites' });
    expect(ask('which spot is best?')).toEqual({ tool: 'find_landing_sites' });
    expect(ask('Where should the IM-2 hopper land on 1 March 2028?')).toEqual({ tool: 'find_landing_sites' });
    expect(ask('Does this site pass?')).toMatchObject({ tool: 'analyze_site' });
  });

  it('reads a question about the site as a site check, with the right aspect', () => {
    const aspect = (text: string) => {
      const i = ask(text);
      return i.tool === 'analyze_site' ? i.input.aspect : i.tool;
    };
    expect(aspect('Does this site pass?')).toBe('verdict');
    expect(aspect('Why does it fail?')).toBe('why');
    expect(aspect('When does the Sun set?')).toBe('events');
    expect(aspect('Is Earth in view for radio?')).toBe('earth');
    expect(aspect('How much sunlight over 19 years?')).toBe('longTerm');
    expect(aspect('is the slope too steep')).toBe('slope');
    expect(aspect('give me the site report')).toBe('summary');
    expect(aspect('How sure is that?')).toBe('confidence');
    expect(aspect('how accurate is the 19 year sunlight?')).toBe('confidence');
  });

  it('answers anything else with a friendly pointer, never the site help', () => {
    expect(ask('')).toEqual({ tool: 'chat', input: { kind: 'about' } });
    expect(ask('tell me a joke')).toEqual({ tool: 'chat', input: { kind: 'unknown' } });
  });

  it("reads Luna as the assistant's name, not the Moon, while the Luna missions still open", () => {
    expect(ask('hi luna')).toEqual({ tool: 'chat', input: { kind: 'greet' } });
    const luna9 = MISSIONS.find((m) => /luna 9/i.test(m.name));
    if (luna9) expect(ask('show me Luna 9')).toEqual({ tool: 'show_mission', input: { id: luna9.id } });
  });
});

describe('aliasesOf', () => {
  it('knows a mission by its whole name, its craft name and its id', () => {
    expect(aliasesOf({ id: 'chang-e-4', name: "Chang'e 4 · Yutu-2" })).toEqual([' chang e 4 yutu 2 ', ' chang e 4 ']);
  });
});

describe('summarize', () => {
  const result: StayResult = {
    pass: false,
    uncertain: false,
    reasons: [
      { code: 'NO_DATA', detail: { missing: 'slope' } },
      { code: 'SUN_BELOW_HORIZON', atUtc: '2028-04-12T06:00:00.000Z', detail: {} },
    ],
    sunFractionMin: 0.25,
    earthVisiblePct: 88,
    nextSunsetUtc: '2028-04-12T06:00:00.000Z',
    slope100mDeg: Number.NaN,
    slope2kmPctUnder20: 0,
    series: { tUtcMs: new Float64Array(), sun: new Float32Array(), earth: new Float32Array() },
    sources: ['spice-de440s'],
  };
  const response: StayResponse = {
    result,
    terrain: { groundHeightM: 1897, resolutionM: 1200 } as StayResponse['terrain'],
    longTerm: { sunPct: 74, earthPct: 53, shadowed: false, id: 'landfall-polar-maps' } as StayResponse['longTerm'],
  };

  it("carries the report's own numbers and verdict, and nothing else", () => {
    const s = summarize(response, { latDeg: -89.45, lonDeg: -137.31 }, '2028-04-08T00:00:00.000Z');
    expect(s.verdict).toBe('fail');
    expect(s.checks).toEqual({ sun: 'no', earth: 'yes', slope: 'unknown', zone: 'yes' });
    expect(s.sunMinPct).toBe(25);
    expect(s.earthPct).toBe(88);
    expect(s.groundHeightM).toBe(1897);
    expect(s.terrainKm).toBe(1.2);
    expect(s.longTerm).toEqual({ sunPct: 74, earthPct: 53, shadowed: false });
    expect(s.problem).toEqual({ key: 'SUN_BELOW_HORIZON', atUtc: '2028-04-12T06:00:00.000Z', atLanding: false });
    expect(s.next.sunset).toBe('2028-04-12T06:00:00.000Z');
    expect(s.sources).toEqual(['spice-de440s', 'landfall-polar-maps']);
  });
});
