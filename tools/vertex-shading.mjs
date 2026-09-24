#!/usr/bin/env node
/* vertex-shading: give a car body the Camry's shading when its export has no
   occlusion map to carry it -- ray-traced ambient occlusion plus the seam
   lines, baked into vertex colours (COLOR_0).

   History worth keeping: the first Maxima bake (2026-09-17) shipped with
   every seam as TWO parallel lines and was reverted. A vertex colour is not
   prefiltered the way a map is, so its band must be wider than a map's -- but
   the guard meant to spare a panel tucked behind another was unsigned, so it
   also lit the faces INSIDE each gap, and a wide band darkening both skins
   around a lit strip reads as two lines as soon as pixels resolve it (a phone
   at device pixel ratio 3). --seam-behind is now signed against the outward
   side, which the AO pass already picks per vertex, so a gap's own walls stay
   dark. Judge every candidate at BOTH densities: the desktop metrics all
   passed while the phone was wrong.

   The benchmark and the reasoning are tools/occlusion-patch.mjs's: the Camry's
   body reads well because its paint's occlusion map is on (panel luminance 185
   at page size against 204-207 unshaded) and draws each panel gap as a thin
   line (page-scale door-seam contrast 18). That tool patches a map in place.
   The Maxima has no map, no images at all, and every body part carries its own
   overlapping 0-1 UVs, so no single map could hold one; its body is dense
   (347k triangles, support loops a few mm from every panel edge), so the same
   shading is stored per vertex instead. three.js multiplies COLOR_0 into the
   base colour, so the page's silver from CAR_LOOK_PROFILE lands on top.

   Per vertex of the material, shade = ao * seam, written as an 8-bit colour.

     ao    cosine-weighted hemisphere rays against every opaque triangle of the
           model (and, with --ao-ground, a ground plane under the tyres), out
           to --ao-distance mm. Both sides of the surface are tried and the more
           open one kept, so a panel whose normals point inward still reads its
           outside. --ao-strength eases it (1 - s * (1 - ao)), --ao-floor
           clamps it, and --ao-hidden-below t replaces a vertex whose more open
           side is still under t with --ao-hidden-shade (default 0.8): such
           surfaces are enclosed, seen only through the hairline cracks between
           patches of one panel, and baked black they show as dotted lines.

     seam  --seams <part substr,...|all>: the distance in mm from the vertex to
           the nearest triangle of ANOTHER listed part (parts are node names),
           through --curve, exactly as occlusion-patch applies it to texels --
           but NOT with the same numbers. A map is prefiltered (texel minimum,
           dilation, mipmaps), a vertex colour is not, so a line narrower than a
           pixel at page size (~12 mm of car) is hit or missed pixel by pixel
           and reads as DOTS. The curve here is therefore wider and lighter.
           Two guards keep the width from painting blobs: --seam-coarse mm
           fades the seam on vertices whose longest edge is longer than that,
           and --seam-behind ignores a neighbour lying BEHIND the surface (a
           bumper tucked under a quarter panel). Note "behind", signed against
           the outward side: an earlier version suppressed any neighbour along
           the normal, which lit the faces inside every gap and split each
           seam into two parallel lines on a phone.

   Usage:
     node tools/vertex-shading.mjs <in.glb> --report --material <name> --mm-per-unit n [--seams parts] [ao flags]
     node tools/vertex-shading.mjs <in.glb> <out.glb> --material <name> --mm-per-unit n
       [--ao-distance mm --ao-rays n --ao-ground --ao-strength s --ao-floor f --ao-hidden-below t]
       [--seams parts [--curve mm:f,...] [--seam-coarse mm] [--seam-behind]]

   Run it on an UNCOMPRESSED intermediate, before `draco`, so the geometry is
   compressed once with the colours inside (Maxima recipe: seat-split, prune,
   dedup, this, draco). A primitive that already has COLOR_0 is refused, so the
   shading cannot be applied twice. */
