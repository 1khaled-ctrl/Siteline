import { describe, expect, it } from 'vitest';
import { BLOCK_BYTES, type ByteStore, cachingFetch, parseContentRange, parseRange } from './terrainCache';

/** A file of `size` bytes (byte i is i mod 251) served by ranges, counting what reaches the network. */
function server(size: number) {
  const file = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const calls: string[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = parseRange(new Headers(init?.headers).get('range'));
    calls.push(range ? `${range.start}-${range.end}` : 'whole');
    if (!range) return new Response(file);
    const end = Math.min(range.end, size - 1);
    return new Response(file.slice(range.start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${range.start}-${end}/${size}` },
    });
  }) as typeof fetch;
  return { file, calls, fetcher };
}

const memoryStore = (): ByteStore & { map: Map<string, Uint8Array> } => {
  const map = new Map<string, Uint8Array>();
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const read = async (f: typeof fetch, url: string, start: number, end: number) =>
  new Uint8Array(await (await f(url, { headers: { Range: `bytes=${start}-${end}` } })).arrayBuffer());

describe('terrain kept between visits', () => {
  it('reads parse their ranges', () => {
    expect(parseRange('bytes=10-20')).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=10-')).toBeUndefined();
    expect(parseRange('bytes=0-1,5-6')).toBeUndefined();
    expect(parseContentRange('bytes 0-9/100')).toEqual({ start: 0, end: 9, total: 100 });
  });

  it('answers a range read again from what it kept, byte for byte', async () => {
    const { file, calls, fetcher } = server(5 * BLOCK_BYTES + 123);
    const f = cachingFetch(fetcher, memoryStore(), (u) => u.endsWith('.TIF'));
    const first = await read(f, 'a.TIF', BLOCK_BYTES, 3 * BLOCK_BYTES - 1);
    await settle();
    const again = await read(f, 'a.TIF', BLOCK_BYTES, 3 * BLOCK_BYTES - 1);
    expect(calls).toEqual([`${BLOCK_BYTES}-${3 * BLOCK_BYTES - 1}`]);
    expect(again).toEqual(file.slice(BLOCK_BYTES, 3 * BLOCK_BYTES));
    expect(first).toEqual(again);
    // A smaller read inside what was kept, not on block edges, needs no network either.
    expect(await read(f, 'a.TIF', BLOCK_BYTES + 7, 2 * BLOCK_BYTES + 99)).toEqual(
      file.slice(BLOCK_BYTES + 7, 2 * BLOCK_BYTES + 100),
    );
    expect(calls).toHaveLength(1);
  });

  it('asks the network for any block it does not have, and keeps the file’s short last block', async () => {
    const size = 2 * BLOCK_BYTES + 500;
    const { file, calls, fetcher } = server(size);
    const f = cachingFetch(fetcher, memoryStore(), () => true);
    await read(f, 'b.TIF', 0, BLOCK_BYTES - 1);
    await settle();
    await read(f, 'b.TIF', 0, 2 * BLOCK_BYTES - 1);
    expect(calls).toHaveLength(2);
    await read(f, 'b.TIF', 2 * BLOCK_BYTES, size - 1);
    await settle();
    expect(await read(f, 'b.TIF', 2 * BLOCK_BYTES + 10, size + 1000)).toEqual(file.slice(2 * BLOCK_BYTES + 10));
    expect(calls).toHaveLength(3);
  });

  it('keeps only whole blocks, so a read off the block edges is not answered half from memory', async () => {
    const { calls, fetcher } = server(4 * BLOCK_BYTES);
    const store = memoryStore();
    const f = cachingFetch(fetcher, store, () => true);
    await read(f, 'c.TIF', 100, 2 * BLOCK_BYTES + 100);
    await settle();
    // Only block 1 lies wholly inside 100 to 2·64k + 100.
    expect([...store.map.keys()].filter((k) => !k.endsWith('#size'))).toEqual(['c.TIF#1']);
    await read(f, 'c.TIF', 0, BLOCK_BYTES - 1);
    expect(calls).toHaveLength(2);
  });

  it('leaves other files, whole-file reads, and a failing store to the network', async () => {
    const { calls, fetcher } = server(BLOCK_BYTES * 2);
    const broken: ByteStore = {
      get: () => Promise.reject(new Error('no storage')),
      put: () => Promise.reject(new Error('full')),
    };
    const f = cachingFetch(fetcher, broken, (u) => u.endsWith('.TIF'));
    await read(f, 'd.json', 0, 10);
    await f('e.TIF');
    const bytes = await read(f, 'e.TIF', 0, 10);
    await settle();
    expect(bytes).toHaveLength(11);
    expect(calls).toEqual(['0-10', 'whole', '0-10']);
  });
});
