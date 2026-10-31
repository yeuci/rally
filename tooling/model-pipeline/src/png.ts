import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG for pack textures: decode 8-bit RGB / RGBA (non-interlaced), box-downscale, encode RGBA. The packs'
 * textures are a few hundred pixels of flat colour or alpha line art; a phone needs a fraction of that.
 */
export interface Image {
  width: number;
  height: number;
  /** RGBA bytes, row-major. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(bytes: Uint8Array): Image {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  for (let o = 8; o < bytes.length;) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      const depth = body[8];
      colorType = body[9]!;
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${body[12]})`);
      }
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth : 0;
      line[i] = (line[i]! + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]!;
      out[o + 1] = line[x * bpp + 1]!;
      out[o + 2] = line[x * bpp + 2]!;
      out[o + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Box-filter downscale to `width × height` (alpha-weighted, so transparent pixels do not darken edges). */
export function resize(img: Image, width: number, height: number): Image {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * img.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * img.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const w = img.data[o + 3]!;
          r += img.data[o]! * w;
          g += img.data[o + 1]! * w;
          b += img.data[o + 2]! * w;
          a += w;
          n++;
        }
      const o = (y * width + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** RGBA PNG (filter 0 on every line; deflate does the work). */
export function encodePng(img: Image): Uint8Array {
  const ihdr = new Uint8Array(13);
  const h = new DataView(ihdr.buffer);
  h.setUint32(0, img.width);
  h.setUint32(4, img.height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(img.height * (img.width * 4 + 1));
  for (let y = 0; y < img.height; y++) {
    raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * (img.width * 4 + 1) + 1);
  }
  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
