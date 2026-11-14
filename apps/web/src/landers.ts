import {
  type Bilingual,
  findMission,
  hasPlace,
  type Mission,
  type MissionsJson,
  parseMissions,
  patchKey,
  pinStyleOf,
  type SitePatchMeta,
  type SourceLink,
} from '@siteline/engine';
import missionsJson from '../../../data/missions.json';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
// The pipeline's outputs, where it publishes the close-ups it cuts. Read here rather than from physics.ts, which
// imports the store, which imports this file.
const DATA = import.meta.env.VITE_DATA_URL ?? '/data';

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
/**
 * A close-up's heights. One the pipeline cut names the dataset it came from and is published with the pipeline's
 * outputs; the demo's own close-ups name none and stay with its assets.
 */
export const patchImageUrl = (m: Mission, meta: SitePatchMeta): string | undefined => {
  const key = patchKey(m);
  if (!key) return undefined;
  return meta.source ? `${DATA}/sites/${key}.png` : `${ASSETS}/img/sites/${key}.png`;
};
export const TRACKS_URL = `${ASSETS}/data/tracks.json`;
/**
 * The close-ups' headers, first found first: the pipeline's, which carries the demo's entries too, then the demo's
 * own, which is all there is until the pipeline's has been published. A mission has a close-up when its key is here.
 */
export const SITES_URLS = [`${DATA}/sites/sites.json`, `${ASSETS}/data/sites.json`] as const;
/** The whole-planet colour maps; a close-up cuts its ground colour from them. */
export const COLOUR_URL = { Moon: `${ASSETS}/img/moon_color.jpg`, Mars: `${ASSETS}/img/mars_color.jpg` } as const;
