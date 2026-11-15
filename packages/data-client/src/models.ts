/**
 * The NASA 3D models the pipeline publishes for the lander cards, as `data/models.json` lists them. The file is written
 * by `pipeline/siteline_pipeline/models.py` from `pipeline/configs/models.toml`; the pipeline is the spec, and this
 * reads it exactly, refusing anything it does not expect rather than guessing.
 */

/** What is known about where a model's spacecraft or hardware has been. Only "being checked" needs no source. */
export const MODEL_STATUSES = ['flew', 'prototype', 'concept', 'being checked'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export interface NasaModel {
  id: string;
  /** The name the card shows. */
  name: string;
  /** NASA's page for the model on science.nasa.gov. */
  sourceUrl: string;
  /** The credit line, as the "Source" field of that page gives it. */
  credit: string;
  status: ModelStatus;
  /** The NASA page that says the status; null only for "being checked". */
  statusSource: string | null;
  /** What that page says, in short; null only for "being checked". */
  statusNote: string | null;
  /** Its mission's id in `data/missions.json`, or null: most models belong to no lander there. */
  mission: string | null;
  /** True once every texture has been looked at and none shows the NASA insignia or another logo. */
  logoChecked: boolean;
  logoCheck: string;
  /** Anything a reader of the card should know, such as why its status is still being checked. */
  note: string | null;
  /** Where the file is, below the manifest's `baseUrl`: `models/v<N>/<id>.json`. */
  key: string;
  /** The published file's size and sha256; null until it has been built. */
  bytes: number | null;
  sha256: string | null;
  source: { path: string; bytes: number | null; gitBlob: string | null };
  optimize: { textureSize: number; simplifyError?: number };
}

export interface ModelsFile {
  format: 'siteline-models-1';
  dataset: string;
  /** The bucket's public address the keys are below, with no trailing slash. */
  baseUrl: string;
  limitBytes: number;
  mirror: { repo: string; commit: string };
  tool: string;
  models: readonly NasaModel[];
}

// A declaration, not an arrow function, so the checker sees that code after a `bad` call runs only when its test passed.
function bad(what: string): never {
  throw new Error(`data/models.json: ${what}`);
}

const record = (v: unknown, label: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : bad(`${label} is missing`);

const text = (v: unknown, label: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v : bad(`${label} is missing`);

const textOrNull = (v: unknown, label: string): string | null => (v === null ? null : text(v, label));

const whole = (v: unknown, label: string): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : bad(`${label} is not a whole number above zero`);

function onlyKnown(v: Record<string, unknown>, known: readonly string[], label: string) {
  for (const k of Object.keys(v)) if (!known.includes(k)) bad(`${label}${k} is not a field this file knows`);
}

/** An https page on nasa.gov or one of its subdomains. */
function nasaPage(v: unknown, label: string): string {
  const url = text(v, label);
  let host = '';
  try {
    const parsed = new URL(url);
    host = parsed.protocol === 'https:' ? parsed.hostname : '';
  } catch {
    // not an address at all
  }
  return host === 'nasa.gov' || host.endsWith('.nasa.gov') ? url : bad(`${label} is not a NASA page`);
}

const FILE_KEYS = ['format', 'note', 'dataset', 'baseUrl', 'limitBytes', 'mirror', 'tool', 'models'];
const MODEL_KEYS = [
  'id',
  'name',
  'sourceUrl',
  'credit',
  'status',
  'statusSource',
  'statusNote',
  'mission',
  'logoChecked',
  'logoCheck',
  'note',
  'key',
  'bytes',
  'sha256',
  'source',
  'optimize',
];

function parseModel(v: unknown, n: number, limit: number, missions: ReadonlySet<string>): NasaModel {
  const m = record(v, `models[${n}]`);
  const id = text(m.id, `models[${n}].id`);
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(id)) bad(`${id} is not an id of lower-case letters, digits and underscores`);
  const label = `${id}.`;
  onlyKnown(m, MODEL_KEYS, label);

  const status = text(m.status, `${label}status`) as ModelStatus;
  if (!MODEL_STATUSES.includes(status)) bad(`${label}status "${status}" is not one of ${MODEL_STATUSES.join(', ')}`);
  const statusSource = m.statusSource === null ? null : nasaPage(m.statusSource, `${label}statusSource`);
  const statusNote = textOrNull(m.statusNote, `${label}statusNote`);
  if (status !== 'being checked' && (statusSource === null || statusNote === null))
    bad(`${label}status "${status}" names no NASA page that says so`);

  const mission = m.mission === null ? null : text(m.mission, `${label}mission`);
  if (mission !== null && !missions.has(mission)) bad(`${label}mission "${mission}" is not in data/missions.json`);
  if (typeof m.logoChecked !== 'boolean') bad(`${label}logoChecked is not true or false`);

  const key = text(m.key, `${label}key`);
  if (!new RegExp(`^models/v[1-9][0-9]*/${id}\\.json$`).test(key)) bad(`${label}key is not models/v<N>/${id}.json`);
  const bytes = m.bytes === null ? null : whole(m.bytes, `${label}bytes`);
  const sha256 = m.sha256 === null ? null : text(m.sha256, `${label}sha256`);
  if ((bytes === null) !== (sha256 === null)) bad(`${label}bytes and sha256 come together, or neither does`);
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) bad(`${label}sha256 is not a sha256`);
  if (bytes !== null && bytes > limit) bad(`${label}bytes is over the ${limit}-byte limit`);

  const source = record(m.source, `${label}source`);
  onlyKnown(source, ['path', 'bytes', 'gitBlob'], `${label}source.`);
  const optimize = record(m.optimize, `${label}optimize`);
  onlyKnown(optimize, ['textureSize', 'simplifyError'], `${label}optimize.`);
  const simplifyError = optimize.simplifyError;
  if (simplifyError !== undefined && (typeof simplifyError !== 'number' || !(simplifyError > 0 && simplifyError < 1)))
    bad(`${label}optimize.simplifyError is not a fraction between 0 and 1`);

  return {
    id,
    name: text(m.name, `${label}name`),
    sourceUrl: nasaPage(m.sourceUrl, `${label}sourceUrl`),
    credit: text(m.credit, `${label}credit`),
    status,
    statusSource,
    statusNote,
    mission,
    logoChecked: m.logoChecked,
    logoCheck: text(m.logoCheck, `${label}logoCheck`),
    note: m.note === undefined ? null : textOrNull(m.note, `${label}note`),
    key,
    bytes,
    sha256,
    source: {
      path: text(source.path, `${label}source.path`),
      bytes: source.bytes === null ? null : whole(source.bytes, `${label}source.bytes`),
      gitBlob: source.gitBlob === null ? null : text(source.gitBlob, `${label}source.gitBlob`),
    },
    optimize: {
      textureSize: whole(optimize.textureSize, `${label}optimize.textureSize`),
      ...(typeof simplifyError === 'number' ? { simplifyError } : {}),
    },
  };
}

/**
 * Reads `data/models.json`. Refuses a model with no NASA page or no credit line, an unknown status, a status other
 * than "being checked" that names no NASA page, a mission not in `missionIds`, a file over the limit, a repeated id,
 * and any field it does not know.
 */
export function parseModels(file: unknown, missionIds: ReadonlySet<string>): ModelsFile {
  const f = record(file, 'the file');
  onlyKnown(f, FILE_KEYS, '');
  if (f.format !== 'siteline-models-1') bad(`format is ${JSON.stringify(f.format)}, not "siteline-models-1"`);
  const baseUrl = text(f.baseUrl, 'baseUrl');
  if (!baseUrl.startsWith('https://') || baseUrl.endsWith('/')) bad('baseUrl is not https with no trailing slash');
  const limitBytes = whole(f.limitBytes, 'limitBytes');
  const mirror = record(f.mirror, 'mirror');
  if (!Array.isArray(f.models)) bad('models is not a list');
  const models = (f.models as unknown[]).map((m, n) => parseModel(m, n, limitBytes, missionIds));
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) bad(`${m.id} is listed twice`);
    seen.add(m.id);
  }
  return {
    format: 'siteline-models-1',
    dataset: text(f.dataset, 'dataset'),
    baseUrl,
    limitBytes,
    mirror: { repo: text(mirror.repo, 'mirror.repo'), commit: text(mirror.commit, 'mirror.commit') },
    tool: text(f.tool, 'tool'),
    models,
  };
}

/** The models a card may show: built, and with their logo check recorded. */
export const showableModels = (file: ModelsFile): NasaModel[] =>
  file.models.filter((m) => m.logoChecked && m.bytes !== null);

/** Where the app loads a model from: JSON holding the `.glb` as one base64 string, as the engine's loader reads. */
export const modelFileUrl = (file: ModelsFile, m: NasaModel): string => `${file.baseUrl}/${m.key}`;
