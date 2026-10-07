/* Self-checks for the two shading tools, computed from the file's own data
   (no browser): what a camera looking straight down on each seam would see.

   Why a view and not the curve: every past failure had a curve that looked
   right on paper. The first Maxima bake darkened both skins of each gap and
   lit the gap walls between them -- two lines on a phone. The Altima's band
   also traced a flange UNDER the front door's skin -- a second, wavy line.
   Both only show once the shade is looked at across a seam, so that is what
   this does:
     - anchors: points on a listed part's triangle edges within 4 mm of
       another listed part, one per 20 mm cell (spread along every seam), kept
       only if they are on the outside (a ray along the outward normal leaves
       the model: the cabin side of a door, a hem folded under the skin and a
       flange behind a panel all fail it) and the neighbour is beside or in
       front, not under the skin;
     - a profile: from each anchor, across the gap towards the neighbour,
       -W..+W mm in 0.25 mm steps, each sample the shade of the FIRST paint
       surface a ray straight down the anchor's outward normal hits, if that
       surface is the skin (faces the view, within 3 mm of the panel's level
       8 mm back from the edge, whose normal is also the view -- the edge's
       own normal already rolls into the gap). The gap itself, a window opening or the far edge of a panel is
       no data, bridged by interpolation; a profile under 70% data is dropped;
     - each profile is divided by its own panel level (the median of its outer
       40% on each side) and box-filtered to a pixel: 4.2 mm is one device
       pixel on a phone at dpr 3 with the car ~400 css px wide (4.9 m / 1170
       px), the density where the doubled Maxima seam showed; 1 mm is the
       door close-up.
   A dip is a local minimum whose prominence (the lesser climb to either side
   before the profile goes lower again) is at least DIP_PROMINENCE of the panel.
   One dip within the curve's reach of the gap is a seam line; two there, with
   a ridge between, is the doubled seam; a dip farther out is a crease.

   Interior samples (area-weighted, seen from outside, farther than twice the
   reach from any other listed part) give the panel tone and the specks:
   anything darker than DARKER_THAN_SEAM of the panel -- deeper than the seam
   core itself -- inside a panel is a speck or a crease. */
import { buildBvh, closestHit, occluded, partGrid, triArea } from "./shade-geom.mjs";

export const DIP_PROMINENCE = 0.06;
export const DARKER_THAN_SEAM = 0.5;
const STEP_MM = 0.25;
/* An anchor is a skin edge within this of another listed part. The closest
   points between two panels are on the gap walls INSIDE the gap, which no
   outside ray reaches, so each 20 mm cell tries its candidates nearest first
   until one is on the outside; 4 mm covers the Camry's 2-3 mm gaps. */
const ANCHOR_MM = 4;
/* The shade is read off the SKIN only, so the checks judge what the tool
   paints and not the hole: the gap itself (nothing under the view, or a wall
   seen edge-on, or the flange at its bottom) is no data and is bridged by
   interpolation. Counting the see-through gap as black made every unpatched
   map read as a 0.18-deep line at a phone pixel, the same as the Camry's. */
const SKIN_MM = 3;

export const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
const pct = (a, q) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l ? [v[0] / l, v[1] / l, v[2] / l] : null; };

/* Box filter of width w samples (odd), edges clamped. */
function boxFilter(r, w) {
  if (w <= 1) return r.slice();
  const h = w >> 1, out = new Float64Array(r.length);
  for (let i = 0; i < r.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(r.length - 1, i + h); j++) { s += r[j]; n++; }
    out[i] = s / n;
  }
  return out;
}
/* Local minima of r with topographic prominence >= p, between i0 and i1. A
   flat bottom (a plateau of equal values, which the bridge across a gap
   makes) is ONE minimum: counting both of its ends as dips reported most
   single V's as doubled. */