import { NodeIO, Accessor, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
const BOOLEAN = new Set(["report", "ao-ground", "seam-behind"]);
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
const num = (k, d) => (flags[k] !== undefined ? Number(flags[k]) : d);
const mmPerUnit = num("mm-per-unit", 0);
if (!inPath || !materialName || !(mmPerUnit > 0) || (!flags.report && !outPath)) {
  console.error("usage: vertex-shading <in.glb> --report --material name --mm-per-unit n [--seams parts] [ao flags]\n       vertex-shading <in.glb> <out.glb> --material name --mm-per-unit n [--ao-distance mm --ao-rays n --ao-ground --ao-strength s --ao-floor f --ao-hidden-below t] [--seams parts [--curve mm:f,...] [--seam-coarse mm] [--seam-behind]]");
  process.exit(2);
}
const aoDistance = num("ao-distance", 0) / mmPerUnit;     // mm -> model units
const aoRays = num("ao-rays", 128);
const aoStrength = num("ao-strength", 1);
const aoFloor = num("ao-floor", 0);
const aoHiddenBelow = num("ao-hidden-below", 0);
const aoHiddenShade = num("ao-hidden-shade", 0.8);
const seamTerms = flags.seams ? flags.seams.split(",").map((s) => s.trim()).filter(Boolean) : null;
const seamParts = (part) => !!seamTerms && (seamTerms.includes("all") || seamTerms.some((s) => part.includes(s)));
const seamCoarse = num("seam-coarse", 0) / mmPerUnit;
/* The seam curve, piecewise linear in mm, 1 beyond the last point. The
   default is the Maxima's, calibrated against the Camry at page size. */
const CURVE = flags.curve ? parseCurve(flags.curve) : [[0, 0.55], [8, 0.55], [16, 1]];
const REACH_MM = CURVE[CURVE.length - 1][0];
function parseCurve(s) {
  const pts = s.split(",").map((p) => p.split(":").map(Number));
  if (pts.length < 2 || pts.some((p) => p.length !== 2 || p.some((n) => Number.isNaN(n))) || pts.some((p, i) => i && p[0] <= pts[i - 1][0])) {
    throw new Error("--curve wants increasing mm:factor pairs, e.g. 0:0.55,8:0.55,16:1");
  }
  return pts;
}
function seamFactor(dmm) {
  if (!(dmm < REACH_MM)) return 1;
  for (let i = 1; i < CURVE.length; i++) {
    const [d0, f0] = CURVE[i - 1], [d1, f1] = CURVE[i];
    if (dmm <= d1) return f0 + ((f1 - f0) * (dmm - d0)) / (d1 - d0);
  }
  return 1;
}
if (!flags.report && !(aoDistance > 0) && !seamTerms) { console.error("nothing to bake: give --ao-distance and/or --seams"); process.exit(2); }

const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const grow = (mn, mx, p) => { for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } };
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const xdir = (m, d) => {
  const v = [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  const l = Math.hypot(v[0], v[1], v[2]);
  return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
const doc = await io.read(inPath);
const root = doc.getRoot();
if (root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression") && !flags.report) {
  console.warn("note: " + inPath + " is Draco-compressed; writing it re-encodes every mesh. Bake on the uncompressed intermediate instead.");
}
const mat = root.listMaterials().find((m) => m.getName() === materialName);
if (!mat) { console.error("no material named " + materialName + " (this file has: " + root.listMaterials().map((m) => m.getName()).join(", ") + ")"); process.exit(1); }

// ---- gather -----------------------------------------------------------------
/* Occluders: every opaque triangle in world space. Targets: every vertex of
   the material's primitives, with its world normal and its part (node name). */
const occ = [];
const targets = [];
const modelMin = [Infinity, Infinity, Infinity], modelMax = [-Infinity, -Infinity, -Infinity];
const seenPrim = new Set();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
    const pm = prim.getMaterial();
    const posAcc = prim.getAttribute("POSITION");
    if (!posAcc) continue;
    const n = posAcc.getCount();
    const P = new Float64Array(n * 3);
    const v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = xform(m, posAcc.getElement(i, v));
      P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2];
      grow(modelMin, modelMax, p);
    }
    const idx = prim.getIndices() ? prim.getIndices().getArray() : null;
    const triCount = idx ? idx.length / 3 : n / 3;
    const corner = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
    const tris = [];
    for (let t = 0; t < triCount; t++) tris.push([corner(t, 0), corner(t, 1), corner(t, 2)]);
    if (!pm || pm.getAlphaMode() !== "BLEND") for (const [a, b, c] of tris) occ.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    if (pm !== mat) continue;
    if (seenPrim.has(prim)) { console.warn("note: a " + materialName + " primitive is instanced twice; shaded under its first node only"); continue; }
    seenPrim.add(prim);
    if (prim.getAttribute("COLOR_0")) { console.error(node.getName() + " already has COLOR_0 -- the shading was baked before; start from the unshaded file"); process.exit(1); }
    const nrmAcc = prim.getAttribute("NORMAL");
    const N = new Float64Array(n * 3);
    if (nrmAcc) for (let i = 0; i < n; i++) { const d = xdir(m, nrmAcc.getElement(i, v)); N[i * 3] = d[0]; N[i * 3 + 1] = d[1]; N[i * 3 + 2] = d[2]; }
    targets.push({ prim, count: n, pos: P, nrm: N, part: node.getName() || mesh.getName() || "?", tris });
  }
}
const occTris = new Float32Array(occ);
const size = Math.max(...modelMax.map((h, k) => h - modelMin[k]));
console.log(inPath + ": " + targets.length + " " + materialName + " primitives, " + targets.reduce((s, t) => s + t.count, 0) + " vertices; " + occTris.length / 9 + " opaque occluder triangles; model " + f3(modelMin) + " -> " + f3(modelMax) + " (" + ((size * mmPerUnit) / 1000).toFixed(2) + " m long)");

