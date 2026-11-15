import { DEFAULT_STAY, type StayQuery } from '@siteline/contracts';
import { ARTEMIS_ZONE_LAT_DEG, LANDING_RADIUS_M, MAX_LANDING_SLOPE_DEG } from '@siteline/physics';
import type { TFunction } from 'i18next';
import { parseIntent, summarize, type Target } from './copilot';
import type { ToolCall, ToolResult } from './copilotAi';
import { coverageAt, gridReachLatDeg, TERRAIN_EXTENT, touchdownFromQuery } from './land';
import { findLander, MISSIONS } from './landers';
import { coordinate, type FoundSite, landingDate, pickRegions, rankFound, searchRegions } from './landingAgent';
import { physics, queryFor, URLS } from './physics';
import type { PassingSite, StayResponse } from './physics.worker';
import { REGIONS } from './regions';
import { fitAt, isRobotId, LANDING_RADII_M, type LandingRadius, nearestLander, ROBOTS, type RobotId } from './robots';
import { isSpaceBody, spaceFacts } from './spaceFacts';
import { FIRST_UTC_MS, LAST_UTC_MS, LAYERS, type Layer, MAX_PINS, type MoonView, useApp } from './store';

/**
 * Every tool Luna's agent can use, in one place. Each runs in the browser with the functions the screen itself
 * uses (the physics worker, the store), so whatever the agent says or shows is what SiteLine worked out. Read tools
 * only look; act tools move the view, the date, the pins or the map layer, as a visitor's own clicks would. None
 * writes data anywhere or calls an outside service.
 */

/** A card the chat shows under a reply: here, the sites a search found, each one a button that flies there. */
export interface SitesCard {
  kind: 'sites';
  landingUtc: string;
  robot: RobotId | null;
  sites: FoundSite[];
}

export interface AgentToolResult extends ToolResult {
  card?: SitesCard;
}

export interface ToolContext {
  t: TFunction;
  /** A line about what the tool is doing now, shown on its step while it runs ("Searching Haworth, 3 of 9"). */
  progress: (detail: string) => void;
  /**
   * A short sentence worth saying aloud while a long tool runs ("Found a spot in Nobile Rim 1, checking a few more"):
   * spoken by the voice agent in a live call, read out by the browser after a spoken question, ignored otherwise.
   */
  announce?: (sentence: string) => void;
}

/** Each region's passing sites for a landing date, so a repeat search or a follow-up question is instant. */
const searched = new Map<string, { sites: PassingSite[]; checked: number }>();
/** How many passing sites a search looks for before it stops starting new regions. */
const SITES_WANTED = 3;
/** Regions searched at once: their full checks mostly wait on terrain downloads, so they overlap. */
const REGIONS_AT_ONCE = 3;
/** Once a site is found, how long to look for alternatives before answering with what there is. */
const GRACE_AFTER_FIRST_MS = 20_000;
/** After this long, answer with what has been found so far (if anything); the rest keeps going in the background. */
const SEARCH_DEADLINE_MS = 75_000;
/** How long the search may go without saying anything before it says how far it has got. */
const QUIET_MS = 15_000;

/** Rounded to a tenth, the precision the report shows, so the model repeats what the screen says. */
export const tenth = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

const TARGETS: Target[] = ['solar', 'earth', 'mars', 'moon', 'pole'];
const VIEW_OF: Record<Target, MoonView> = { solar: 'solar', earth: 'earth', mars: 'mars', moon: 'globe', pole: 'pole' };
export const MISSION_NAMES = MISSIONS.map((m) => ({ id: m.id, name: m.name }));
/** The sites a search hands back to the model and shows on its card. */
const SITES_SHOWN = 5;
/** How many of the best sites get the robot's check: each is a full site check, so a few. */
const ROBOT_CHECKS = 3;

/** The landing date the screen shows, with its slip. */
const currentLanding = () => {
  const { latDeg, lonDeg, landingUtc, slipDays } = useApp.getState();
  return queryFor({ latDeg, lonDeg }, landingUtc, slipDays).landingUtc;
};

