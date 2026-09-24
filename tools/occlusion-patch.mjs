#!/usr/bin/env node
/* occlusion-patch: give a car body the Camry's shading -- its baked occlusion
   map switched on, a deleted plate's pocket lifted, and a Camry-like line
   drawn along every panel gap -- editing a finished GLB in place.

   The Camry is the benchmark (measured 2026-09-16, headless Chrome, car about
   400 px wide on the page). Its look is not its colour (CAR_LOOK_PROFILE gives
   every car the same silver), its lighting (one <model-viewer>) or its
   geometry (its paint is 22 separate panel pieces with real 2-3 mm gaps, like
   the Nissans', and dark specks per panel pixel are the same). It is the
   paint's occlusion map:
     - the map is ON, so the silver reads grey against the white page: panel
       luminance 185 on the Camry, 204-207 on the Altima and Sentra, whose
       maps were switched off by mesh-strip's old --drop-occlusion;
     - it draws each seam as a THIN line: in a door close-up (fov 5deg) 1 px
       wide at 55 below the panel, and at page size a door-seam contrast of
       18 that breaks on about 21% of rows. The Nissans' own maps are the same
       kind of bake at the same texel size (5.3 and 4.4 mm against 5.6) with
       no line at all.
   A first fit to the Camry map's AVERAGE shade by distance (x0.55-0.65 out to
   ~1 cm, easing back by 4 cm) produced a 7 px soft band, nothing like it: the
   averages blend its thin dark line with the panel around it. The shipped
   curve was calibrated on the rendered line instead.

   --from-metal-roughness  switch the map on: the paint's metallicRoughness
       texture becomes its occlusionTexture too (Sketchfab packs AO into R).
   --pocket x0,y0,z0,x1,y1,z1  a rear plate sat in a recess pressed into the
       boot lid with its shadow baked in; with the plate deleted it reads as a
       black rectangle. Every triangle of the material centred in the box,
       except those of a dark cluster that crosses the box's edge (a seam
       passing by), is rasterised into the map (two texels of dilation) and
       raised -- never lowered -- to the median of the panel around the box.
   --seams <part substr,...|all> --mm-per-unit n  multiply the map by a curve
       f(d), d = millimetres from the texel's surface point to the nearest
       triangle of ANOTHER listed part (parts are node names, so both sides of
       every gap get it and nothing is drawn inside one panel). Default:
         f = 0.45 up to 3 mm, easing to 1 at 6 mm
       -- on the Altima and Sentra a door-seam contrast of 20-22 at page size
       (4-7% of rows broken) and a 3 px line at 41-43 below the panel close
       up. Each texel takes the smallest factor of any triangle under it with
       one texel of dilation; without the dilation the edge texels stay light
       and the line fades to 9-15. A wider or deeper curve (a faint shoulder
       out to 4 cm, or 0.3 at the core) only overshoots the Camry.
       --curve "mm:factor,..." replaces it; --profile-scale s deepens (s > 1)
       or lightens (s < 1) it: f' = 1 - s * (1 - f).
   --seam-behind  ignore a neighbour lying BEHIND the surface, along its
       outward (vertex) normal: full weight in front of or beside it, fading
       out from -0.35 to -0.7 of the normal. Without it the band also traces
       any other part within reach UNDER the skin -- on the Altima the body's
       flange behind each front door's leading edge, which drew a second, wavy
       line down the door that hooked into a smudge at the sill (the "crease"
       reported 2026-09-17). A gap's own walls face across the gap, so their
       neighbour is beside or in front and they stay dark. The band then takes
       the strongest factor over every neighbour in reach, not the factor of
       the single nearest one, so a hidden flange closer than the real gap
       wall cannot hide that wall's line. Same rule as vertex-shading's flag.
   --reset-specular  drop KHR_materials_specular from the material, so it
       reflects like the Camry's paint (the Sentra's carried 0.126).
   --report  dark clusters (to place a pocket box), each part's gap
       percentiles in mm, and the map's shade by distance from the nearest
       other part beside the Camry's averages (a diagnostic only, see above).

   Known limit: switching the Sentra's own map on adds some isolated dark
   specks at page size (4.6 per 1000 panel pixels against 3.5 without it; the
   Camry has 3.1). They are fine detail inside Sentra's bake on visible
   panels -- not the seam line, the specular reset, its door-handle panels or
   inward-facing paint, each tested -- and the map is what gives the Camry's
   panel tone, so they are accepted.

   In place: the geometry is decoded (Draco included) only to measure, and the
   GLB is rewritten at the byte level -- one image swapped, one material entry
   edited -- so meshes stay byte for byte. Only R changes in the map (glTF
   reads occlusion from R, roughness/metal from G/B); palette entries keep
   their G and B. The PNG is re-encoded losslessly.

   Usage:
     node tools/occlusion-patch.mjs <in.glb> --report --material <name> [--from-metal-roughness] [--seams parts --mm-per-unit n] [--pocket box]
     node tools/occlusion-patch.mjs <in.glb> <out.glb> --material <name> [--from-metal-roughness] [--pocket box]
       [--seams parts --mm-per-unit n [--curve mm:f,...] [--profile-scale s] [--seam-behind]] [--reset-specular] [--force]
     node tools/occlusion-patch.mjs <in.glb> <out.glb> --material <name> --reset-specular   (specular only)

   Run once per file: a material that already has an occlusion map is refused
   for --pocket or --seams (a second pass would darken the band again) unless
   --force. Done at build time, not at load: changing a map through
   model-viewer's material API costs a material recompile that kept the
   loading overlay up about six seconds on a software renderer. */