// ---- BVH (any-hit) ----------------------------------------------------------
function buildBvh(T) {
  const n = T.length / 9;
  const order = new Uint32Array(n);
  const cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let k = 0; k < 3; k++) cen[i * 3 + k] = (T[i * 9 + k] + T[i * 9 + 3 + k] + T[i * 9 + 6 + k]) / 3;
  }
  const cap = 2 * n + 1;
  const bmin = new Float32Array(cap * 3), bmax = new Float32Array(cap * 3);
  const left = new Int32Array(cap), start = new Int32Array(cap), count = new Int32Array(cap);
  let nodes = 0;
  const stack = [[0, n, nodes++]];
  while (stack.length) {
    const [s, e, id] = stack.pop();
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    let c0 = Infinity, c1 = Infinity, c2 = Infinity, d0 = -Infinity, d1 = -Infinity, d2 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i] * 9;
      for (let c = 0; c < 9; c += 3) {
        const x = T[t + c], y = T[t + c + 1], z = T[t + c + 2];
        if (x < mn0) mn0 = x; if (y < mn1) mn1 = y; if (z < mn2) mn2 = z;
        if (x > mx0) mx0 = x; if (y > mx1) mx1 = y; if (z > mx2) mx2 = z;
      }
      const ci = order[i] * 3;
      if (cen[ci] < c0) c0 = cen[ci]; if (cen[ci + 1] < c1) c1 = cen[ci + 1]; if (cen[ci + 2] < c2) c2 = cen[ci + 2];
      if (cen[ci] > d0) d0 = cen[ci]; if (cen[ci + 1] > d1) d1 = cen[ci + 1]; if (cen[ci + 2] > d2) d2 = cen[ci + 2];
    }
    bmin[id * 3] = mn0; bmin[id * 3 + 1] = mn1; bmin[id * 3 + 2] = mn2;
    bmax[id * 3] = mx0; bmax[id * 3 + 1] = mx1; bmax[id * 3 + 2] = mx2;
    if (e - s <= 4) { left[id] = -1; start[id] = s; count[id] = e - s; continue; }
    const ext = [d0 - c0, d1 - c1, d2 - c2];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const mid = (s + e) >> 1;
    let lo = s, hi = e - 1;
    while (lo < hi) { // quickselect around the median centroid
      const pivot = cen[order[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[order[i] * 3 + axis] < pivot) i++;
        while (cen[order[j] * 3 + axis] > pivot) j--;
        if (i <= j) { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; i++; j--; }
      }
      if (mid <= j) hi = j; else if (mid >= i) lo = i; else break;
    }
    const l = nodes++, r = nodes++;
    left[id] = l; count[id] = 0;
    stack.push([s, mid, l], [mid, e, r]);
  }
  return { T, order, bmin, bmax, left, start, count };
}
const stackBuf = new Int32Array(256);
function occluded(bvh, ox, oy, oz, dx, dy, dz, tmax) {
  const { T, order, bmin, bmax, left, start, count } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let sp = 0;
  stackBuf[sp++] = 0;
  while (sp) {
    const id = stackBuf[--sp];
    let t0 = ((ix >= 0 ? bmin[id * 3] : bmax[id * 3]) - ox) * ix, t1 = ((ix >= 0 ? bmax[id * 3] : bmin[id * 3]) - ox) * ix;
    const ty0 = ((iy >= 0 ? bmin[id * 3 + 1] : bmax[id * 3 + 1]) - oy) * iy, ty1 = ((iy >= 0 ? bmax[id * 3 + 1] : bmin[id * 3 + 1]) - oy) * iy;
    if (ty0 > t0) t0 = ty0; if (ty1 < t1) t1 = ty1;
    const tz0 = ((iz >= 0 ? bmin[id * 3 + 2] : bmax[id * 3 + 2]) - oz) * iz, tz1 = ((iz >= 0 ? bmax[id * 3 + 2] : bmin[id * 3 + 2]) - oz) * iz;
    if (tz0 > t0) t0 = tz0; if (tz1 < t1) t1 = tz1;
    if (t0 > t1 || t1 < 0 || t0 > tmax) continue;
    if (left[id] >= 0) { stackBuf[sp++] = left[id]; stackBuf[sp++] = left[id] + 1; continue; }
    for (let k = start[id], end = start[id] + count[id]; k < end; k++) {
      const t = order[k] * 9; // Moller-Trumbore, both faces
      const ax = T[t], ay = T[t + 1], az = T[t + 2];
      const e1x = T[t + 3] - ax, e1y = T[t + 4] - ay, e1z = T[t + 5] - az;
      const e2x = T[t + 6] - ax, e2y = T[t + 7] - ay, e2z = T[t + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const sx = ox - ax, sy = oy - ay, sz = oz - az;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * inv;
      if (w < 0 || u + w > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > 0 && hit < tmax) return true;
    }
  }
  return false;
}

// ---- ambient occlusion ------------------------------------------------------
const groundY = modelMin[1];
const aoOf = new Map();
if (aoDistance > 0) {
  const t0 = Date.now();
  const bvh = buildBvh(occTris);
  console.log("BVH over " + occTris.length / 9 + " triangles in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  const dirs = []; // cosine-weighted, spiral-stratified
  for (let k = 0; k < aoRays; k++) {
    const u1 = (k + 0.5) / aoRays, phi = k * 2.399963229728653;
    const r = Math.sqrt(u1);
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u1)]);
  }
  const eps = size * 2e-4;
  const openness = (ox, oy, oz, nx, ny, nz, spin) => {
    const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let tx = ny * ax[2] - nz * ax[1], ty = nz * ax[0] - nx * ax[2], tz = nx * ax[1] - ny * ax[0];
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const sx = ox + nx * eps, sy = oy + ny * eps, sz = oz + nz * eps;
    let open = 0;
    for (const [lx0, ly0, lz] of dirs) {
      const lx = lx0 * cs - ly0 * sn, ly = lx0 * sn + ly0 * cs;
      const dx = tx * lx + bx * ly + nx * lz, dy = ty * lx + by * ly + ny * lz, dz = tz * lx + bz * ly + nz * lz;
      if (flags["ao-ground"] && dy < 0 && (sy - groundY) / -dy < aoDistance) continue;
      if (!occluded(bvh, sx, sy, sz, dx, dy, dz, aoDistance)) open++;
    }
    return open / dirs.length;
  };
  let done = 0;
  const total = targets.reduce((s, t) => s + t.count, 0);
  for (const tg of targets) {
    const out = new Float32Array(tg.count);
    out.sign = new Int8Array(tg.count).fill(1);
    for (let i = 0; i < tg.count; i++) {
      const o = i * 3;
      const nx = tg.nrm[o], ny = tg.nrm[o + 1], nz = tg.nrm[o + 2];
      if (!nx && !ny && !nz) { out[i] = 1; continue; }
      const spin = (((i * 2654435761) % 1000) / 1000) * 6.283185307179586;
      let a = openness(tg.pos[o], tg.pos[o + 1], tg.pos[o + 2], nx, ny, nz, spin);
      if (a < 0.5) {
        const flipped = openness(tg.pos[o], tg.pos[o + 1], tg.pos[o + 2], -nx, -ny, -nz, spin);
        // The more open side is the one the camera can see; remember it, the
        // seam test needs to know which way is "behind" this surface.
        if (flipped > a) { a = flipped; out.sign[i] = -1; }
      }
      // Enclosed on both sides: only ever seen through a crack between two
      // patches of a panel, where a baked black shows as a dotted line.
      out[i] = a < aoHiddenBelow ? aoHiddenShade : Math.max(aoFloor, 1 - aoStrength * (1 - a));
    }
    aoOf.set(tg, out);
    done += tg.count;
    process.stdout.write("\r  ao " + Math.round((100 * done) / total) + "%  (" + ((Date.now() - t0) / 1000).toFixed(0) + "s)   ");
  }
  process.stdout.write("\n");
}

