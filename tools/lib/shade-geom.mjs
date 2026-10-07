/* Geometry shared by the two shading tools (occlusion-patch, vertex-shading)
   and their self-checks: world transforms, closest point on a triangle, a
   "nearest triangle of ANOTHER part" grid, a BVH with any-hit (AO) and
   closest-hit (the checks' straight-down view of a seam), what a part is
   when two nodes share a name, the parts list behind --seams auto, and the
   model scale behind --car-length-mm.

   Everything here was in one or both tools before and is moved, not changed:
   the AO BVH, the Moller-Trumbore test and the grid are byte-for-byte the
   ones the Maxima was baked with, so the same flags give the same colours. */

export const grow = (mn, mx, p) => { for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } };
export const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
/* A direction (a normal) through the matrix's linear part, renormalised.
   Right for the rotation + uniform scale (mirrors included) these exports use;
   a non-uniform scale would want the inverse transpose. */
export const xformDir = (m, n) => {
  const r = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
  const len = Math.hypot(r[0], r[1], r[2]);
  return len ? [r[0] / len, r[1] / len, r[2] / len] : [0, 0, 0];
};
export const triArea = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
};

export function closestOnTriangle(p, a, b, c) { // Ericson, Real-Time Collision Detection 5.1.5
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

/* A uniform grid over triangles ({corners, part}) answering "how far is p
   from the nearest triangle of a DIFFERENT part", out to a radius.
     nearest(p, part, radius)          -> distance (Infinity if none)
     nearest.closest(p, part, radius)  -> { d, q } with the closest point
     nearest.each(p, part, radius, visit(q, d, tri)) -> every triangle once */
const BIG_CELLS = 65536;
export function partGrid(list, cell) {
  const cells = new Map();
  const key = (x, y, z) => x + "," + y + "," + z;
  /* A triangle spanning more than BIG_CELLS cells (the Maxima's paint has
     underbody sheets metres across, which at a 4 mm cell overflowed a Map) is
     kept aside and tried on every query instead: same answers, bounded memory.
     At the tools' own cell sizes (twice the curve's reach) no car has one. */
  const big = [];
  list.forEach((t, i) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of t.corners) grow(mn, mx, p);
    const span = (Math.floor(mx[0] / cell) - Math.floor(mn[0] / cell) + 1) * (Math.floor(mx[1] / cell) - Math.floor(mn[1] / cell) + 1) * (Math.floor(mx[2] / cell) - Math.floor(mn[2] / cell) + 1);
    if (span > BIG_CELLS) { big.push(i); return; }
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
  const each = (p, part, radius, visit) => {
    query++;
    for (const i of big) {
      stamp[i] = query;
      const t = list[i];
      if (t.part === part) continue;
      const q = closestOnTriangle(p, t.corners[0], t.corners[1], t.corners[2]);
      visit(q, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), t);
    }
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
            visit(q, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), t);
          }
        }
  };
  const closest = (p, part, radius) => {
    let best = Infinity, bestQ = null;
    each(p, part, radius, (q, d) => { if (d < best) { best = d; bestQ = q; } });
    return { d: best, q: bestQ };
  };
  const nearest = (p, part, radius) => closest(p, part, radius).d;
  nearest.each = each;
  nearest.closest = closest;
  return nearest;
}

// ---- BVH --------------------------------------------------------------------
/* Median-split BVH over a flat Float32Array of triangles (9 floats each).
   Plain typed arrays, so a worker can share them through SharedArrayBuffer. */