import fs from "node:fs";
import zlib from "node:zlib";
import { NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
const BOOLEAN = new Set(["report", "from-metal-roughness", "reset-specular", "force", "seam-behind"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (BOOLEAN.has(key)) { flags[key] = true; continue; }
    flags[key] = argv[++i];
  } else positional.push(a);
}
const [inPath, outPath] = positional;
const materialName = flags.material;
if (!inPath || !materialName || (!flags.report && !outPath)) {
  console.error("usage: occlusion-patch <in.glb> --report --material name [--from-metal-roughness] [--seams parts --mm-per-unit n] [--pocket box]\n       occlusion-patch <in.glb> <out.glb> --material name [--from-metal-roughness] [--pocket box] [--seams parts --mm-per-unit n [--profile-scale s] [--seam-behind]] [--reset-specular] [--force]");
  process.exit(2);
}
const pocket = flags.pocket ? parseBox(flags.pocket) : null;
const seamTerms = flags.seams ? flags.seams.split(",").map((s) => s.trim()).filter(Boolean) : null;
const seamParts = (part) => !!seamTerms && (seamTerms.includes("all") || seamTerms.some((s) => part.includes(s)));
const mmPerUnit = flags["mm-per-unit"] !== undefined ? Number(flags["mm-per-unit"]) : null;
const profileScale = flags["profile-scale"] !== undefined ? Number(flags["profile-scale"]) : 1;
if (seamTerms && !(mmPerUnit > 0)) { console.error("--seams needs --mm-per-unit (real car length in mm / model length in file units)"); process.exit(2); }
if (!(profileScale > 0)) { console.error("--profile-scale wants a positive number"); process.exit(2); }
const DARK = 0.25;

/* The seam curve: factor against the open panel by distance (mm) from the
   neighbouring panel, piecewise linear, 1 beyond the last point. --curve
   "mm:factor,mm:factor,..." replaces the default. */
const CAMRY_CURVE = flags.curve ? parseCurve(flags.curve) : [[0, 0.45], [3, 0.45], [6, 1]];
const CAMRY_REACH_MM = CAMRY_CURVE[CAMRY_CURVE.length - 1][0];
function parseCurve(s) {
  const pts = s.split(",").map((p) => p.split(":").map(Number));
  if (pts.length < 2 || pts.some((p) => p.length !== 2 || p.some((n) => Number.isNaN(n))) || pts.some((p, i) => i && p[0] <= pts[i - 1][0])) {
    throw new Error("--curve wants increasing mm:factor pairs, e.g. 0:0.45,3:0.45,6:1");
  }
  return pts;
}
function camryFactor(dmm) {
  if (!(dmm < CAMRY_REACH_MM)) return 1;
  let f = 1;
  for (let i = 1; i < CAMRY_CURVE.length; i++) {
    const [d0, f0] = CAMRY_CURVE[i - 1], [d1, f1] = CAMRY_CURVE[i];
    if (dmm <= d1) { f = f0 + ((f1 - f0) * (dmm - d0)) / (d1 - d0); break; }
  }
  return Math.max(0, 1 - profileScale * (1 - f));
}
/* --report: the map's profile by distance from the nearest other part, in
   the buckets the Camry was sampled with. Only a diagnostic: the Camry's
   averages (below) blend its thin dark line with the panel around it, and
   fitting them gave a 7 px soft band instead of its 1 px line. */
const PROFILE_REACH_MM = 40;
const PROFILE_EDGES = [1, 2, 3, 4, 6, 8, 12, 20, 40];
const PROFILE_LABELS = ["<1 mm", "1-2", "2-3", "3-4", "4-6", "6-8", "8-12", "12-20", "20-40", ">=40 (open)"];
const CAMRY_RATIOS = [0.46, 0.62, 0.54, 0.51, 0.58, 0.59, 0.68, 0.76, 0.94, 1];

function parseBox(s) {
  const v = s.split(",").map(Number);
  if (v.length !== 6 || v.some((n) => Number.isNaN(n))) throw new Error("--pocket wants six numbers: x0,y0,z0,x1,y1,z1");
  return { min: [Math.min(v[0], v[3]), Math.min(v[1], v[4]), Math.min(v[2], v[5])], max: [Math.max(v[0], v[3]), Math.max(v[1], v[4]), Math.max(v[2], v[5])] };
}
const within = (b, p) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
const grow = (mn, mx, p) => { for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } };
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
/* A direction (a normal) through the matrix's linear part, renormalised.
   Right for the rotation + uniform scale (mirrors included) these exports use;
   a non-uniform scale would want the inverse transpose. */