// ---- seams ------------------------------------------------------------------
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
  return (p, part, radius) => {
    query++;
    let best = Infinity, bestQ = null;
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
            const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
            if (d < best) { best = d; bestQ = q; }
          }
        }
    return { d: best, q: bestQ };
  };
}
const seamOf = new Map(), sideOf = new Map();
if (seamTerms) {
  const listed = targets.filter((t) => seamParts(t.part));
  const radius = (flags.report ? 40 : REACH_MM) / mmPerUnit;
  const tris = [];
  for (const tg of listed) for (const [a, b, c] of tg.tris) {
    tris.push({ part: tg.part, corners: [a, b, c].map((i) => [tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]]) });
  }
  const nearest = partGrid(tris, radius * 2);
  for (const tg of listed) {
    const out = new Float32Array(tg.count).fill(Infinity);
    const side = new Float32Array(tg.count).fill(1);
    for (let i = 0; i < tg.count; i++) {
      const p = [tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]];
      const { d, q } = nearest(p, tg.part, radius);
      out[i] = d;
      /* Where the nearest other part lies, along the OUTWARD normal: +1 in
         front of the surface, 0 beside it, -1 directly behind. A gap's own
         walls face across the gap, so their neighbour is in front and they
         stay dark -- lighting them is what split every seam into two lines.
         Only a panel tucked BEHIND another (the rear bumper under the quarter
         panel) is suppressed. */
      if (q && d > 0) {
        const ao = aoOf.get(tg);
        const sgn = ao && ao.sign ? ao.sign[i] : 1;
        const n = [tg.nrm[i * 3] * sgn, tg.nrm[i * 3 + 1] * sgn, tg.nrm[i * 3 + 2] * sgn];
        side[i] = ((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / d;
      }
    }
    seamOf.set(tg, out);
    sideOf.set(tg, side);
  }
}
/* --seam-behind: full weight in front of or beside the surface, fading out as
   the neighbour goes behind it (-0.35 to -0.7 of the outward normal). */