function dips(r, i0, i1, p) {
  const out = [];
  for (let i = Math.max(1, i0); i < Math.min(r.length - 1, i1); i++) {
    if (!(r[i] < r[i - 1])) continue;
    let j = i;
    while (j + 1 < r.length && r[j + 1] === r[i]) j++;
    if (!(j + 1 < r.length && r[j + 1] > r[i])) { i = j; continue; }
    let lmax = r[i], rmax = r[i];
    let k = i - 1;
    for (; k >= 0 && r[k] >= r[i]; k--) if (r[k] > lmax) lmax = r[k];
    const leftOpen = k < 0;
    for (k = j + 1; k < r.length && r[k] >= r[i]; k++) if (r[k] > rmax) rmax = r[k];
    const rightOpen = k >= r.length;
    const prom = Math.min(leftOpen ? rmax : lmax, rightOpen ? lmax : rmax) - r[i];
    if (prom >= p) out.push({ i: (i + j) >> 1, v: r[i], prom });
    i = j;
  }
  return out;
}
/* How many dips the median seam profile has (prominence >= 0.02 of the
   panel): one V is a seam line, two is the doubled seam, at a phone's pixel. */
export function profileDips(prof) {
  let minima = 0;
  for (let i = 1; i < prof.length - 1; i++) {
    if (!(prof[i] < prof[i - 1] && prof[i] <= prof[i + 1])) continue;
    let l = prof[i], r = prof[i];
    for (let j = i - 1; j >= 0 && prof[j] >= prof[i]; j--) l = Math.max(l, prof[j]);
    for (let j = i + 1; j < prof.length && prof[j] >= prof[i]; j++) r = Math.max(r, prof[j]);
    if (Math.min(l, r) - prof[i] >= 0.02) minima++;
  }
  return minima;
}
/* Fills NaN gaps by linear interpolation (edges held), so the filter and the
   dip search see a continuous profile; null if under minValid of it is data. */
function fillGaps(v, minValid) {
  const r = Float64Array.from(v);
  let valid = 0;
  for (const x of r) if (!Number.isNaN(x)) valid++;
  if (valid < minValid * r.length) return null;
  let last = -1;
  for (let i = 0; i <= r.length; i++) {
    if (i < r.length && Number.isNaN(r[i])) continue;
    if (i - last > 1) for (let j = last + 1; j < i; j++) r[j] = last < 0 ? r[i] : i >= r.length ? r[last] : r[last] + ((r[i] - r[last]) * (j - last)) / (i - last);
    last = i;
  }
  return r;
}

/* opts:
     tris      [{ corners:[3][3], normals:[3][3]|null (outward), part }] -- all paint triangles
     world     optional Float32Array (9 floats per triangle) of EVERY triangle of the
               model, glass included, for the "seen from outside" test; without it
               only the paint can block a view
     listed    part -> bool (the seam parts)
     mmPerUnit, reachMm (the curve's reach)
     shade     (triIndex, u, w) -> 0..1 (u, w weight corners 1 and 2)
     base      optional second shade fn: the unpatched state, to count NEW specks
   returns the aggregate numbers the tools turn into checks. */