const xformDir = (m, n) => {
  const r = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
  const len = Math.hypot(r[0], r[1], r[2]) || 1;
  return [r[0] / len, r[1] / len, r[2] / len];
};
const f5 = (v) => "[" + v.map((n) => n.toFixed(5)).join(", ") + "]";

// ---- GLB container ----------------------------------------------------------
function readGlb(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(path + " is not a binary glTF");
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const bin = binStart < buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  return { json, bin };
}
const viewBytes = (glb, i) => {
  const bv = glb.json.bufferViews[i];
  return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
};
/* Rewrites the BIN chunk view by view in their original order, swapping in
   the replacement bytes, each view starting on a 4-byte boundary. */
function writeGlb(path, glb, replacements) {
  const order = glb.json.bufferViews.map((bv, i) => i).filter((i) => (glb.json.bufferViews[i].buffer || 0) === 0)
    .sort((a, b) => (glb.json.bufferViews[a].byteOffset || 0) - (glb.json.bufferViews[b].byteOffset || 0));
  const parts = [];
  let offset = 0;
  for (const i of order) {
    const bytes = replacements.get(i) || viewBytes(glb, i);
    const padding = (4 - (offset % 4)) % 4;
    if (padding) { parts.push(Buffer.alloc(padding)); offset += padding; }
    glb.json.bufferViews[i].byteOffset = offset;
    glb.json.bufferViews[i].byteLength = bytes.byteLength;
    parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    offset += bytes.byteLength;
  }
  const tail = (4 - (offset % 4)) % 4;
  if (tail) parts.push(Buffer.alloc(tail));
  const bin = Buffer.concat(parts);
  glb.json.buffers[0].byteLength = offset;
  let json = Buffer.from(JSON.stringify(glb.json), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHead = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  fs.writeFileSync(path, Buffer.concat([header, chunkHead(json.length, 0x4e4f534a), json, chunkHead(bin.length, 0x004e4942), bin]));
}

// ---- PNG codec --------------------------------------------------------------
/* Minimal codec (8-bit, non-interlaced; grey, grey+alpha, RGB, RGBA, palette)
   so the map is edited without a lossy round trip or a new package. px holds
   palette indices for colour type 3, channel bytes otherwise; every chunk
   other than IDAT is written back unchanged. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
const predict = (f, a, b, c) => (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0);
function decodePng(bytes) {
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
function encodePng(img) {
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
const readR = (img, i) => (img.palette ? img.palette[img.px[i] * 3] : img.px[i * img.channels]);
const texelAt = (img, u, v) => Math.min(img.height - 1, Math.floor((v - Math.floor(v)) * img.height)) * img.width + Math.min(img.width - 1, Math.floor((u - Math.floor(u)) * img.width));
/* Sets R of texel i to (about) value, keeping G, B and alpha: palette images
   take the entry nearest the target among those with the texel's own G and B. */
function makeWriter(img) {
  const nearest = new Map();
  return (i, value) => {
    const target = Math.max(0, Math.min(255, Math.round(value)));
    if (!img.palette) { img.px[i * img.channels] = target; return; }
    const pal = img.palette, cur = img.px[i], g = pal[cur * 3 + 1], b = pal[cur * 3 + 2];
    const key = (g * 256 + b) * 256 + target;
    let best = nearest.get(key);
    if (best === undefined) {
      let bestD = Infinity;
      for (let e = 0; e < pal.length / 3; e++) {
        if (pal[e * 3 + 1] !== g || pal[e * 3 + 2] !== b) continue;
        const d = Math.abs(pal[e * 3] - target);
        if (d < bestD) { bestD = d; best = e; }
      }
      nearest.set(key, best);
    }
    if (best !== undefined) img.px[i] = best;
  };
}

// ---- geometry helpers -------------------------------------------------------
/* Visits every texel whose centre lies within `dilate` texels of the UV
   triangle, passing the (clamped) barycentric weights of that centre. */
function rasterize(uvs, W, H, dilate, visit) {
  const su = Math.floor(Math.min(uvs[0][0], uvs[1][0], uvs[2][0]));
  const sv = Math.floor(Math.min(uvs[0][1], uvs[1][1], uvs[2][1]));
  const P = uvs.map(([u, v]) => [(u - su) * W, (v - sv) * H]);
  const det = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
  const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]) - dilate)), x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0]) + dilate));
  const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]) - dilate)), y1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1]) + dilate));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const qx = x + 0.5, qy = y + 0.5;
    if (distToTriangle(qx, qy, P) > dilate) continue;
    let w = [1 / 3, 1 / 3, 1 / 3];
    if (Math.abs(det) > 1e-12) {
      const b1 = ((qx - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (qy - P[0][1])) / det;
      const b2 = ((P[1][0] - P[0][0]) * (qy - P[0][1]) - (qx - P[0][0]) * (P[1][1] - P[0][1])) / det;
      const c = [Math.max(0, 1 - b1 - b2), Math.max(0, b1), Math.max(0, b2)];
      const s = c[0] + c[1] + c[2] || 1;
      w = [c[0] / s, c[1] / s, c[2] / s];
    }
    visit(y * W + x, w);
  }
}
function distToTriangle(qx, qy, [a, b, c]) {
  const side = (p, r) => (r[0] - p[0]) * (qy - p[1]) - (r[1] - p[1]) * (qx - p[0]);
  const d1 = side(a, b), d2 = side(b, c), d3 = side(c, a);
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
  const seg = (p, r) => {
    const dx = r[0] - p[0], dy = r[1] - p[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((qx - p[0]) * dx + (qy - p[1]) * dy) / len)) : 0;
    return Math.hypot(qx - p[0] - t * dx, qy - p[1] - t * dy);
  };
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}
function closestOnTriangle(p, a, b, c) { // Ericson, Real-Time Collision Detection 5.1.5
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (o, u, s) => [o[0] + u[0] * s, o[1] + u[1] * s, o[2] + u[2] * s];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  return [a[0] + ab[0] * vb * den + ac[0] * vc * den, a[1] + ab[1] * vb * den + ac[1] * vc * den, a[2] + ab[2] * vb * den + ac[2] * vc * den];
}
/* A uniform grid over triangles answering "how far is p from the nearest
   triangle of a DIFFERENT part", out to a radius. */