const sidewaysWeight = (s) => (!flags["seam-behind"] ? 1 : Math.max(0, Math.min(1, (s + 0.7) / 0.35)));

// ---- report -----------------------------------------------------------------
const byPart = new Map();
for (const tg of targets) { if (!byPart.has(tg.part)) byPart.set(tg.part, []); byPart.get(tg.part).push(tg); }
if (flags.report) {
  console.log("parts of " + materialName + (seamTerms ? " (distance from each vertex to the nearest other listed part, mm)" : "") + ":");
  for (const [part, list] of byPart) {
    const count = list.reduce((s, t) => s + t.count, 0);
    let line = "  " + (seamParts(part) ? "SEAMS " : "      ") + "verts=" + String(count).padStart(6);
    if (seamTerms && seamParts(part)) {
      const ds = [];
      for (const tg of list) for (const d of seamOf.get(tg)) if (d < Infinity) ds.push(d * mmPerUnit);
      ds.sort((a, b) => a - b);
      const pc = (q) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(q * ds.length))].toFixed(1) : "-");
      line += "  near=" + String(ds.length).padStart(6) + "  p5 " + pc(0.05) + "  p25 " + pc(0.25) + "  p50 " + pc(0.5);
    }
    if (aoDistance > 0) {
      let s = 0, n = 0;
      for (const tg of list) for (const a of aoOf.get(tg)) { s += a; n++; }
      line += "  meanAO " + (s / n).toFixed(2);
    }
    console.log(line + "  " + part);
  }
  process.exit(0);
}

