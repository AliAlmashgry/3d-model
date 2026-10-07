/* Minimal lossless PNG codec (8-bit, non-interlaced; grey, grey+alpha, RGB,
   RGBA, palette), moved out of occlusion-patch so the checks and the render
   measurements can read the same images without a package. px holds palette
   indices for colour type 3, channel bytes otherwise; every chunk other than
   IDAT is written back unchanged.

   The encoder picks each row's filter by the smallest absolute sum and
   deflates at level 9, so a re-encode of an unchanged map is usually a few
   percent smaller or larger than the exporter's own PNG -- the pixels are
   identical either way. */
import zlib from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
const predict = (f, a, b, c) => (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0);

export function decodePng(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  const chunks = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    chunks.push({ type: buf.toString("latin1", p + 4, p + 8), data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (depth !== 8 || interlace !== 0 || !channels) throw new Error("PNG must be 8-bit and non-interlaced (got depth " + depth + ", colour type " + colorType + ", interlace " + interlace + ")");
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f > 4) throw new Error("bad PNG filter " + f + " on row " + y);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0, b = y ? px[up + x] : 0, c = y && x >= channels ? px[up + x - channels] : 0;
      px[row + x] = (raw[src + x] + predict(f, a, b, c)) & 255;
    }
  }
  const plte = chunks.find((c) => c.type === "PLTE");
  return { width, height, colorType, channels, px, palette: plte ? plte.data : null, chunks };
}

export function encodePng(img) {
  const { width, height, channels, px } = img;
  const stride = width * channels;
  const out = Buffer.alloc((stride + 1) * height);
  const trial = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride, dst = y * (stride + 1);
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) { // per row, the filter with the smallest absolute sum
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? px[row + x - channels] : 0, b = y ? px[up + x] : 0, c = y && x >= channels ? px[up + x - channels] : 0;
        const d = (px[row + x] - predict(f, a, b, c)) & 255;
        trial[x] = d;
        sum += d < 128 ? d : 256 - d;
      }
      if (sum < bestSum) { bestSum = sum; out[dst] = f; trial.copy(out, dst + 1); }
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(type)) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const parts = [PNG_SIGNATURE];
  let wroteData = false;
  for (const c of img.chunks) {
    if (c.type !== "IDAT") { parts.push(chunk(c.type, c.data)); continue; }
    if (!wroteData) { parts.push(chunk("IDAT", zlib.deflateSync(out, { level: 9 }))); wroteData = true; }
  }
  return Buffer.concat(parts);
}

/* R of texel i (palette-aware), 0..255. */
export const readR = (img, i) => (img.palette ? img.palette[img.px[i] * 3] : img.px[i * img.channels]);
/* Bilinear R at (u, v), repeat wrap, glTF's top-left UV origin, 0..1 -- what
   a GPU's linear filter returns at the base mip level. */
export function sampleR(img, u, v) {
  const W = img.width, H = img.height;
  const x = (u - Math.floor(u)) * W - 0.5, y = (v - Math.floor(v)) * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => readR(img, (((yy % H) + H) % H) * W + (((xx % W) + W) % W));
  return ((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy) / 255;
}
