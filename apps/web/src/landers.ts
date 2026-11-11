import {
  type Bilingual,
  findMission,
  hasPlace,
  type Mission,
  type MissionsJson,
  parseMissions,
  patchKey,
  pinStyleOf,
  type SourceLink,
} from '@siteline/engine';
import missionsJson from '../../../data/missions.json';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';

const file = missionsJson as unknown as MissionsJson;

/** Every lander in `data/missions.json`, checked on load. */
export const MISSIONS: readonly Mission[] = parseMissions(file);
/** The pages each mission cites, by the short ids the missions use: `[label, url]`. */
export const MISSION_SOURCES: Readonly<Record<string, SourceLink>> = file.sources;

/** The landers that have a place to put a pin, by planet. */
export const PINNED = {
  Moon: MISSIONS.filter((m) => m.body === 'Moon' && hasPlace(m)),
  Mars: MISSIONS.filter((m) => m.body === 'Mars' && hasPlace(m)),
} as const;

export const findLander = (id: string): Mission | undefined => findMission(MISSIONS, id);

const NOT_YET: readonly string[] = ['next', 'planned', 'onway'];
/** Which `landers.status.*` text describes a lander on the date shown: one that lands later counts as planned. */
export const statusKey = (m: Mission, atUtcMs: number): Mission['status'] =>
  pinStyleOf(m, atUtcMs) === 'future' && !NOT_YET.includes(m.status) ? 'planned' : m.status;

/** The English or Arabic half of a pair of texts. Only English is shown until the Arabic strings come back. */
export const textOf = (pair: Bilingual | undefined, language = 'en'): string =>
  pair ? pair[language.startsWith('ar') ? 1 : 0] : '';

export const modelUrl = (m: Mission): string | undefined => (m.model ? `${ASSETS}/models/${m.model}.json` : undefined);
export const patchImageUrl = (m: Mission): string | undefined => {
  const key = patchKey(m);
  return key ? `${ASSETS}/img/sites/${key}.png` : undefined;
};
export const TRACKS_URL = `${ASSETS}/data/tracks.json`;
export const SITES_URL = `${ASSETS}/data/sites.json`;
/** The whole-planet colour maps; a close-up cuts its ground colour from them. */
export const COLOUR_URL = { Moon: `${ASSETS}/img/moon_color.jpg`, Mars: `${ASSETS}/img/mars_color.jpg` } as const;