function partGrid(list, cell) {
  const cells = new Map();
  const key = (x, y, z) => x + "," + y + "," + z;
  list.forEach((t, i) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of t.corners) grow(mn, mx, p);
    for (let x = Math.floor(mn[0] / cell); x <= Math.floor(mx[0] / cell); x++)
      for (let y = Math.floor(mn[1] / cell); y <= Math.floor(mx[1] / cell); y++)
        for (let z = Math.floor(mn[2] / cell); z <= Math.floor(mx[2] / cell); z++) {
          const k = key(x, y, z);
          let arr = cells.get(k);
          if (!arr) cells.set(k, (arr = []));
          arr.push(i);
        }
  });
  const stamp = new Int32Array(list.length);
  let query = 0;
  /* Calls visit(q, d) with the closest point q on each triangle of another
     part in reach (each triangle once). */
  const each = (p, part, radius, visit) => {
    query++;
    for (let x = Math.floor((p[0] - radius) / cell); x <= Math.floor((p[0] + radius) / cell); x++)
      for (let y = Math.floor((p[1] - radius) / cell); y <= Math.floor((p[1] + radius) / cell); y++)
        for (let z = Math.floor((p[2] - radius) / cell); z <= Math.floor((p[2] + radius) / cell); z++) {
          const arr = cells.get(key(x, y, z));
          if (!arr) continue;
          for (const i of arr) {
            if (stamp[i] === query) continue;
            stamp[i] = query;
            const t = list[i];
            if (t.part === part) continue;
            const q = closestOnTriangle(p, t.corners[0], t.corners[1], t.corners[2]);
            visit(q, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
          }
        }
  };
  const nearest = (p, part, radius) => {
    let best = Infinity;
    each(p, part, radius, (q, d) => { if (d < best) best = d; });
    return best;
  };
  nearest.each = each;
  return nearest;
}
// Joins triangles that share a corner (welded at quantum q) into clusters.
function clusterByCorners(list, q) {
  q = q || 1e-9;
  const parent = new Int32Array(list.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byCorner = new Map();
  list.forEach((t, i) => {
    for (const p of t.corners) {
      const k = Math.round(p[0] / q) + "," + Math.round(p[1] / q) + "," + Math.round(p[2] / q);
      const j = byCorner.get(k);
      if (j === undefined) byCorner.set(k, i); else { const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb; }
    }
  });
  const out = new Map();
  list.forEach((t, i) => {
    const r = find(i);
    let cl = out.get(r);
    if (!cl) out.set(r, (cl = { n: 0, ao: 0, members: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    cl.n++; cl.ao += t.ao; cl.members.push(t);
    for (const p of t.corners) grow(cl.min, cl.max, p);
  });
  return [...out.values()];
}
const clusterInside = (cl, box) => cl.min.every((m, k) => m >= box.min[k]) && cl.max.every((m, k) => m <= box.max[k]);
const clusterTouches = (cl, box) => cl.min.every((m, k) => m <= box.max[k]) && cl.max.every((m, k) => m >= box.min[k]);

// ---- material and map -------------------------------------------------------
const glb = readGlb(inPath);
const matIndex = glb.json.materials.findIndex((m) => m.name === materialName);
if (matIndex < 0) { console.error("no material named " + materialName + " (this file has: " + glb.json.materials.map((m) => m.name).join(", ") + ")"); process.exit(1); }
const matJson = glb.json.materials[matIndex];
const mrInfo = matJson.pbrMetallicRoughness && matJson.pbrMetallicRoughness.metallicRoughnessTexture;
let occInfo = matJson.occlusionTexture;
let reenabled = false;
if (occInfo && !flags.report && (pocket || seamTerms) && !flags.force) {
  console.error("material " + materialName + " already has an occlusion map -- it was probably patched before, and a second pass darkens the seam band again. Start from the unpatched file, or pass --force.");
  process.exit(1);
}
const specularOnly = !occInfo && !flags.report && !pocket && !seamTerms && !flags["from-metal-roughness"] && flags["reset-specular"];
if (!occInfo && !specularOnly) {
  if (!flags["from-metal-roughness"] || !mrInfo) {
    console.error("material " + materialName + " has no occlusion map" + (mrInfo ? "; pass --from-metal-roughness to use its metallicRoughness texture's R" : " and no metallicRoughness texture to take one from"));
    process.exit(1);
  }
  occInfo = { index: mrInfo.index, ...(mrInfo.texCoord ? { texCoord: mrInfo.texCoord } : {}) };
  reenabled = true;
}
/* Drops KHR_materials_specular from the material; the extension stays listed
   while any other material still uses it. Returns whether anything changed. */
function resetSpecular() {
  if (!(matJson.extensions && matJson.extensions.KHR_materials_specular)) { console.log("material " + materialName + " has no KHR_materials_specular to reset"); return false; }
  delete matJson.extensions.KHR_materials_specular;
  if (!Object.keys(matJson.extensions).length) delete matJson.extensions;
  const stillUsed = glb.json.materials.some((m) => m.extensions && m.extensions.KHR_materials_specular);
  if (!stillUsed) for (const list of ["extensionsUsed", "extensionsRequired"]) {
    if (glb.json[list]) { glb.json[list] = glb.json[list].filter((e) => e !== "KHR_materials_specular"); if (!glb.json[list].length) delete glb.json[list]; }
  }
  console.log("material " + materialName + ": KHR_materials_specular removed (reflects like the Camry's paint)" + (stillUsed ? "; other materials still use the extension" : ""));
  return true;
}
if (specularOnly) {
  if (!resetSpecular()) { console.error("nothing to do"); process.exit(1); }
  writeGlb(outPath, glb, new Map());
  console.log("wrote " + outPath + " (" + fs.statSync(outPath).size + " bytes)");
  process.exit(0);
}
const imageIndex = glb.json.textures[occInfo.index].source;
const imageJson = glb.json.images[imageIndex];
if (imageJson.mimeType !== "image/png" || imageJson.bufferView === undefined) { console.error("the occlusion map is " + (imageJson.mimeType || imageJson.uri) + "; only an embedded PNG can be patched losslessly"); process.exit(1); }
const usesImage = (info) => info && glb.json.textures[info.index].source === imageIndex;
const colourUsers = glb.json.materials.filter((m) => usesImage(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture) || usesImage(m.emissiveTexture));
if (colourUsers.length) { console.error("the map is also a colour map on " + colourUsers.map((m) => m.name).join(", ") + "; patching R would change its colour"); process.exit(1); }
const img = decodePng(viewBytes(glb, imageJson.bufferView));
if (img.channels < 3 && !img.palette && glb.json.materials.some((m) => usesImage(m.pbrMetallicRoughness && m.pbrMetallicRoughness.metallicRoughnessTexture))) {
  console.error("the map is a grey PNG shared with metallicRoughness; R cannot change alone"); process.exit(1);
}
console.log(inPath + ": material " + materialName + ", occlusion map " + img.width + "x" + img.height + " PNG colour type " + img.colorType + (reenabled ? " (re-enabled from metallicRoughness)" : ""));

// ---- gather triangles -------------------------------------------------------
/* Decoded only to measure; nothing read here is written back. Nearest texel at
   the centroid UV, repeat wrap, glTF's top-left UV origin. */
const tris = [];
{
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
  const doc = await io.read(inPath);
  const mat = doc.getRoot().listMaterials()[matIndex];
  const uvSet = occInfo.texCoord || 0;
  const v = [0, 0, 0], w = [0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial() !== mat || prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const pos = prim.getAttribute("POSITION"), uv = prim.getAttribute("TEXCOORD_" + uvSet), nrm = prim.getAttribute("NORMAL");
      if (!pos || !uv) continue;
      if (flags["seam-behind"] && !nrm) { console.error("--seam-behind needs vertex normals, and a " + materialName + " primitive on " + (node.getName() || mesh.getName()) + " has none"); process.exit(1); }
      const idx = prim.getIndices();
      const arr = idx ? idx.getArray() : null;
      const n = arr ? arr.length : pos.getCount();
      for (let i = 0; i < n; i += 3) {
        const corners = [], uvs = [], c = [0, 0, 0];
        let cu = 0, cv = 0;
        const normals = nrm ? [] : null;
        for (let k = 0; k < 3; k++) {
          const vi = arr ? arr[i + k] : i + k;
          const p = xform(m, pos.getElement(vi, v));
          corners.push(p);
          c[0] += p[0] / 3; c[1] += p[1] / 3; c[2] += p[2] / 3;
          const t = uv.getElement(vi, w);
          uvs.push([t[0], t[1]]);
          cu += t[0] / 3; cv += t[1] / 3;
          if (nrm) normals.push(xformDir(m, nrm.getElement(vi, [0, 0, 0])));
        }
        tris.push({ corners, uvs, normals, c, ao: readR(img, texelAt(img, cu, cv)) / 255, part: node.getName() || mesh.getName() || "?" });
      }
    }
  }
  console.log(tris.length + " triangles use " + materialName + " (TEXCOORD_" + uvSet + ")");
}
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const t of tris) for (const p of t.corners) grow(lo, hi, p);
const modelSize = Math.max(...hi.map((h, k) => h - lo[k]));
const clusters = clusterByCorners(tris.filter((t) => t.ao < DARK), modelSize / 20000);

/* The pocket: triangles centred in the box, minus dark clusters crossing its
   edge; the fill is the median AO of the material's triangles in the box grown
   by its largest side, outside the box itself. */
function planPocket(box) {
  const passing = new Set(clusters.filter((cl) => clusterTouches(cl, box) && !clusterInside(cl, box)).flatMap((cl) => cl.members));
  const inside = tris.filter((t) => within(box, t.c) && !passing.has(t));
  const g = Math.max(...box.max.map((m, k) => m - box.min[k]));
  const grown = { min: box.min.map((m) => m - g), max: box.max.map((m) => m + g) };
  const ring = tris.filter((t) => !within(box, t.c) && within(grown, t.c)).map((t) => t.ao).sort((a, b) => a - b);
  const fill = ring.length ? ring[ring.length >> 1] : 1;
  const texels = new Set();
  for (const t of inside) rasterize(t.uvs, img.width, img.height, 2, (i) => { if (readR(img, i) < fill * 255) texels.add(i); });
  return { inside, ringCount: ring.length, fill, texels };
}

/* The seam band: for every texel under a listed part's triangle near another
   listed part, the Camry factor of its surface point; the smallest wins. */
/* --seam-behind: full weight in front of or beside the surface, fading out as
   the neighbour goes behind it (-0.35 to -0.7 of the outward normal). */
const behind = !!flags["seam-behind"];
const sidewaysWeight = (s) => Math.max(0, Math.min(1, (s + 0.7) / 0.35));
function planSeams() {
  const listed = tris.filter((t) => seamParts(t.part));
  const reach = CAMRY_REACH_MM / mmPerUnit;
  const nearest = partGrid(listed, reach * 2);
  const factor = new Map();
  let near = 0;
  for (const t of listed) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of t.corners) grow(mn, mx, p);
    const centre = mn.map((m, k) => (m + mx[k]) / 2);
    const span = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 + reach;
    if (nearest(centre, t.part, span) >= span) continue;
    near++;
    rasterize(t.uvs, img.width, img.height, 1, (i, w) => {
      const p = [0, 1, 2].map((k) => w[0] * t.corners[0][k] + w[1] * t.corners[1][k] + w[2] * t.corners[2][k]);
      let f;
      if (behind) {
        // Outward normal at the texel; every neighbour in reach is weighed by
        // where it lies along it, and the strongest (darkest) factor wins.
        const n = [0, 1, 2].map((k) => w[0] * t.normals[0][k] + w[1] * t.normals[1][k] + w[2] * t.normals[2][k]);
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        f = 1;
        nearest.each(p, t.part, reach, (q, d) => {
          if (!(d < reach)) return;
          const side = d > 0 ? ((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / (d * len) : 0;
          const weight = sidewaysWeight(side);
          if (weight <= 0) return;
          const g = 1 - weight * (1 - camryFactor(d * mmPerUnit));
          if (g < f) f = g;
        });
        if (f >= 1) return;
      } else {
        const d = nearest(p, t.part, reach);
        if (!(d < reach)) return;
        f = camryFactor(d * mmPerUnit);
      }
      const prev = factor.get(i);
      if (prev === undefined || f < prev) factor.set(i, f);
    });
  }
  return { factor, near, listed: listed.length };
}

/* The map's profile by distance from the nearest other part, as ratios to its
   open panel -- the same buckets the Camry was measured with. */
function profile() {
  const nearest = partGrid(tris, (PROFILE_REACH_MM / mmPerUnit) * 2);
  const sum = new Array(10).fill(0), cnt = new Array(10).fill(0);
  tris.forEach((t, ti) => {
    for (let s = 0; s < 6; s++) {
      let r1 = ((ti * 7 + s * 13) % 97) / 97, r2 = ((ti * 11 + s * 29) % 89) / 89;
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const r0 = 1 - r1 - r2;
      const p = [0, 1, 2].map((k) => r0 * t.corners[0][k] + r1 * t.corners[1][k] + r2 * t.corners[2][k]);
      const u = r0 * t.uvs[0][0] + r1 * t.uvs[1][0] + r2 * t.uvs[2][0], v = r0 * t.uvs[0][1] + r1 * t.uvs[1][1] + r2 * t.uvs[2][1];
      const dmm = nearest(p, t.part, PROFILE_REACH_MM / mmPerUnit) * mmPerUnit;
      let b = 9;
      for (let i = 0; i < 9; i++) if (dmm < PROFILE_EDGES[i]) { b = i; break; }
      sum[b] += readR(img, texelAt(img, u, v)) / 255;
      cnt[b]++;
    }
  });
  const open = sum[9] / cnt[9];
  return PROFILE_LABELS.map((label, i) => ({ label, n: cnt[i], mean: cnt[i] ? sum[i] / cnt[i] : NaN, ratio: cnt[i] ? sum[i] / cnt[i] / open : NaN, camry: CAMRY_RATIOS[i] }));
}

// ---- report -----------------------------------------------------------------
if (flags.report) {
  console.log("material bounds " + f5(lo) + " -> " + f5(hi));
  const listed = clusters.filter((cl) => !pocket || clusterTouches(cl, pocket)).sort((a, b) => b.n - a.n);
  console.log("dark clusters (centroid AO < " + DARK + "): " + clusters.length + (pocket ? ", " + listed.length + " touching the pocket" : ", largest first"));
  for (const cl of listed.slice(0, pocket ? 30 : 12)) {
    console.log("  " + (pocket ? (clusterInside(cl, pocket) ? "POCKET " : "   -   ") : "") + "tris=" + String(cl.n).padStart(5) + "  meanAO=" + (cl.ao / cl.n).toFixed(2) + "  bounds " + f5(cl.min) + " -> " + f5(cl.max));
  }
  if (pocket) {
    const plan = planPocket(pocket);
    console.log("pocket " + f5(pocket.min) + " -> " + f5(pocket.max) + ": " + plan.inside.length + " triangles, fill " + plan.fill.toFixed(3) + " (median of " + plan.ringCount + " around it), would lift " + plan.texels.size + " texels");
  }
  if (mmPerUnit) {
    const parts = [...new Set(tris.map((t) => t.part))];
    const nearest = partGrid(tris, (PROFILE_REACH_MM / mmPerUnit) * 2);
    console.log("parts (distance from each part's corners to the nearest other part, mm):");
    for (const part of parts) {
      const own = tris.filter((t) => t.part === part);
      const ds = [];
      for (const t of own) for (const p of t.corners) { const d = nearest(p, part, PROFILE_REACH_MM / mmPerUnit); if (d < Infinity) ds.push(d * mmPerUnit); }
      ds.sort((a, b) => a - b);
      const pc = (q) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(q * ds.length))].toFixed(1) : "-");
      console.log("  " + (seamParts(part) ? "SEAMS " : "      ") + "tris=" + String(own.length).padStart(6) + "  corners within 40 mm=" + String(ds.length).padStart(6) + "  p5 " + pc(0.05) + "  p25 " + pc(0.25) + "  p50 " + pc(0.5) + "  " + part);
    }
    console.log("map profile by distance from the nearest other part (ratio to the open panel), Camry averages beside it (diagnostic only):");
    for (const r of profile()) console.log("  " + r.label.padEnd(12) + " samples " + String(r.n).padStart(6) + "  mean " + (isNaN(r.mean) ? "  - " : r.mean.toFixed(2)) + "  ratio " + (isNaN(r.ratio) ? "  - " : r.ratio.toFixed(2)) + "  | Camry " + r.camry.toFixed(2));
  }
  process.exit(0);
}