export function buildBvh(T, alloc = (C, n) => new C(n)) {
  const n = T.length / 9;
  const order = alloc(Uint32Array, n);
  const cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let k = 0; k < 3; k++) cen[i * 3 + k] = (T[i * 9 + k] + T[i * 9 + 3 + k] + T[i * 9 + 6 + k]) / 3;
  }
  const cap = 2 * n + 1;
  const bmin = alloc(Float32Array, cap * 3), bmax = alloc(Float32Array, cap * 3);
  const left = alloc(Int32Array, cap), start = alloc(Int32Array, cap), count = alloc(Int32Array, cap);
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
/* Any hit in (0, tmax), both faces -- the AO test. */
export function occluded(bvh, ox, oy, oz, dx, dy, dz, tmax) {
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
/* Nearest hit in (0, tmax), both faces: { t, tri, u, w } (u, w weight corners
   1 and 2) or null. Used by the checks to look straight down on a seam. */
export function closestHit(bvh, ox, oy, oz, dx, dy, dz, tmax) {
  const { T, order, bmin, bmax, left, start, count } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const stack = [0];
  let best = null, bestT = tmax;
  while (stack.length) {
    const id = stack.pop();
    let t0 = ((ix >= 0 ? bmin[id * 3] : bmax[id * 3]) - ox) * ix, t1 = ((ix >= 0 ? bmax[id * 3] : bmin[id * 3]) - ox) * ix;
    const ty0 = ((iy >= 0 ? bmin[id * 3 + 1] : bmax[id * 3 + 1]) - oy) * iy, ty1 = ((iy >= 0 ? bmax[id * 3 + 1] : bmin[id * 3 + 1]) - oy) * iy;
    if (ty0 > t0) t0 = ty0; if (ty1 < t1) t1 = ty1;
    const tz0 = ((iz >= 0 ? bmin[id * 3 + 2] : bmax[id * 3 + 2]) - oz) * iz, tz1 = ((iz >= 0 ? bmax[id * 3 + 2] : bmin[id * 3 + 2]) - oz) * iz;
    if (tz0 > t0) t0 = tz0; if (tz1 < t1) t1 = tz1;
    if (t0 > t1 || t1 < 0 || t0 > bestT) continue;
    if (left[id] >= 0) { stack.push(left[id], left[id] + 1); continue; }
    for (let k = start[id], end = start[id] + count[id]; k < end; k++) {
      const t = order[k] * 9;
      const ax = T[t], ay = T[t + 1], az = T[t + 2];
      const e1x = T[t + 3] - ax, e1y = T[t + 4] - ay, e1z = T[t + 5] - az;
      const e2x = T[t + 6] - ax, e2y = T[t + 7] - ay, e2z = T[t + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-14 && det < 1e-14) continue;
      const inv = 1 / det;
      const sx = ox - ax, sy = oy - ay, sz = oz - az;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * inv;
      if (w < 0 || u + w > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > 0 && hit < bestT) { bestT = hit; best = { t: hit, tri: order[k], u, w }; }
    }
  }
  return best;
}

// ---- model scale ------------------------------------------------------------
/* --car-length-mm: the car's real length over the paint's longest extent (a
   car is always longest nose to tail; mirrors add width, not length). Checked
   against the hand-measured values the notes shipped: Altima 4900 mm over
   0.18465 units = 26536 (shipped 26440), Sentra 4641 / 6.9490 = 668 (666),
   Maxima 4897 / 4.7781 = 1025 (1025) -- within 0.4% on all three. */
export function mmPerUnitFromLength(lo, hi, carLengthMm) {
  const ext = hi.map((h, k) => h - lo[k]);
  const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
  return { mmPerUnit: carLengthMm / ext[axis], axis: "xyz"[axis], units: ext[axis] };
}

// ---- parts --------------------------------------------------------------------
/* A "part" is what a seam is drawn between: the node's name (the mesh's when
   the node has none). That is right for every export that names its panels --
   the Nissans' _032_carpaint_leftdoor_Paint_0, the Maxima's body pieces -- but
   some exporters give every node the SAME name: the Accent's paint spans six
   nodes all called "Geom3D", which keyed by name alone merged into one part,
   so --seams found a single part, warned "a seam needs two" and drew nothing
   (panel-gaps audit, finding 14).
   So a name that two DIFFERENT nodes share is suffixed with "@<node index>"
   (the node's index in the file, which is stable across reads), and only
   then: a car whose names are unique keeps them exactly as they were, so its
   parts, its --seams auto list, its markers and its output are byte for byte
   what they were before this existed (checked on the Optima and the Sentra).
   One mesh instanced under two nodes of the same name becomes two parts too
   -- they are two pieces of metal in two places, and the seam between them is
   real. A --seams substring still matches every split part ("Geom3D" lists
   all six).
   items: [{ part, node }] (part rewritten in place). Returns the shared
   names that were split, for the log. */
export function splitSharedPartNames(items) {
  const nodesOf = new Map();
  for (const it of items) {
    let s = nodesOf.get(it.part);
    if (!s) nodesOf.set(it.part, (s = new Set()));
    s.add(it.node);
  }
  const shared = [...nodesOf].filter(([, s]) => s.size > 1).map(([name, s]) => ({ name, nodes: s.size }));
  if (!shared.length) return shared;
  const split = new Set(shared.map((x) => x.name));
  for (const it of items) if (split.has(it.part)) it.part = it.part + "@" + it.node;
  return shared;
}

// ---- --seams auto -----------------------------------------------------------
/* Which parts (node names) of the paint get seam lines, the way the notes
   chose them by hand: the body shell (the largest part) plus the panels that
   open or bolt on -- doors, bonnet, boot lid, bumpers, wings -- and none of the
   trim that shares the paint: black strips, mirror caps, handles, parking
   sensors, badges. Measured against the shipped hand lists, the rule gives
   exactly the Altima's (_010_carpaint + 4 doors + houbeixiang, the pinyin
   "trunk lid") and the Sentra's (_030_carpaint + 4 doors + trunk), and for the
   Maxima every part but the two mirrors (it shipped with `all`).
     1. a name matching PANEL is in, unless it also matches TRIM;
     2. the largest part is always in (it is the body shell);
     3. only when no name matched does area decide: every part with at least
        AUTO_MIN_AREA of the paint's surface, trim names excluded.
   Parts are {name, area}; returns { listed: Set, rows: [{name, pct, why}] }. */
const PANEL = /door|hood|bonnet|trunk|boot|tailgate|liftgate|hatch|lid|fender|wing|bumper|quarter|houbeixiang|qianbaoxian|houbaoxian|yezi/i;
const TRIM = /black|chrome|mirror|houshijing|handle|bashou|radar|leida|sensor|plate|logo|emblem|badge|trim|glass|light|lamp/i;
const AUTO_MIN_AREA = 0.03;
export function autoSeamParts(parts) {
  const total = parts.reduce((s, p) => s + p.area, 0) || 1;
  const largest = parts.reduce((b, p) => (!b || p.area > b.area ? p : b), null);
  const byName = parts.filter((p) => PANEL.test(p.name) && !TRIM.test(p.name));
  const rows = [];
  const listed = new Set();
  for (const p of [...parts].sort((a, b) => b.area - a.area)) {
    const pct = p.area / total;
    let why = null;
    if (p === largest) why = "largest part (body shell)";
    else if (byName.length) why = PANEL.test(p.name) && !TRIM.test(p.name) ? "panel name" : null;
    else if (pct >= AUTO_MIN_AREA && !TRIM.test(p.name)) why = "area >= " + AUTO_MIN_AREA * 100 + "% (no panel names)";
    if (why) listed.add(p.name);
    rows.push({ name: p.name, pct, why: why || (TRIM.test(p.name) ? "trim name" : byName.length ? "not a panel name" : "small") });
  }
  return { listed, rows };
}