// ---- write ------------------------------------------------------------------
const buffer = root.listBuffers()[0];
let dark = 0, total = 0;
for (const tg of targets) {
  const ao = aoOf.get(tg), seam = seamOf.get(tg), side = sideOf.get(tg);
  /* The longest edge touching each vertex: a vertex colour spreads across its
     triangles, so on a coarse patch a seam's dark vertex paints a blob (a
     "dent" at the rear bumper corner). --seam-coarse fades it out there. */
  const longest = new Float32Array(tg.count);
  if (seam && seamCoarse > 0) for (const t of tg.tris) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3];
    const l = Math.hypot(tg.pos[a * 3] - tg.pos[b * 3], tg.pos[a * 3 + 1] - tg.pos[b * 3 + 1], tg.pos[a * 3 + 2] - tg.pos[b * 3 + 2]);
    if (l > longest[a]) longest[a] = l;
    if (l > longest[b]) longest[b] = l;
  }
  const rgb = new Uint8Array(tg.count * 3);
  for (let i = 0; i < tg.count; i++) {
    let sf = seam ? seamFactor(seam[i] * mmPerUnit) : 1;
    if (side) sf = 1 - (1 - sf) * sidewaysWeight(side[i]);
    if (seamCoarse > 0 && longest[i] > seamCoarse) sf = 1 - (1 - sf) * (seamCoarse / longest[i]);
    const shade = (ao ? ao[i] : 1) * sf;
    const b = Math.max(0, Math.min(255, Math.round(shade * 255)));
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = b;
    if (b < 128) dark++;
    total++;
  }
  const acc = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(rgb).setNormalized(true).setBuffer(buffer);
  tg.prim.setAttribute("COLOR_0", acc);
}
await io.write(outPath, doc);
console.log("wrote " + outPath + ": COLOR_0 on " + targets.length + " primitives, " + total + " vertices (" + dark + " below half brightness)");