const robotOf = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isRobotId(v)) throw new Error(`no robot called ${String(v)}; use one of ${Object.keys(ROBOTS).join(', ')}`);
  return ROBOTS[v];
};

/** What a site check hands the model: the report's own numbers, rounded as the report rounds them. */
function siteFacts(r: StayResponse, query: StayQuery) {
  const site = { latDeg: query.site.latDeg, lonDeg: query.site.lonDeg };
  const s = summarize(r, site, query.landingUtc);
  return {
    sources: s.sources,
    data: {
      site,
      landingUtc: s.landingUtc,
      stayDays: query.stayDays,
      verdict: s.verdict,
      checks: s.checks,
      sunMinVisiblePct: tenth(s.sunMinPct),
      earthInViewPct: tenth(s.earthPct),
      landingSlope100mDeg: tenth(r.slope?.slope100mDeg),
      walkableWithin1kmPct: tenth(r.slope?.slope2kmPctUnder20),
      groundHeightM: s.groundHeightM === undefined ? null : Math.round(s.groundHeightM),
      horizonTerrainResolutionM: r.terrain?.resolutionM ?? null,
      longTerm: s.longTerm && {
        sunPct: tenth(s.longTerm.sunPct),
        earthPct: tenth(s.longTerm.earthPct),
        neverSunlit: s.longTerm.shadowed,
      },
      firstProblem: s.problem ?? null,
      next: s.next,
      rules: {
        stayDays: query.stayDays,
        minSunVisiblePct: query.minSunFraction * 100,
        slopeLimitDeg: MAX_LANDING_SLOPE_DEG,
        slopeOverM: 2 * LANDING_RADIUS_M,
        artemisZoneSouthOfDeg: Math.abs(ARTEMIS_ZONE_LAT_DEG),
      },
      caveat: 'Screening aid, not certification. Earth in view is not a radio link.',
    },
  };
}

/** One robot read against one site check, in words the model can repeat. */
function robotFacts(t: TFunction, robotId: RobotId, query: StayQuery, r: StayResponse, radiusM: number) {
  const robot = ROBOTS[robotId];
  const fit = fitAt(robot, query, r, radiusM);
  return {
    fit,
    data: {
      robot: t(`robot.name.${robot.id}`),
      about: t(`robot.blurb.${robot.id}`),
      overall: fit.overall,
      landingRadiusM: radiusM,
      checks: fit.checks
        .filter((c) => c.status !== 'not_evaluated' || c.id === 'darkness')
        .map((c) => ({
          check: c.id,
          status: c.status,
          says: t(`robot.check.${c.id}.${c.reason}`, {
            radius: c.values.radiusM,
            limit: c.values.limitDeg,
            worst: tenth(c.values.worstDeg),
            steep: tenth(c.values.steepPct),
            sun: tenth(c.values.sunPct),
            dark: tenth(c.values.darkH),
            days: query.stayDays,
            pct: tenth(c.values.pct),
            walk: tenth(c.values.walkablePct),
            km: tenth(c.values.shadowKm),
          }),
        })),
    },
  };
}

const radiusOf = (v: unknown): LandingRadius =>
  (LANDING_RADII_M as readonly number[]).includes(Number(v))
    ? (Number(v) as LandingRadius)
    : useApp.getState().landingRadiusM;

/** The call as the chat shows it under a step: `find_landing_sites(robot: "im2")`. */
export const callText = (call: ToolCall) =>
  `${call.name}(${Object.entries(call.arguments)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ')})`;