// ---- patch and write --------------------------------------------------------
const replacements = new Map();
let mapChanged = false;
if (pocket) {
  const plan = planPocket(pocket);
  if (!plan.inside.length) { console.error("no " + materialName + " triangle is inside the pocket -- writing nothing (run --report)"); process.exit(1); }
  const write = makeWriter(img);
  let lifted = 0;
  for (const i of plan.texels) { const before = readR(img, i); write(i, plan.fill * 255); if (readR(img, i) > before) lifted++; }
  mapChanged = true;
  console.log("pocket: " + plan.inside.length + " triangles, " + lifted + " texels lifted to AO " + plan.fill.toFixed(3) + " (median of " + plan.ringCount + " triangles around it)");
}
if (seamTerms) {
  const t0 = Date.now();
  const { factor, near, listed } = planSeams();
  const write = makeWriter(img);
  let darkened = 0;
  for (const [i, f] of factor) { const before = readR(img, i); write(i, before * f); if (readR(img, i) < before) darkened++; }
  mapChanged = true;
  console.log("seams: " + listed + " listed triangles, " + near + " within " + CAMRY_REACH_MM + " mm of another part, " + factor.size + " texels in the band, " + darkened + " darkened by the seam curve" + (profileScale !== 1 ? " x" + profileScale : "") + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
if (mapChanged) {
  const before = viewBytes(glb, imageJson.bufferView).byteLength;
  const png = encodePng(img);
  replacements.set(imageJson.bufferView, png);
  console.log("map PNG " + before + " -> " + png.length + " bytes");
}
if (reenabled) {
  matJson.occlusionTexture = occInfo;
  console.log("material " + materialName + " now uses texture " + occInfo.index + " as its occlusion map");
}
const specularReset = flags["reset-specular"] ? resetSpecular() : false;
if (!mapChanged && !reenabled && !specularReset) { console.error("nothing to do"); process.exit(1); }
writeGlb(outPath, glb, replacements);
console.log("wrote " + outPath + " (" + fs.statSync(outPath).size + " bytes)");
