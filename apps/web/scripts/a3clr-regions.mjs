// Writes src/a3clrRegions.json: where each of NASA's 5 m Artemis III region elevation models (dataset a3clr-sfs-5m,
// PGDA product 104) sits inside its zip on the project's R2 copy, and the square of the south polar plane it covers.
// The surface view reads it to offer the 5 m ground where a landing point lies inside a region, and to fetch just that
// one member. Run from apps/web: `node scripts/a3clr-regions.mjs`. It reads each zip's directory and the first 256 KB of
// each elevation model, about 3.5 MB in all; nothing is guessed: every number comes from the files themselves.
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// The same mirror and archive list as pipeline/configs/a3clr-sfs-5m.yaml.
const BASE = 'https://pub-950982926f534224a9e16061b39f6217.r2.dev/raw/a3clr_sfs5mpp';
const REGIONS = [
  ['A3CLR22_0_Amundsen_Rim', 1775016989],
  ['A3CLR22_1_Nobile_Rim_2', 1839070131],
  ['A3CLR22_2_Haworth', 4353812518],
  ['A3CLR22_3_Faustini_Rim_A', 1936729230],
  ['A3CLR22_4_deGerlache_Rim_2', 2187384204],
  ['A3CLR22_5_Connecting_Ridge_Extension', 2225897760],
  ['A3CLR22_6_Connecting_Ridge', 2206485514],
  ['A3CLR22_7_Nobile_Rim_1', 1962014939],
  ['A3CLR22_8_Peak_Near_Shackleton', 1360387336],
  ['A3CLR22_9_deGerlache_Rim', 1340667387],
  ['A3CLR22_10_Leibnitz_Beta_Plateau', 1050441742],
  ['A3CLR22_11_Malapert_Massif', 2213137537],
  ['A3CLR22_12_deGerlache_Kocher_Massif', 2108633565],
];

async function range(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.status !== 206) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** The elevation member of a zip: its name, compression, sizes, CRC and where its data starts. */
async function member(url, total) {
  const tail = await range(url, total - 65558, total - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const rec = await range(url, Number(tail.readBigUInt64LE(eocd - 12)), Number(tail.readBigUInt64LE(eocd - 12)) + 55);
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
  for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const method = cd.readUInt16LE(p + 10);
    const crc32 = cd.readUInt32LE(p + 16);
    let compressed = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) {
          size = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    if (name.endsWith('_GLDELEV_005.tif')) {
      const local = await range(url, offset, offset + 29);
      const dataOffset = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      return { name, method, crc32, compressed, size, dataOffset };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${url}: no elevation model`);
}

/** The model's size, cell and corner, from its own TIFF header (the start of the member, inflated). */
async function header(url, m) {
  const head = await range(url, m.dataOffset, m.dataOffset + 262143);
  let bytes;
  try {
    bytes = m.method === 8 ? inflateRawSync(head, { finishFlush: 2 }) : head;
  } catch {
    throw new Error(`${url}: could not inflate the header`);
  }
  if (bytes.toString('ascii', 0, 2) !== 'II' || bytes.readUInt16LE(2) !== 42)
    throw new Error(`${url}: not a classic little-endian TIFF`);
  const ifd = bytes.readUInt32LE(4);
  const tags = new Map();
  for (let i = 0; i < bytes.readUInt16LE(ifd); i++) {
    const e = ifd + 2 + i * 12;
    tags.set(bytes.readUInt16LE(e), { type: bytes.readUInt16LE(e + 2), count: bytes.readUInt32LE(e + 4), at: e + 8 });
  }
  const int = (tag) => {
    const t = tags.get(tag);
    return t.type === 3 ? bytes.readUInt16LE(t.at) : bytes.readUInt32LE(t.at);
  };
  const doubles = (tag) => {
    const t = tags.get(tag);
    const at = bytes.readUInt32LE(t.at);
    return Array.from({ length: t.count }, (_, i) => bytes.readDoubleLE(at + 8 * i));
  };
  const geoKeys = tags.get(34735);
  const keysAt = bytes.readUInt32LE(geoKeys.at);
  let rasterType = 1;
  for (let k = 0; k < bytes.readUInt16LE(keysAt + 6); k++) {
    const e = keysAt + 8 + k * 8;
    if (bytes.readUInt16LE(e) === 1025) rasterType = bytes.readUInt16LE(e + 6);
  }
  const [pixX, pixY] = doubles(33550);
  const tie = doubles(33922);
  if (Math.abs(pixX - pixY) > 1e-9) throw new Error(`${url}: cells are not square`);
  // The outer corner of the first cell, as the worker's other terrain readers take it.
  const half = rasterType === 2 ? pixX / 2 : 0;
  return {
    width: int(256),
    height: int(257),
    pixM: pixX,
    cornerX: tie[3] - tie[0] * pixX - half,
    cornerY: tie[4] + tie[1] * pixY + half,
    tile: tags.has(322) ? int(322) : null,
  };
}

const regions = [];
for (const [archive, bytes] of REGIONS) {
  const url = `${BASE}/${archive}.zip`;
  const m = await member(url, bytes);
  const h = await header(url, m);
  regions.push({
    archive: `${archive}.zip`,
    name: archive.replace(/^A3CLR22_\d+_/, '').replaceAll('_', ' '),
    member: m.name,
    method: m.method,
    crc32: m.crc32,
    compressedBytes: m.compressed,
    bytes: m.size,
    dataOffset: m.dataOffset,
    ...h,
  });
  console.error(`${archive}: ${h.width} x ${h.height} at ${h.pixM} m, ${(m.compressed / 1e6).toFixed(1)} MB`);
}
writeFileSync(
  new URL('../src/a3clrRegions.json', import.meta.url),
  `${JSON.stringify({ datasetId: 'a3clr-sfs-5m', baseUrl: BASE, regions }, null, 2)}\n`,
);
