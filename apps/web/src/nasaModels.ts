import { type ModelStatus, type ModelsFile, type NasaModel, parseModels, showableModels } from '@siteline/data-client';
import { useEffect, useState } from 'react';
import missionsJson from '../../../data/missions.json';

/**
 * The public address of the `siteline-terrain` bucket, which holds the NASA 3D models the pipeline publishes (#44) and
 * the 30 m terrain. A model is at `<this>/<its key>`, for example `.../models/v1/lro_b.json`.
 */
export const TERRAIN_BUCKET_URL: string = (
  import.meta.env.VITE_TERRAIN_BUCKET_URL ?? 'https://pub-950982926f534224a9e16061b39f6217.r2.dev'
).replace(/\/+$/, '');

const MISSION_IDS: ReadonlySet<string> = new Set(
  (missionsJson as unknown as { missions: { id: string }[] }).missions.map((m) => m.id),
);

/**
 * The manifest, from what `import.meta.glob` found: nothing when the file is absent or fails to parse, so a bad file
 * means no models on screen and a warning in the console, never an error.
 */
export function readManifest(found: Record<string, unknown>, missionIds = MISSION_IDS): ModelsFile | undefined {
  const [file] = Object.values(found);
  if (file === undefined) return undefined;
  try {
    return parseModels((file as { default?: unknown }).default ?? file, missionIds);
  } catch (error) {
    console.warn(`NASA 3D models: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** `data/models.json`, written by the pipeline; a build without it has no models. */
export const MANIFEST: ModelsFile | undefined = readManifest(
  import.meta.glob('../../../data/models.json', { eager: true }),
);

/** Where the app loads a model from. */
export const modelFileUrl = (m: NasaModel, base = TERRAIN_BUCKET_URL): string => `${base}/${m.key}`;

/** The models the Moon card lists: built, logo-checked, and belonging to no lander in our mission list. */
export const cardModels = (file: ModelsFile | undefined = MANIFEST): NasaModel[] =>
  file ? showableModels(file).filter((m) => m.mission === null) : [];

/** The model a lander's card shows, where the manifest names one for its mission. */
export const missionModel = (missionId: string, file: ModelsFile | undefined = MANIFEST): NasaModel | undefined =>
  file ? showableModels(file).find((m) => m.mission === missionId) : undefined;

/** The i18n key of a status's words. Each is shown as itself; only "being checked" carries no NASA page. */
export const statusKey = (s: ModelStatus): string => `nasaModels.status.${s === 'being checked' ? 'beingChecked' : s}`;

/** A status that a NASA page states, shown with that page. */
export const sourcedStatus = (m: NasaModel): boolean => m.status !== 'being checked' && m.statusSource !== null;

const checked = new Map<string, Promise<boolean>>();

/**
 * Whether the bucket holds a model's file: one `HEAD` request per address, remembered for the session. A 404 or a
 * network error counts as absent.
 */
export function fileThere(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  let known = checked.get(url);
  if (!known) {
    known = fetcher(url, { method: 'HEAD' }).then(
      (r) => r.ok,
      () => false,
    );
    checked.set(url, known);
  }
  return known;
}

/** Forgets what `fileThere` has learnt; for tests. */
export const forgetFileChecks = () => checked.clear();

/**
 * The models whose files answer, in the manifest's order; empty until the checks come back. A model whose file then
 * fails to load can be dropped with `drop`.
 */
export function useModelsThere(models: readonly NasaModel[]): { there: NasaModel[]; drop: (id: string) => void } {
  const [ok, setOk] = useState<ReadonlySet<string>>(new Set());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const ids = models.map((m) => m.id).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids stand for the list, which is rebuilt each render
  useEffect(() => {
    let live = true;
    Promise.all(models.map(async (m) => [m.id, await fileThere(modelFileUrl(m))] as const)).then((answers) => {
      if (live) setOk(new Set(answers.filter(([, there]) => there).map(([id]) => id)));
    });
    return () => {
      live = false;
    };
  }, [ids]);
  return {
    there: models.filter((m) => ok.has(m.id) && !dropped.has(m.id)),
    drop: (id) => setDropped((d) => new Set(d).add(id)),
  };
}