export function seamCheck(opts) {
  const { tris, listed, mmPerUnit, reachMm, shade, base } = opts;
  const mm = (x) => x / mmPerUnit;
  const W = Math.max(12, 2.5 * reachMm);
  const H = 25; // mm above the surface the view ray starts
  const T = new Float32Array(tris.length * 9);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { T[i * 9 + k * 3 + c] = t.corners[k][c]; lo[c] = Math.min(lo[c], t.corners[k][c]); hi[c] = Math.max(hi[c], t.corners[k][c]); } });
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const bvh = buildBvh(T);
  const worldBvh = opts.world ? buildBvh(opts.world) : bvh;
  const faceN = (t) => {
    const [a, b, c] = t.corners;
    return norm3([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
  };
  const normalAt = (t, w0, w1, w2) => {
    if (!t.normals) return faceN(t);
    return norm3([0, 1, 2].map((k) => w0 * t.normals[0][k] + w1 * t.normals[1][k] + w2 * t.normals[2][k])) || faceN(t);
  };
  /* Seen from outside: a ray from the point along the normal leaves the model
     without touching anything. Tries -n for a surface whose normals point
     inward; returns the outward side or null. */
  const outwardSide = (x, n) => {
    const e = mm(0.05);
    for (const s of [1, -1]) {
      const d = [n[0] * s, n[1] * s, n[2] * s];
      if (!occluded(worldBvh, x[0] + d[0] * e, x[1] + d[1] * e, x[2] + d[2] * e, d[0], d[1], d[2], size * 4)) return d;
    }
    return null;
  };
  const look = (x, n) => {
    const o = [x[0] + n[0] * mm(H), x[1] + n[1] * mm(H), x[2] + n[2] * mm(H)];
    return closestHit(bvh, o[0], o[1], o[2], -n[0], -n[1], -n[2], mm(2 * H));
  };

  // ---- anchors ----
  const listedTris = [];
  tris.forEach((t, i) => { if (listed(t.part)) listedTris.push({ ...t, index: i }); });
  const grid = partGrid(listedTris, mm(16));
  const cells = new Map();
  for (const t of listedTris) {
    for (const [wa, wb, wc] of [[0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
      const p = [0, 1, 2].map((k) => wa * t.corners[0][k] + wb * t.corners[1][k] + wc * t.corners[2][k]);
      const { d, q } = grid.closest(p, t.part, mm(ANCHOR_MM));
      if (!(d < mm(ANCHOR_MM))) continue;
      const key = Math.floor(p[0] / mm(20)) + "," + Math.floor(p[1] / mm(20)) + "," + Math.floor(p[2] / mm(20));
      const list = cells.get(key) || [];
      list.push({ p, q, d, t, w: [wa, wb, wc] });
      cells.set(key, list);
    }
  }
  const steps = Math.round((2 * W) / STEP_MM) + 1;
  const mid = Math.round(W / STEP_MM);
  const profiles = [];
  let hiddenAnchors = 0, behindAnchors = 0;
  for (const list of cells.values()) {
    // The closest candidate in the cell that passes both tests.
    list.sort((a, b) => a.d - b.d);
    let chosen = null;
    for (const a of list.slice(0, 48)) {
      const n0 = normalAt(a.t, a.w[0], a.w[1], a.w[2]);
      if (!n0) continue;
      const n = outwardSide(a.p, n0);
      if (!n) { hiddenAnchors++; continue; }
      const u = [a.q[0] - a.p[0], a.q[1] - a.p[1], a.q[2] - a.p[2]];
      const un = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
      if (a.d > 0 && un / a.d < -0.35) { behindAnchors++; continue; } // the neighbour is under the skin: not a seam
      chosen = { a, n, u, un };
      break;
    }
    if (!chosen) continue;
    const { a } = chosen;
    /* The anchor sits on the edge's roll, where the normal already tilts
       into the gap. The view and the skin's level are taken 8 mm back on
       the anchor's own panel instead: the normal and the point there. */
    const u0 = norm3([chosen.u[0] - chosen.un * chosen.n[0], chosen.u[1] - chosen.un * chosen.n[1], chosen.u[2] - chosen.un * chosen.n[2]]);
    if (!u0) continue;
    const back = [a.p[0] - u0[0] * mm(8), a.p[1] - u0[1] * mm(8), a.p[2] - u0[2] * mm(8)];
    const ph = look(back, chosen.n);
    if (!ph || tris[ph.tri].part !== a.t.part) { hiddenAnchors++; continue; }
    let n = normalAt(tris[ph.tri], 1 - ph.u - ph.w, ph.u, ph.w);
    if (!n) continue;
    if (n[0] * chosen.n[0] + n[1] * chosen.n[1] + n[2] * chosen.n[2] < 0) n = [-n[0], -n[1], -n[2]];
    const o0 = [back[0] + chosen.n[0] * mm(H), back[1] + chosen.n[1] * mm(H), back[2] + chosen.n[2] * mm(H)];
    const level = [o0[0] - chosen.n[0] * ph.t, o0[1] - chosen.n[1] * ph.t, o0[2] - chosen.n[2] * ph.t];
    let u = [a.q[0] - a.p[0], a.q[1] - a.p[1], a.q[2] - a.p[2]];
    const un = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    const tangential = Math.hypot(u[0] - un * n[0], u[1] - un * n[1], u[2] - un * n[2]);
    u = norm3([u[0] - un * n[0], u[1] - un * n[1], u[2] - un * n[2]]);
    if (!u) continue;
    const gapMm = tangential * mmPerUnit;
    const v = new Float64Array(steps), bv = base ? new Float64Array(steps) : null;
    let misses = 0;
    for (let s = 0; s < steps; s++) {
      const off = mm(-W + s * STEP_MM);
      const x = [a.p[0] + u[0] * off, a.p[1] + u[1] * off, a.p[2] + u[2] * off];
      let hit = look(x, n);
      if (!hit) misses++;
      // Only the skin counts: a hit must face the view (a gap wall is edge-on)
      // and lie within SKIN_MM of the panel's level (the flange at the bottom
      // of a gap is seen through it, not drawn on it).
      if (hit) {
        const o = [x[0] + n[0] * mm(H), x[1] + n[1] * mm(H), x[2] + n[2] * mm(H)];
        const hp = [o[0] - n[0] * hit.t, o[1] - n[1] * hit.t, o[2] - n[2] * hit.t];
        const depthMm = ((hp[0] - level[0]) * n[0] + (hp[1] - level[1]) * n[1] + (hp[2] - level[2]) * n[2]) * mmPerUnit;
        const fn = faceN(tris[hit.tri]);
        if (Math.abs(depthMm) > SKIN_MM || !fn || Math.abs(fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]) < 0.5) hit = null;
      }
      v[s] = hit ? shade(hit.tri, hit.u, hit.w) : NaN;
      if (bv) bv[s] = hit ? base(hit.tri, hit.u, hit.w) : NaN;
    }
    profiles.push({ v, bv, gapMm, misses, p: a.p, part: a.t.part });
  }

  // ---- per-profile analysis ----
  const outer = Math.round((0.6 * W) / STEP_MM);
  const inner = Math.round((reachMm + 2) / STEP_MM); // the curve's reach past the gap
  const res = { px4: { doubled: 0, crease: 0 }, px1: { doubled: 0, crease: 0 } };
  const depth4 = [], width1 = [], depth1 = [], width4 = [];
  let used = 0, flat = 0;
  const avgCols = Array.from({ length: steps }, () => []);
  const doubledAt = [];
  for (const pr of profiles) {
    const leftSh = [], rightSh = [];
    for (let s = 0; s <= mid - outer; s++) if (pr.v[s] > 0) leftSh.push(pr.v[s]);
    for (let s = mid + outer; s < steps; s++) if (pr.v[s] > 0) rightSh.push(pr.v[s]);
    if (leftSh.length < 0.6 * (mid - outer) || rightSh.length < 0.6 * (mid - outer)) continue;
    const filled = fillGaps(pr.v, 0.7);
    if (!filled) continue;
    const Ls = median(leftSh), Rs = median(rightSh);
    if (!(Ls > 0.05 && Rs > 0.05)) continue;
    const gapMid = mid + Math.round(pr.gapMm / 2 / STEP_MM);
    const r = Float64Array.from(filled, (x, s) => x / (s <= gapMid ? Ls : Rs));
    pr.used = true;
    used++;
    for (const [px, key, depths, widths] of [[4.2, "px4", depth4, width4], [1, "px1", depth1, width1]]) {
      const f = boxFilter(r, Math.max(1, Math.round(px / STEP_MM) | 1));
      const ds = dips(f, mid - outer, mid + outer, DIP_PROMINENCE);
      const near = ds.filter((d) => Math.abs(d.i - gapMid) <= inner);
      const far = ds.filter((d) => Math.abs(d.i - gapMid) > inner);
      if (near.length >= 2) { res[key].doubled++; if (key === "px4") doubledAt.push(pr.p); pr["doubled" + key] = true; }
      if (far.length) res[key].crease++;
      let mi = gapMid, mv = Infinity;
      for (let s = gapMid - inner; s <= gapMid + inner; s++) if (s >= 0 && s < steps && f[s] < mv) { mv = f[s]; mi = s; }
      const depth = 1 - mv;
      depths.push(depth);
      if (depth < DIP_PROMINENCE) { if (key === "px4") flat++; continue; }
      const half = 1 - depth / 2;
      let a = mi, b = mi;
      while (a > 0 && f[a - 1] < half) a--;
      while (b < steps - 1 && f[b + 1] < half) b++;
      widths.push((b - a + 1) * STEP_MM);
      if (key === "px4") for (let s = 0; s < steps; s++) { const k = s - gapMid + mid; if (k >= 0 && k < steps) avgCols[k].push(f[s]); }
    }
  }
  const frac = (n) => (used ? n / used : 0);
  if (process.env.SHADE_DUMP) { // debugging aid: every k-th used profile, 1 mm apart, as percent
    const list = profiles.filter((p) => p.used), k = Math.max(1, Math.ceil(list.length / +process.env.SHADE_DUMP));
    list.forEach((pr, i) => { if (i % k) return; console.error((pr.doubledpx4 ? "D " : "  ") + String(pr.part).slice(0, 18).padEnd(18) + " gap " + pr.gapMm.toFixed(1) + " @" + pr.p.map((x) => x.toFixed(3)).join(",") + "  " + Array.from(pr.v).filter((_, j) => j % 4 === 0).map((x) => (Number.isNaN(x) ? "--" : Math.round(x * 99))).join(" ")); });
  }

  // ---- interior: panel tone and specks ----
  const listedGrid = partGrid(listedTris, mm(Math.max(16, reachMm * 4)));
  const interior = [], interiorBase = [];
  let totalArea = 0;
  const areas = tris.map((t) => { const a = triArea(t.corners[0], t.corners[1], t.corners[2]); totalArea += a; return a; });
  const N_SAMPLES = 16000;
  let acc = 0, k = 0;
  const stride = totalArea / N_SAMPLES;
  let next = stride / 2;
  for (let i = 0; i < tris.length; i++) {
    acc += areas[i];
    while (acc >= next) {
      next += stride;
      k++;
      let r1 = ((k * 7919) % 997) / 997, r2 = ((k * 104729) % 991) / 991;
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const t = tris[i], r0 = 1 - r1 - r2;
      const p = [0, 1, 2].map((c) => r0 * t.corners[0][c] + r1 * t.corners[1][c] + r2 * t.corners[2][c]);
      if (listedGrid(p, listed(t.part) ? t.part : "\u0000none", mm(2 * reachMm)) < mm(2 * reachMm)) continue;
      const n0 = normalAt(t, r0, r1, r2);
      if (!n0 || !outwardSide(p, n0)) continue;
      interior.push(shade(i, r1, r2));
      if (base) interiorBase.push(base(i, r1, r2));
    }
  }
  const panel = median(interior);
  const speckOf = (arr, lvl) => arr.filter((x) => x < lvl * DARKER_THAN_SEAM).length / (arr.length || 1);
  const avgProfile = [];
  // The median profile across every seam at phone resolution, 1 mm apart,
  // centred on the gap: the "one V, not two" shape in numbers.
  for (let s = mid % 4; s < steps; s += 4) if (avgCols[s].length >= 3) avgProfile.push(+median(avgCols[s]).toFixed(3));
  return {
    anchors: cells.size, hiddenAnchors, behindAnchors, profiles: used, flat: frac(flat),
    doubled4: frac(res.px4.doubled), crease4: frac(res.px4.crease), doubled1: frac(res.px1.doubled), crease1: frac(res.px1.crease),
    depth4: median(depth4), depth1: median(depth1), width4: median(width4), width1: median(width1),
    depth1p25: pct(depth1, 0.25), depth1p75: pct(depth1, 0.75),
    panel, interiorSamples: interior.length,
    specks: speckOf(interior, panel), specksBase: base ? speckOf(interiorBase, median(interiorBase)) : null, panelBase: base ? median(interiorBase) : null,
    medianProfile4: avgProfile, windowMm: W,
    doubledAt: doubledAt.slice(0, 12).map((p) => p.map((x) => +x.toFixed(4))),
    ...(opts.debug ? { raw: profiles } : {}),
  };
}