/** Runs one tool. A tool that cannot do what it was asked throws, and the model reads why. */
export async function runAgentTool(call: ToolCall, { t, progress, announce }: ToolContext): Promise<AgentToolResult> {
  const a = call.arguments;
  const shown = callText(call);
  const app = useApp.getState();

  switch (call.name) {
    case 'fly_to': {
      const target = a.target;
      if (TARGETS.includes(target as Target)) {
        app.set({ view: VIEW_OF[target as Target] });
        return { call: shown, data: { flyingTo: target } };
      }
      // The other planets have no view of their own: the solar-system view flies to one, shows its card, pulls back.
      if (target === 'sun') {
        app.set({ view: 'solar' });
        return { call: shown, data: { showing: 'the solar system, with the Sun at its centre' } };
      }
      if (isSpaceBody(target) && target !== 'sun') {
        app.visitSolar(target);
        return { call: shown, data: { visiting: target, onScreen: 'its card with distance and signal delay' } };
      }
      throw new Error(`no place called ${String(target)}`);
    }

    case 'space_facts': {
      const body = a.body;
      if (!isSpaceBody(body)) throw new Error(`no body called ${String(body)}`);
      // Positions at the whole hour of the date on screen, as the solar-system view and its cards use.
      const hourMs = Math.floor(Date.parse(app.landingUtc) / 3_600_000) * 3_600_000;
      const positions = await physics.planetsAt(hourMs, URLS.data);
      const facts = spaceFacts(body, positions, new Date(hourMs).toISOString());
      return {
        call: shown,
        sources: facts.sources,
        data: {
          ...facts,
          note: 'Only these numbers may be quoted. For anything else about this body, answer in words without numbers.',
        },
      };
    }

    case 'show_mission': {
      const named = parseIntent(String(a.name ?? ''), MISSION_NAMES);
      if (named.tool !== 'show_mission') throw new Error(`no mission called ${String(a.name)}`);
      app.selectMission(named.input.id);
      const m = findLander(named.input.id);
      return {
        call: shown,
        data: { opened: m?.name, status: m?.status, date: m?.date, site: m?.site[0], note: m?.note[0] },
      };
    }

    case 'analyze_site': {
      const query = queryFor({ latDeg: app.latDeg, lonDeg: app.lonDeg }, app.landingUtc, app.slipDays);
      const r = await physics.stay(query, URLS, 6000);
      return { call: shown, ...siteFacts(r, query) };
    }

    case 'check_site': {
      const latDeg = coordinate(a.latDeg, 'latDeg', -90, 90);
      const lonDeg = coordinate(a.lonDeg, 'lonDeg', -180, 180);
      const query = queryFor(
        { latDeg, lonDeg },
        landingDate(a.landingUtc, currentLanding(), FIRST_UTC_MS, LAST_UTC_MS),
        0,
      );
      const robot = robotOf(a.robot);
      progress(t('copilot.agent.checking'));
      const r = await physics.stay(query, URLS, 6000);
      const facts = siteFacts(r, query);
      const fit = robot && robotFacts(t, robot.id, query, r, radiusOf(a.landingRadiusM));
      return {
        call: shown,
        sources: [...facts.sources, ...(robot?.sources ?? [])],
        data: { ...facts.data, robotFit: fit?.data ?? null },
      };
    }

    case 'robot_fit': {
      const robot = robotOf(a.robot);
      if (!robot) throw new Error('robot is required');
      const radiusM = radiusOf(a.landingRadiusM);
      // The card shows the same robot, so what the copilot says can be checked on screen.
      app.set({ robot: robot.id, landingRadiusM: radiusM });
      const query = queryFor({ latDeg: app.latDeg, lonDeg: app.lonDeg }, app.landingUtc, app.slipDays);
      const r = await physics.stay(query, URLS, 6000);
      const { data } = robotFacts(t, robot.id, query, r, radiusM);
      const near = nearestLander(query.site.latDeg, query.site.lonDeg);
      return {
        call: shown,
        sources: robot.sources,
        data: {
          ...data,
          slopeLimitNote: t('robot.limitNote'),
          nearestLander: near && { name: near.name, km: tenth(near.km), approximate: near.approximate },
          caveat: t('robot.con3'),
        },
      };
    }

    case 'find_landing_sites': {
      const landingUtc = landingDate(a.landingUtc, currentLanding(), FIRST_UTC_MS, LAST_UTC_MS);
      const robot = robotOf(a.robot);
      const radiusM = radiusOf(a.landingRadiusM);
      const areas = pickRegions(REGIONS, Array.isArray(a.regions) ? a.regions : undefined);
      const query = { ...DEFAULT_STAY, landingUtc };
      // The search plays out on the pole: the camera goes there, and each site that passes drops as a pin.
      app.set({ view: 'pole', pins: [] });
      const found: FoundSite[] = [];
      let checked = 0;
      let done = 0;
      let lastSaid = Date.now();
      const say = (sentence: string) => {
        lastSaid = Date.now();
        announce?.(sentence);
      };
      const running = new Set<string>();
      const showRunning = () =>
        progress(t('copilot.agent.searchingMany', { regions: [...running].join(', '), done, of: areas.length }));
      // Something to hear during a long quiet stretch: how far the search has got.
      const heartbeat = setInterval(() => {
        if (Date.now() - lastSaid >= QUIET_MS)
          say(t('copilot.agent.say.still', { done, of: areas.length, found: found.length }));
      }, 3000);
      let search: Awaited<ReturnType<typeof searchRegions<(typeof areas)[number]>>>;
      try {
        search = await searchRegions(
          areas,
          async (area) => {
            const key = `${landingUtc}|${area.name}`;
            const known = searched.get(key);
            if (known) return known;
            running.add(area.name);
            showRunning();
            const out = await physics
              .passing({ centreLatDeg: area.lat, centreLonDeg: area.lon, sizeKm: area.sizeKm, top: 1 }, query, URLS)
              .finally(() => running.delete(area.name));
            searched.set(key, { sites: out.sites, checked: out.checked });
            return out;
          },
          {
            atOnce: REGIONS_AT_ONCE,
            enough: SITES_WANTED,
            graceAfterFirstMs: GRACE_AFTER_FIRST_MS,
            deadlineMs: SEARCH_DEADLINE_MS,
            onResult: ({ area, sites, checked: n }) => {
              done += 1;
              checked += n;
              const first = found.length === 0 && sites.length > 0;
              found.push(...sites.map((s) => ({ ...s, region: area.name })));
              useApp.getState().set({ pins: rankFound(found).slice(0, MAX_PINS) });
              if (first) {
                // The first find is shown and said at once; the search keeps going for alternatives.
                useApp.getState().focusSite(sites[0].latDeg, sites[0].lonDeg);
                say(t('copilot.agent.say.first', { region: area.name }));
              } else if (sites.length) say(t('copilot.agent.say.another', { region: area.name }));
              showRunning();
            },
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      // The robot's check on the best few, and the sources from a full check of the best one.
      const sources = new Set<string>(robot?.sources ?? []);
      let ranked = rankFound(found);
      const toCheck = ranked.slice(0, robot ? ROBOT_CHECKS : 1);
      if (robot && toCheck.length) say(t('copilot.agent.say.robot', { robot: t(`robot.name.${robot.id}`) }));
      for (const [i, s] of toCheck.entries()) {
        if (robot)
          progress(t('copilot.agent.fitting', { robot: t(`robot.name.${robot.id}`), done: i + 1, of: toCheck.length }));
        const q = queryFor({ latDeg: s.latDeg, lonDeg: s.lonDeg }, landingUtc, 0);
        const r = await physics.stay(q, URLS, robot ? 20_000 : 6000).catch(() => undefined);
        if (!r) continue;
        for (const id of summarize(r, { latDeg: s.latDeg, lonDeg: s.lonDeg }, landingUtc).sources) sources.add(id);
        if (robot) s.robotFit = fitAt(robot, q, r, radiusM).overall;
      }
      ranked = rankFound(ranked);
      useApp.getState().set({ pins: ranked.slice(0, MAX_PINS) });
      const shownSites = ranked.slice(0, SITES_SHOWN);
      return {
        call: shown,
        sources: [...sources],
        card: { kind: 'sites', landingUtc, robot: robot?.id ?? null, sites: shownSites },
        data: {
          landingUtc,
          stayDays: query.stayDays,
          regionsSearched: search.results.map((r) => r.area.name),
          ...(search.stoppedEarly && {
            stoppedEarly: `Answered early to keep the visitor waiting less: ${areas.length - search.results.length} region(s) not finished yet. They keep searching in the background; if the visitor asks for more options, call find_landing_sites again with the same date; regions already searched answer at once.`,
          }),
          checkedInFull: checked,
          robot: robot ? t(`robot.name.${robot.id}`) : null,
          rankedBy: robot
            ? 'robot fits first, then most Sun at the worst moment, then most Earth in view, then flattest'
            : 'most Sun at the worst moment, then most Earth in view, then flattest',
          sites: shownSites.map((s, i) => ({
            rank: i + 1,
            region: s.region,
            latDeg: round4(s.latDeg),
            lonDeg: round4(s.lonDeg),
            sunMinVisiblePct: tenth(s.sunFractionMin * 100),
            earthInViewPct: tenth(s.earthVisiblePct),
            landingSlope100mDeg: tenth(s.slope100mDeg),
            robotFit: s.robotFit ?? null,
          })),
          ...(ranked.length === 0 && {
            nothingPasses:
              'No spot passes all four checks on this date. Try another landing date a few days away, or fewer regions.',
          }),
        },
      };
    }

    case 'select_site': {
      const latDeg = coordinate(a.latDeg, 'latDeg', -90, 90);
      const lonDeg = coordinate(a.lonDeg, 'lonDeg', -180, 180);
      if (a.landingUtc !== undefined && a.landingUtc !== null && a.landingUtc !== '') {
        const landingUtc = landingDate(a.landingUtc, currentLanding(), FIRST_UTC_MS, LAST_UTC_MS);
        app.set({ landingUtc, live: false, slipDays: 0 });
      }
      useApp.getState().focusSite(latDeg, lonDeg);
      return { call: shown, data: { selected: { latDeg, lonDeg }, landingUtc: currentLanding(), reportOpen: true } };
    }

    case 'set_date': {
      const patch: { landingUtc?: string; live?: boolean; slipDays?: number } = {};
      if (a.landingUtc !== undefined && a.landingUtc !== null && a.landingUtc !== '') {
        patch.landingUtc = landingDate(a.landingUtc, currentLanding(), FIRST_UTC_MS, LAST_UTC_MS);
        patch.live = false;
      }
      if (a.slipDays !== undefined && a.slipDays !== null) patch.slipDays = Number(a.slipDays);
      if (!patch.landingUtc && patch.slipDays === undefined) throw new Error('give landingUtc, slipDays or both');
      app.set(patch);
      const s = useApp.getState();
      return {
        call: shown,
        data: { landingUtc: s.landingUtc, slipDays: s.slipDays, checkedLandingUtc: currentLanding() },
      };
    }

    case 'pin_sites': {
      const list = Array.isArray(a.sites) ? a.sites : [];
      const pins = list.slice(0, MAX_PINS).map((p, i) => ({
        latDeg: coordinate((p as { latDeg?: unknown })?.latDeg, `sites[${i}].latDeg`, -90, 90),
        lonDeg: coordinate((p as { lonDeg?: unknown })?.lonDeg, `sites[${i}].lonDeg`, -180, 180),
      }));
      if (pins.length === 0) throw new Error('give one to four sites');
      app.set({ pins, view: 'pole' });
      return { call: shown, data: { pinned: pins, compareOpen: true } };
    }

    case 'land_here': {
      // The selected site unless a spot is named; the date on screen unless one is given.
      const latDeg = a.latDeg === undefined || a.latDeg === null ? app.latDeg : coordinate(a.latDeg, 'latDeg', -90, 90);
      const lonDeg =
        a.lonDeg === undefined || a.lonDeg === null ? app.lonDeg : coordinate(a.lonDeg, 'lonDeg', -180, 180);
      const coverage = coverageAt(latDeg, lonDeg);
      if (coverage === 'none') {
        const reach = Math.abs(Math.round(gridReachLatDeg(TERRAIN_EXTENT.coarse.halfM)));
        throw new Error(
          `Land Here needs NASA's south-pole terrain, which reaches about ${reach} degrees south; pick a spot nearer the pole (find_landing_sites or select_site first)`,
        );
      }
      if (a.landingUtc !== undefined && a.landingUtc !== null && a.landingUtc !== '')
        app.set({ landingUtc: landingDate(a.landingUtc, currentLanding(), FIRST_UTC_MS, LAST_UTC_MS), live: false });
      // Select the spot first, so the report behind the landing is this spot's.
      useApp.getState().focusSite(latDeg, lonDeg);
      const s = useApp.getState();
      const query = queryFor({ latDeg, lonDeg }, s.landingUtc, s.slipDays);
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : undefined;
      s.setJourney(null);
      s.setLanding({ latDeg, lonDeg, touchdownUtcMs: touchdownFromQuery(query), source: { kind: 'report' }, name });
      return {
        call: shown,
        data: {
          landing: { latDeg: round4(latDeg), lonDeg: round4(lonDeg) },
          touchdownUtc: query.landingUtc,
          terrain: coverage === 'fine' ? 'NASA close-up terrain (fine detail)' : 'NASA LOLA terrain (coarser detail)',
          whatHappens:
            'The camera descends to the spot and the visitor stands there at real scale, as an astronaut. They walk with the arrow keys or W A S D (or the on-screen pad on a phone); the compass shows the Sun, the Earth and the way back to touchdown; the time slider steps the light and shadows. It is an interactive reconstruction from NASA terrain, not a photograph.',
        },
      };
    }

    case 'simulate_journey': {
      const body = a.body === 'Mars' || a.body === 'mars' ? 'Mars' : 'Moon';
      let latDeg: number;
      let lonDeg: number;
      let name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : undefined;
      if (a.latDeg !== undefined && a.latDeg !== null && a.lonDeg !== undefined && a.lonDeg !== null) {
        latDeg = coordinate(a.latDeg, 'latDeg', -90, 90);
        lonDeg = coordinate(a.lonDeg, 'lonDeg', -180, 180);
      } else if (body === 'Moon') {
        latDeg = app.latDeg;
        lonDeg = app.lonDeg;
      } else {
        // Mars needs a place: the open Mars lander's, if there is one.
        const m = app.missionId ? findLander(app.missionId) : undefined;
        if (!m || m.body !== 'Mars' || m.latDeg === undefined || m.lonDeg === undefined)
          throw new Error('give latDeg and lonDeg for a Mars landing, or open a Mars mission (show_mission) first');
        latDeg = m.latDeg;
        lonDeg = m.lonDeg;
        name ??= m.name;
      }
      app.setLanding(null);
      app.setJourney({ body, latDeg, lonDeg, name });
      return {
        call: shown,
        data: {
          journey: { body, latDeg: round4(latDeg), lonDeg: round4(lonDeg), name: name ?? null },
          whatHappens:
            body === 'Moon'
              ? 'A simplified, illustrative flight plays from Earth to the landing site: launch, the coast to the Moon, lunar orbit, then the descent, worked out from the real positions on the date shown.'
              : 'A simplified, illustrative flight from Earth to Mars plays, worked out from the real positions of the planets.',
        },
      };
    }

    case 'close_view': {
      const what = a.what === 'journey' || a.what === 'land_here' ? a.what : 'all';
      if (what !== 'journey') app.setLanding(null);
      if (what !== 'land_here') app.setJourney(null);
      return { call: shown, data: { closed: what } };
    }

    case 'show_layer': {
      const layer = a.layer as Layer;
      if (!LAYERS.includes(layer)) throw new Error(`no layer called ${String(a.layer)}; use ${LAYERS.join(', ')}`);
      app.set({ layer, view: 'pole' });
      // The legend's own scale is on screen; the model gets the layer's name only.
      return { call: shown, data: { layer, showing: t(`layers.${layer}`) } };
    }
  }
  throw new Error(`no tool called ${call.name}`);
}
