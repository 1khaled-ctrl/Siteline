/**
 * Pieces of the big terrain files kept in the browser between visits. The surface view, the slope and the stay check
 * read the GeoTIFFs by byte ranges, and the bucket serves each download slowly (about 170 kB/s), so a site visited
 * again, or one next to it, used to cost the same download every time. Each range that comes back is kept as the
 * 64 kB blocks it covers; a range whose blocks are all kept is put together from them without the network. The bytes
 * are the files' own, so nothing read from them changes.
 */

/** The size of a kept piece: the same as the GeoTIFF reader's own blocks, so its reads line up with them. */
export const BLOCK_BYTES = 65_536;

/** Where the pieces are kept: the Cache Storage in the browser, a map in the tests. */
export interface ByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** The first and last byte of a request's single `Range: bytes=a-b`, or undefined for anything else. */
export function parseRange(header: string | null): { start: number; end: number } | undefined {
  const m = header?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end >= start ? { start, end } : undefined;
}

/** A response's `Content-Range: bytes a-b/total`, or undefined. */
export function parseContentRange(header: string | null): { start: number; end: number; total: number } | undefined {
  const m = header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

const sizeKey = (url: string) => `${url}#size`;
const blockKey = (url: string, block: number) => `${url}#${block}`;

/** The blocks wholly inside a range that came back (and the file's last block, if the range reaches the end). */
async function keepBlocks(
  store: ByteStore,
  url: string,
  got: { start: number; end: number; total: number },
  bytes: Uint8Array,
) {
  await store.put(sizeKey(url), new TextEncoder().encode(String(got.total)));
  for (let b = Math.ceil(got.start / BLOCK_BYTES); b * BLOCK_BYTES <= got.end; b++) {
    const s = b * BLOCK_BYTES;
    const e = Math.min(s + BLOCK_BYTES, got.total) - 1;
    if (e > got.end) break;
    await store.put(blockKey(url, b), bytes.slice(s - got.start, e - got.start + 1));
  }
}

/** A range put together from kept blocks, or undefined if any of them is missing. */
async function fromBlocks(
  store: ByteStore,
  url: string,
  want: { start: number; end: number },
): Promise<{ bytes: Uint8Array; end: number; total: number } | undefined> {
  const size = await store.get(sizeKey(url));
  const total = size ? Number(new TextDecoder().decode(size)) : Number.NaN;
  if (!(total > 0) || want.start >= total) return undefined;
  const end = Math.min(want.end, total - 1);
  const first = Math.floor(want.start / BLOCK_BYTES);
  const last = Math.floor(end / BLOCK_BYTES);
  const blocks = await Promise.all(
    Array.from({ length: last - first + 1 }, (_, i) => store.get(blockKey(url, first + i))),
  );
  if (blocks.some((b) => b === undefined)) return undefined;
  const bytes = new Uint8Array(end - want.start + 1);
  blocks.forEach((block, i) => {
    const s = (first + i) * BLOCK_BYTES;
    const from = Math.max(want.start, s);
    const to = Math.min(end, s + (block as Uint8Array).length - 1);
    if (to >= from) bytes.set((block as Uint8Array).subarray(from - s, to - s + 1), from - want.start);
  });
  return { bytes, end, total };
}

/**
 * A `fetch` that answers byte-range reads of the files `keep` picks from kept blocks when it can, and keeps the blocks
 * of every such read the network answers. Everything else goes straight to `fetcher`. A store that fails (no storage,
 * a full disk) only means the network is asked.
 */
export function cachingFetch(fetcher: typeof fetch, store: ByteStore, keep: (url: string) => boolean): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const want = parseRange(new Headers(init?.headers).get('range'));
    if (!want || !keep(url)) return fetcher(input, init);
    const kept = await fromBlocks(store, url, want).catch(() => undefined);
    if (kept) {
      return new Response(kept.bytes as Uint8Array<ArrayBuffer>, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${want.start}-${kept.end}/${kept.total}`,
          'Content-Length': String(kept.bytes.length),
          'Content-Type': 'application/octet-stream',
        },
      });
    }
    const response = await fetcher(input, init);
    const got = parseContentRange(response.headers.get('content-range'));
    if (response.status !== 206 || !got) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Kept in the background: the read need not wait for the disk.
    void keepBlocks(store, url, got, bytes).catch(() => {});
    return new Response(bytes, { status: 206, statusText: response.statusText, headers: response.headers });
  };
}

/** A store in the browser's Cache Storage, under `name`; one that answers nothing where there is none. */
export function cacheStorageStore(name: string): ByteStore {
  // Opened for each use (it is cheap), so a cache the browser or the user has cleared is never written to stale.
  const open = () => caches.open(name);
  // Cache Storage keys requests by URL: each key becomes one under a made-up origin.
  const keyUrl = (key: string) => `https://siteline-terrain.invalid/${encodeURIComponent(key)}`;
  return {
    async get(key) {
      try {
        const hit = await (await open()).match(keyUrl(key));
        return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
      } catch {
        return undefined;
      }
    },
    async put(key, bytes) {
      try {
        await (await open()).put(keyUrl(key), new Response(bytes as Uint8Array<ArrayBuffer>));
      } catch {
        // No room or no storage: the next visit downloads again.
      }
    },
  };
}
