import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Just enough PNG for the 8-bit RGB height map: inflate, then undo each row's filter. */
export function readPngRgb(path: string) {
  const file = readFileSync(path);
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  if (file[24] !== 8 || file[25] !== 2 || file[28] !== 0) throw new Error('expected 8-bit RGB without interlacing');
  const parts: Buffer[] = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    if (file.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(file.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 3;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= 3 ? px[y * stride + i - 3] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 3 ? px[(y - 1) * stride + i - 3] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      px[y * stride + i] = (x + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4);
  return { rgba, width, height };
}
