import type { StayResponse } from './physics.worker';
import { type Check, type CheckKey, checksOf, firstProblem, type Problem, type Verdict, verdictOf } from './verdict';

/**
 * The browser half of the copilot: the tools it may call and a small matcher that picks one from a message. The
 * matcher stands in for the model until the relay worker (apps/copilot-worker) exists; the tools stay as they are, and
 * every one only reads data or moves the view, never writes.
 */

export type Target = 'solar' | 'earth' | 'mars' | 'moon' | 'pole';
export type Aspect =
  | 'summary'
  | 'verdict'
  | 'why'
  | 'sun'
  | 'earth'
  | 'slope'
  | 'height'
  | 'longTerm'
  | 'events'
  | 'confidence';

export type Intent =
  | { tool: 'fly_to'; input: { target: Target } }
  | { tool: 'show_mission'; input: { id: string } }
  | { tool: 'analyze_site'; input: { aspect: Aspect } }
  | { tool: 'find_landing_sites' }
  | { tool: 'space'; input: { body: SpaceBodyName; show: boolean; facts: boolean } }
  | { tool: 'chat'; input: { kind: ChatKind } }
  | { tool: 'help' };

/** Small talk the matcher answers itself, at once and in a friendly way. `unknown` is anything it could not place. */
export type ChatKind = 'greet' | 'howAreYou' | 'thanks' | 'bye' | 'about' | 'unknown';
export type SpaceBodyName =
  | 'sun'
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

export interface MissionName {
  id: string;
  name: string;
}

const normal = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

