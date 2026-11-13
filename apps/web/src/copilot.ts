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
  | { tool: 'help' };

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
  ['moon', / (moon|lunar|luna) /],
];
const MOVE = / (fly|go|take me|travel|head|show me|open|back to|zoom to|switch to) /;

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

/** Picks one tool for a message, or help when nothing fits. */
export function parseIntent(text: string, missions: readonly MissionName[]): Intent {
  const s = normal(text);
  if (s.trim() === '') return { tool: 'help' };

  // A mission named outright wins: "show me Apollo 11" is about the lander, not about the Moon.
  let best: { id: string; length: number } | undefined;
  for (const m of missions) {
    for (const a of aliasesOf(m))
      if (s.includes(a) && a.length > (best?.length ?? 0)) best = { id: m.id, length: a.length };
  }
  if (best) return { tool: 'show_mission', input: { id: best.id } };

  const target = TARGETS.find(([, re]) => re.test(s))?.[0];
  const moving = MOVE.test(s);
  // "Fly to Mars", or a bare "Mars"; but "is Earth in view?" is a question about the site.
  if (target && (moving || s.trim().split(' ').length <= 2)) return { tool: 'fly_to', input: { target } };

  const aspect = ASPECTS.find(([, re]) => re.test(s))?.[0];
  if (aspect) return { tool: 'analyze_site', input: { aspect } };
  return { tool: 'help' };
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
    sources: [...r.result.sources, ...(r.longTerm ? [r.longTerm.id] : [])],
  };
}