/** The ways a person might name a mission: the whole name, the part before "·" (the craft), and its id. */
export function aliasesOf(m: MissionName): string[] {
  const parts = [m.name, m.name.split(/[·(]/)[0], m.id.replace(/[-_]/g, ' ')];
  return [...new Set(parts.map(normal).filter((a) => a.trim().length >= 3))];
}

const TARGETS: [Target, RegExp][] = [
  ['pole', / (south pole|pole|artemis zone) /],
  ['solar', / (solar system|planets|sun) /],
  ['earth', / (earth|home planet) /],
  ['mars', / (mars|red planet) /],
  // Not "luna": that is the assistant's name now (the Luna missions are matched by their own names above).
  ['moon', / (moon|lunar) /],
];
const MOVE = / (fly|go|take me|travel|head|show me|open|back to|zoom to|switch to) /;
const SEARCH = / (find|search|look for|recommend|suggest|best|where should|where can|pick|choose) /;
const PLACE = / (site|sites|spot|spots|land|landing|place|places|location) /;

/** Site questions, most specific first: "sunset" must not read as "sun", nor "19 years of sun" as plain sunlight. */
const ASPECTS: [Aspect, RegExp][] = [
  ['confidence', / (sure|confidence|confident|reliable|accurate|accuracy|trust|certain|uncertain) /],
  ['events', / (when|sunset|sunrise|earthset|earthrise|next|until) /],
  ['longTerm', / (19|year|years|long term|always|permanent|shadow|shadowed|never) /],
  ['why', / (why|reason|reasons|problem|problems|wrong|fails because) /],
  ['slope', / (slope|steep|flat|tilt|incline) /],
  ['height', / (height|elevation|altitude|how high|high) /],
  ['earth', / (earth|radio|contact|comms|communication|signal) /],
  ['sun', / (sun|sunlight|light|lit|dark|power|solar) /],
  ['verdict', / (pass|passes|fail|fails|verdict|safe|good|ok|okay|land here|can i land|work) /],
  ['summary', / (report|summary|site|spot|check|analy[sz]e|here|this) /],
];

/** Planets with no view of their own: any mention of one is about that planet. */
const FAR_BODIES: [SpaceBodyName, RegExp][] = [
  ['mercury', / mercury /],
  ['venus', / venus /],
  ['jupiter', / jupiter /],
  ['saturn', / saturn /],
  ['uranus', / uranus /],
  ['neptune', / neptune /],
];
/** Bodies that also come up in site questions ("when does the Sun set?"): only a facts question makes them the topic. */
const NEAR_BODIES: [SpaceBodyName, RegExp][] = [
  ['sun', / (the )?sun /],
  ['moon', / (the )?moon /],
  ['mars', / mars /],
  ['earth', / earth /],
];
const FACTS =
  / (how far|far away|distance|how long|travel|get there|get to|reach|journey|trip|gravity|temperature|how cold|how hot|cold|hot|weather|how big|size|day length|how long is a day|signal|delay|facts?|tell me about|what is it like) /;
const SHOW = / (show|see|look|visit|go to|fly|take me|zoom|open) /;

/** A question asking for a body's numbers (how far, how cold, how long to get there), whatever the body. */
export const isFactsQuestion = (text: string): boolean => FACTS.test(normal(text));

const SPACE_NAMES: readonly SpaceBodyName[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];
export const isSpaceBodyName = (v: unknown): v is SpaceBodyName =>
  typeof v === 'string' && (SPACE_NAMES as readonly string[]).includes(v);

/** Small talk, read only from short messages so "is this site good, thanks" stays a site question. */
const CHAT: [ChatKind, RegExp][] = [
  ['howAreYou', / (how are you|how r u|how are u|hows it going|how is it going|whats up|wassup|sup) /],
  ['thanks', / (thanks|thank you|thx|ty|cheers|appreciate it|great job|good job|awesome|cool|nice) /],
  ['bye', / (bye|goodbye|see you|see ya|good night|later) /],
  [
    'about',
    / (who are you|what are you|what can you do|what do you do|help|what is siteline|what is this|how does this work|your name) /,
  ],
  [
    'greet',
    / (h+e+l+o+|h+e+y+|hi+|hiya|yo|hola|salam|salaam|marhaba|ahlan|good (morning|afternoon|evening)|greetings) /,
  ],
];

/** Picks one tool for a message; small talk and anything unplaced get a friendly reply of their own. */
export function parseIntent(text: string, missions: readonly MissionName[]): Intent {
  const s = normal(text);
  if (s.trim() === '') return { tool: 'chat', input: { kind: 'about' } };
  const words = s.trim().split(' ').length;

  // "Find me a landing site", "where should I land?", "where should the IM-2 hopper land?": the search, even when a
  // craft is named, and not a check of this site.
  if (SEARCH.test(s) && PLACE.test(s)) return { tool: 'find_landing_sites' };

  // Otherwise a mission named outright wins: "show me Apollo 11" is about the lander, not about the Moon.
  let best: { id: string; length: number } | undefined;
  for (const m of missions) {
    for (const a of aliasesOf(m))
      if (s.includes(a) && a.length > (best?.length ?? 0)) best = { id: m.id, length: a.length };
  }
  if (best) return { tool: 'show_mission', input: { id: best.id } };

  // A planet with no view of its own, or a facts question about any body: fly there and give its numbers.
  const facts = FACTS.test(s);
  const far = FAR_BODIES.find(([, re]) => re.test(s))?.[0];
  if (far) return { tool: 'space', input: { body: far, show: true, facts: facts || words <= 3 || !SHOW.test(s) } };
  const near = NEAR_BODIES.find(([, re]) => re.test(s))?.[0];
  if (near && facts && !/ (set|sets|rise|rises|in view|visible|here|this site|spot) /.test(s))
    return { tool: 'space', input: { body: near, show: SHOW.test(s), facts: true } };

  const target = TARGETS.find(([, re]) => re.test(s))?.[0];
  const moving = MOVE.test(s);
  // "Fly to Mars", or a bare "Mars"; but "is Earth in view?" is a question about the site.
  if (target && (moving || s.trim().split(' ').length <= 2)) return { tool: 'fly_to', input: { target } };

  // Small talk before site questions: "hey, good job" is thanks, not "is it good?".
  const chat = words <= 7 ? CHAT.find(([, re]) => re.test(s))?.[0] : undefined;
  if (chat) return { tool: 'chat', input: { kind: chat } };

  const aspect = ASPECTS.find(([, re]) => re.test(s))?.[0];
  if (aspect) return { tool: 'analyze_site', input: { aspect } };
  return { tool: 'chat', input: { kind: 'unknown' } };
}

/** What analyze_site hands back: the site report's own numbers, nothing added. */
export interface SiteSummary {
  latDeg: number;
  lonDeg: number;
  landingUtc: string;
  verdict: Verdict;
  checks: Record<CheckKey, Check>;
  sunMinPct: number;
  earthPct: number;
  groundHeightM?: number;
  terrainKm?: number;
  longTerm?: { sunPct: number; earthPct: number; shadowed?: boolean; resolutionM?: number };
  problem?: Problem;
  next: { sunset?: string; sunrise?: string; earthset?: string; earthrise?: string };
  sources: string[];
}

export function summarize(r: StayResponse, site: { latDeg: number; lonDeg: number }, landingUtc: string): SiteSummary {
  const checks = checksOf(r.result);
  return {
    ...site,
    landingUtc,
    verdict: verdictOf(checks),
    checks,
    sunMinPct: r.result.sunFractionMin * 100,
    earthPct: r.result.earthVisiblePct,
    groundHeightM: r.terrain?.groundHeightM,
    terrainKm: r.terrain && r.terrain.resolutionM / 1000,
    longTerm: r.longTerm && {
      sunPct: r.longTerm.sunPct,
      earthPct: r.longTerm.earthPct,
      shadowed: r.longTerm.shadowed,
      resolutionM: r.longTerm.resolutionM,
    },
    problem: firstProblem(r.result.reasons, Date.parse(landingUtc)),
    next: {
      sunset: r.result.nextSunsetUtc,
      sunrise: r.result.nextSunriseUtc,
      earthset: r.result.nextEarthsetUtc,
      earthrise: r.result.nextEarthriseUtc,
    },
    sources: [...new Set([...r.result.sources, ...(r.longTerm ? [r.longTerm.id] : [])])],
  };
}
