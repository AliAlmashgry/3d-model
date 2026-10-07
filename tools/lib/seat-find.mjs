/* seat-find: locate a car's driver's seat as a set of whole shells, from a
   tapped point (--pick) or from nothing (--auto), and judge any selection
   (those two, or an old --box / --mesh one) against what a seat can be.

   Everything is measured in the car's own frame (seat-scene's carFrame: up,
   length and width axes, robust extents L, W, H, the centre plane `mid`), so
   one set of limits serves a car modelled in metres, inches (the Optima),
   centimetres (the Sportage 2017) or a 0.18-unit toy (the Altima).

   The seat is GROWN, not boxed. Starting from the shell under the tap, a
   neighbouring shell joins when its surface comes within `gap` of the
   seat so far (a voxel test on sampled surface points, not bounding boxes,
   so a pillar trim whose box overlaps the headrest's but whose surface is
   5 cm away stays out) AND the seat's bounding box stays inside what a front
   seat can measure. Shells that cannot be part of any seat are refused
   outright whatever touches them: longer, wider or taller than a whole seat
   (door cards, carpet, headliner, the console), reaching the roof band
   (pillars, headliner strips, grab handles), or crossing the centre plane
   (the console, a bench, the other seat). Those are exactly the pieces the
   old boxes painted: the Camry's "red dot in the mid pillar", both Nissans'
   B-pillar and headliner strip.

   Two things every seat is also held to since the first verification
   (2026-10-01): it must be the DRIVER's seat (driverSide: a tap on the
   passenger seat, or --auto steered by a wrong --front, wrote a red
   passenger seat with every check passing), and it must stop at the seat's
   inboard edge (consoleParts: the Sportage 2017's grown seat took the
   handbrake lever, the gear-lever buttons and the armrest-lid stitching,
   all within 2 voxels of its inboard bolster). */
import { triCorners } from "./seat-scene.mjs";

/* A selection that cannot be made, with a message for the person who asked
   (seat-split prints it and exits 1). Anything else thrown is a bug. */
export class SeatError extends Error {}

/* The envelope a front seat lives in, as fractions of the car. Measured on
   the five cars whose seat was split by hand (Camry, Corolla, Elantra,
   Sonata, Optima): seat width 0.29-0.31 W, height 0.55-0.69 H, depth
   0.05-0.19 L (0.25 with the Elantra's belt), top 0.83-0.905 H, bottom
   0.18-0.30 H; B-pillar and headliner trim reach 0.945 H and above. */
export function seatLimits(F, over = {}) {
  const lim = {
    maxW: 0.35 * F.W, maxH: 0.75 * F.H, maxD: 0.21 * F.L,
    minW: 0.12 * F.W, minH: 0.30 * F.H, minD: 0.03 * F.L,
    roofTop: F.ground + 0.93 * F.H,      // nothing of a seat reaches this band
    minTop: F.ground + 0.55 * F.H,       // a seat with a backrest reaches this
    crossTol: 0.025 * F.W,               // how far past the centre plane a seat may lean
    wallEdge: 0.375 * F.W,               // no seat part reaches this far out from the centre plane
    wallCentre: 0.34 * F.W,              // ...or is centred this far out (door, pillar and belt parts are)
    voxel: 0.003 * F.L,                  // ~1.4 cm on a 4.8 m car
    gapVox: 2,                           // neighbours within ~2 voxels join
    minTris: 30,
  };
  return Object.assign(lim, over);
}

const W = (F) => F.wid, U = (F) => F.up, Ln = (F) => F.len;

/* Surface samples of a triangle at spacing <= step, with a callback per point.
   Triangles are mostly smaller than a voxel, so this is usually 3 corners +
   the centroid; a 2 m carpet triangle costs a few thousand points. */
function sampleTri(c, step, cb) {
  const e = Math.max(
    Math.hypot(c[3] - c[0], c[4] - c[1], c[5] - c[2]),
    Math.hypot(c[6] - c[0], c[7] - c[1], c[8] - c[2]),
    Math.hypot(c[6] - c[3], c[7] - c[4], c[8] - c[5]));
  const n = Math.max(1, Math.ceil(e / step));
  if (n === 1) {
    cb(c[0], c[1], c[2]); cb(c[3], c[4], c[5]); cb(c[6], c[7], c[8]);
    cb((c[0] + c[3] + c[6]) / 3, (c[1] + c[4] + c[7]) / 3, (c[2] + c[5] + c[8]) / 3);
    return;
  }
  for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) {
    const u = a / n, v = b / n, w = 1 - u - v;
    cb(w * c[0] + u * c[3] + v * c[6], w * c[1] + u * c[4] + v * c[7], w * c[2] + u * c[5] + v * c[8]);
  }
}

/* A dense voxel grid over `region`. Holds, per voxel, the sorted list of
   local shell indices whose surface passes through it (CSR), built from
   (voxel, shell) keys sorted in a Float64Array. */
function voxelize(scene, shellIds, region, v) {
  const S = scene.shells;
  const nx = Math.max(1, Math.ceil((region.max[0] - region.min[0]) / v) + 1);
  const ny = Math.max(1, Math.ceil((region.max[1] - region.min[1]) / v) + 1);
  const nz = Math.max(1, Math.ceil((region.max[2] - region.min[2]) / v) + 1);
  const nLocal = shellIds.length;
  let keys = new Float64Array(1 << 16), nk = 0;
  const push = (k) => { if (nk === keys.length) { const b = new Float64Array(keys.length * 2); b.set(keys); keys = b; } keys[nk++] = k; };
  const c = new Float32Array(9);
  const [x0, y0, z0] = region.min, [x1, y1, z1] = region.max;
  for (let i = 0; i < nLocal; i++) {
    const s = shellIds[i];
    let last = -1;
    for (let j = S.start[s]; j < S.start[s + 1]; j++) {
      triCorners(scene, S.tris[j], c);
      // Skip triangles wholly outside the region.
      if (Math.max(c[0], c[3], c[6]) < x0 || Math.min(c[0], c[3], c[6]) > x1 ||
          Math.max(c[1], c[4], c[7]) < y0 || Math.min(c[1], c[4], c[7]) > y1 ||
          Math.max(c[2], c[5], c[8]) < z0 || Math.min(c[2], c[5], c[8]) > z1) continue;
      sampleTri(c, v * 0.5, (x, y, z) => {
        if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) return;
        const vox = Math.floor((x - x0) / v) + nx * (Math.floor((y - y0) / v) + ny * Math.floor((z - z0) / v));
        if (vox === last) return;
        last = vox;
        push(vox * nLocal + i);
      });
    }
  }
  keys = keys.subarray(0, nk).sort();
  // Unique, then CSR by voxel over the occupied voxels only.
  const occVox = [], occStart = [0], occShell = [];
  let prev = -1;
  for (let i = 0; i < nk; i++) {
    const k = keys[i];
    if (k === prev) continue;
    prev = k;
    const vox = Math.floor(k / nLocal), sh = k - vox * nLocal;
    if (!occVox.length || occVox[occVox.length - 1] !== vox) { if (occVox.length) occStart.push(occShell.length); occVox.push(vox); }
    occShell.push(sh);
  }
  occStart.push(occShell.length);
  const index = new Int32Array(nx * ny * nz).fill(-1);
  for (let i = 0; i < occVox.length; i++) index[occVox[i]] = i;
  const voxCount = new Int32Array(nLocal);
  for (const sh of occShell) voxCount[sh]++;
  return { nx, ny, nz, v, region, index, occVox, occStart: Int32Array.from(occStart), occShell: Int32Array.from(occShell), voxCount, nLocal };
}

/* Shell adjacency from a voxel grid: shells a, b are neighbours at distance d
   (Chebyshev, in voxels, 0..k) when their surfaces pass through voxels d
   apart. Returned as per-local-shell arrays of [b, d]. */
function adjacency(grid, k) {
  const { nx, ny, index, occVox, occStart, occShell, nLocal } = grid;
  const best = new Map();
  const offs = [];
  for (let dz = -k; dz <= k; dz++) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
    // Half the neighbourhood: each unordered voxel pair once.
    if (dz < 0 || (dz === 0 && dy < 0) || (dz === 0 && dy === 0 && dx < 0)) continue;
    offs.push([dx, dy, dz, Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))]);
  }
  const nz = grid.nz;
  for (let i = 0; i < occVox.length; i++) {
    const vox = occVox[i];
    const x = vox % nx, y = Math.floor(vox / nx) % ny, z = Math.floor(vox / (nx * ny));
    const a0 = occStart[i], a1 = occStart[i + 1];
    for (const [dx, dy, dz, d] of offs) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const j = index[X + nx * (Y + ny * Z)];
      if (j < 0) continue;
      const b0 = occStart[j], b1 = occStart[j + 1];
      for (let p = a0; p < a1; p++) for (let q = b0; q < b1; q++) {
        const a = occShell[p], b = occShell[q];
        if (a === b) continue;
        const key = a < b ? a * nLocal + b : b * nLocal + a;
        const cur = best.get(key);
        if (cur === undefined || d < cur) best.set(key, d);
      }
    }
  }
  const adj = Array.from({ length: nLocal }, () => []);
  for (const [key, d] of best) {
    const a = Math.floor(key / nLocal), b = key - a * nLocal;
    adj[a].push([b, d]); adj[b].push([a, d]);
  }
  return adj;
}

const shellBox = (S, s) => ({ min: [S.min[s * 3], S.min[s * 3 + 1], S.min[s * 3 + 2]], max: [S.max[s * 3], S.max[s * 3 + 1], S.max[s * 3 + 2]] });
const unionBox = (a, b) => ({ min: a.min.map((v, k) => Math.min(v, b.min[k])), max: a.max.map((v, k) => Math.max(v, b.max[k])) });
const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

/* Why shell s can never be part of a seat on side `side` (+1 or -1 along the
   width axis from the centre plane), or null. */
export function shellVeto(scene, s, lim, side) {
  const F = scene.frame, S = scene.shells;
  const b = shellBox(S, s);
  const w = F.wid, u = F.up, l = F.len;
  const dw = b.max[w] - b.min[w], dh = b.max[u] - b.min[u], dl = b.max[l] - b.min[l];
  if (dw > lim.maxW) return "wider than a seat";
  if (dh > lim.maxH) return "taller than a seat";
  if (dl > lim.maxD) return "longer than a seat";
  if (b.max[u] > lim.roofTop) return "reaches the roof band";
  const inboard = side > 0 ? F.mid - b.min[w] : b.max[w] - F.mid; // how far past the centre plane
  if (inboard > lim.crossTol) return "crosses the centre plane";
  const outer = side > 0 ? b.max[w] - F.mid : F.mid - b.min[w];
  const centre = ((b.min[w] + b.max[w]) / 2 - F.mid) * side;
  if (outer > lim.wallEdge) return "reaches into the side wall";
  if (centre > lim.wallCentre) return "sits on the side wall";
  // A floor mat or carpet patch: flat, low and wider than a seat rail.
  if (b.max[u] < F.ground + 0.3 * F.H && dh < 0.04 * F.H && dw > 0.08 * F.W && dl > 0.04 * F.L) return "lies flat on the floor";
  // A belt: a strap hanging from the pillar, thin both ways and tall.
  if (dh > 0.4 * F.H && dw < 0.05 * F.W && dl < 0.06 * F.L && centre > 0.25 * F.W) return "a seat-belt strap";
  // Flat and by the centre line: switch panels, button caps and trim plates
  // on the console (the Sportage 2017's buttons_gears beside the gear lever,
  // 0.003 H thick, centred 0.037 W out). A seat's own parts are centred
  // further out than 0.06 W or are not flat.
  if (dh < 0.01 * F.H && centre < 0.06 * F.W) return "a flat console part by the centre line";
  return null;
}

/* The candidates around a seat and their proximity graph. `region` bounds
   the search; every shell overlapping it that shellVeto does not refuse is
   rasterised (`keep` shells -- the tapped one -- are never refused, so a
   refusal can be reported instead of silently growing nothing). */
export function prepareRegion(scene, region, { lim, side, keep = null }) {
  const S = scene.shells;
  const local = [], vetoed = new Map();
  for (let s = 0; s < S.n; s++) {
    if (S.max[s * 3] < region.min[0] || S.min[s * 3] > region.max[0] || S.max[s * 3 + 1] < region.min[1] || S.min[s * 3 + 1] > region.max[1] || S.max[s * 3 + 2] < region.min[2] || S.min[s * 3 + 2] > region.max[2]) continue;
    if (!(keep && keep.has(s))) { const why = shellVeto(scene, s, lim, side); if (why) { vetoed.set(s, why); continue; } }
    local.push(s);
  }
  const grid = voxelize(scene, local, region, lim.voxel);
  const adj = adjacency(grid, lim.gapVox);
  return { region, side, local, localOf: new Map(local.map((s, i) => [s, i])), vetoed, adj, cells: grid.occVox.length };
}

/* The box every seat containing `shells` fits in: theirs grown by a whole
   seat's size in each direction. */
export function seatRegion(scene, shells, lim) {
  const F = scene.frame, S = scene.shells;
  let sb = emptyBox();
  for (const s of shells) sb = unionBox(sb, shellBox(S, s));
  const ext = [0, 0, 0]; ext[F.wid] = lim.maxW; ext[F.up] = lim.maxH; ext[F.len] = lim.maxD;
  return { min: sb.min.map((v, k) => v - ext[k]), max: sb.max.map((v, k) => v + ext[k]) };
}

/* Grow a seat from seed shells inside a prepared region. `primary` is a Set
   of material groups whose shells join by proximity alone (the tapped
   shell's material, or --source); a shell of any other material joins only
   when at least 70% of its triangles sit inside the box the primary growth
   settled on -- a seat's back shell or plastic trim in its own material --
   never merely by touching it.
   `exclude`: shells never to join (a Set, or a Map shell -> the reason
   --report gives). `tune` (seat-split --seed, lib/seat-vary.mjs; null = the
   calibrated growth): envelope scales the seat-size limit growth stops at,
   otherInside replaces the 70%, others: false skips the other materials. */
export function growFrom(scene, ctx, seeds, { lim, primary, exclude = null, tune = null }) {
  const F = scene.frame, S = scene.shells;
  const { local, localOf, adj } = ctx;
  const env = tune && tune.envelope !== undefined ? tune.envelope : 1;
  const maxW = lim.maxW * env, maxH = lim.maxH * env, maxD = lim.maxD * env;
  const otherInside = tune && tune.otherInside !== undefined ? tune.otherInside : 0.7;
  const inCluster = new Uint8Array(local.length);
  let box = emptyBox();
  const members = [];
  const blocked = new Map();
  const buckets = Array.from({ length: lim.gapVox + 1 }, () => []);
  const trace = [];
  let viaD = -1;
  const add = (i) => {
    inCluster[i] = 1; members.push(local[i]); trace.push([local[i], viaD]);
    box = unionBox(box, shellBox(S, local[i]));
    for (const [b, d] of adj[i]) if (!inCluster[b]) buckets[d].push(b);
  };
  for (const s of seeds) if (localOf.has(s)) add(localOf.get(s));
  const fits = (bx) => bx.max[F.wid] - bx.min[F.wid] <= maxW && bx.max[F.up] - bx.min[F.up] <= maxH && bx.max[F.len] - bx.min[F.len] <= maxD;
  const enclosed = (s, bx) => {
    let inside = 0;
    const n = S.start[s + 1] - S.start[s];
    const pad = lim.voxel;
    for (let j = S.start[s]; j < S.start[s + 1]; j++) {
      const t = S.tris[j];
      let ok = true;
      for (let k = 0; k < 3; k++) { const c = scene.cen[t * 3 + k]; if (c < bx.min[k] - pad || c > bx.max[k] + pad) { ok = false; break; } }
      if (ok) inside++;
    }
    return inside >= otherInside * n;
  };
  /* Phase A: primary material by proximity. Phase B: other materials, only
     where 70% of a shell lies inside the box phase A settled on -- a FIXED
     box, so an armrest switch cannot widen the seat and let the next switch
     in (the creep that took the Optima's door card). */
  const deferred = new Set();
  const drain = (phase, coreBox) => {
    let grew = false;
    for (;;) {
      let i = -1;
      for (let d = 0; d < buckets.length; d++) if (buckets[d].length) { i = buckets[d].pop(); viaD = d; break; }
      if (i < 0) break;
      if (inCluster[i]) continue;
      const s = local[i];
      if (exclude && exclude.has(s)) { blocked.set(s, (exclude.get && exclude.get(s)) || "on the console side of the seat"); continue; }
      const nb = unionBox(box, shellBox(S, s));
      if (!fits(nb)) { blocked.set(s, "would make the seat too big"); continue; }
      const own = !primary || primary.has(S.group[s]);
      if (phase === "A" ? !own : !enclosed(s, coreBox)) { deferred.add(i); continue; }
      blocked.delete(s); deferred.delete(i);
      add(i); grew = true;
    }
    return grew;
  };
  drain("A");
  // The core's footprint as a column: a headrest or backrest top in its own
  // material stands above the cushion's box but inside its footprint; the
  // roof band and the floor are refused by shellVeto either way.
  const core = { min: [...box.min], max: [...box.max] };
  core.min[F.up] = F.ground; core.max[F.up] = lim.roofTop;
  for (let again = !(tune && tune.others === false); again;) {
    for (const i of deferred) buckets[0].push(i);
    deferred.clear();
    again = drain("B", core);
  }
  // The refused neighbours of the final seat, with the reason, for --report.
  const refused = [];
  const memberSet = new Set(members);
  for (const s of members) {
    for (const [b, d] of adj[localOf.get(s)]) {
      const t = local[b];
      if (memberSet.has(t)) continue;
      refused.push({ shell: t, d, why: blocked.get(t) || (deferred.has(b) ? "other material, not inside the seat" : "not reached") });
    }
  }
  return { shells: members, trace, box, refused: dedupeRefused(refused) };
}

/* Grow from a seed in its own material, then look at what else fills the
   seat's footprint column: when another material's candidate shells cover
   more than half the area the seat has so far, the seat is really made of
   both -- a tap on the Elantra's nn7.001 inserts grew only the inserts,
   while its bolsters are qeeqeeq -- so that material becomes primary too and
   the seat regrows. At most two extra materials. Not across the board: with
   every material primary the Maxima's seat took its steering wheel and the
   Sportage 2021's took the console buttons.
   `tune` (--seed): adoptShare replaces the half, adoptMax the two. */
export function growAdaptive(scene, ctx, seeds, { lim, primary, exclude = null, tune = null }) {
  const F = scene.frame, S = scene.shells;
  const share = tune && tune.adoptShare !== undefined ? tune.adoptShare : 0.5;
  const most = tune && tune.adoptMax !== undefined ? tune.adoptMax : 2;
  let prim = new Set(primary);
  let r = growFrom(scene, ctx, seeds, { lim, primary: prim, exclude, tune });
  const added = [];
  for (let round = 0; round < most; round++) {
    const mine = new Set(r.shells);
    let own = 0;
    for (const s of r.shells) own += S.area[s];
    const col = { min: [...r.box.min], max: [...r.box.max] };
    const pw = 2 * lim.voxel;
    col.min[F.wid] -= pw; col.max[F.wid] += pw; col.min[F.len] -= pw; col.max[F.len] += pw;
    col.min[F.up] = F.ground; col.max[F.up] = lim.roofTop;
    const byGroup = new Map();
    for (const s of ctx.local) {
      if (mine.has(s) || prim.has(S.group[s])) continue;
      let out = false;
      for (let k = 0; k < 3; k++) if (S.max[s * 3 + k] < col.min[k] || S.min[s * 3 + k] > col.max[k]) out = true;
      if (out) continue;
      let a = 0;
      for (let j = S.start[s]; j < S.start[s + 1]; j++) {
        const t = S.tris[j];
        let ok = true;
        for (let k = 0; k < 3; k++) { const c = scene.cen[t * 3 + k]; if (c < col.min[k] || c > col.max[k]) { ok = false; break; } }
        if (ok) a += scene.area[t];
      }
      if (a) byGroup.set(S.group[s], (byGroup.get(S.group[s]) || 0) + a);
    }
    const [g, a] = [...byGroup].sort((x, y) => y[1] - x[1])[0] || [];
    if (g === undefined || a < share * own) break;
    prim = new Set([...prim, g]);
    added.push(scene.groupNames[g]);
    r = growFrom(scene, ctx, seeds, { lim, primary: prim, exclude, tune });
  }
  return { ...r, primary: prim, added };
}

/* What of a selection lies on the console side of the seat. The seat's CORE
   is its largest shells by area, taken until they hold 85% of it (cushion,
   backrest, side shells); the core's inboard edge is where the seat ends.
   A shell whose selected surface lies WHOLLY inboard of that edge (within
   0.004 W, ~7 mm) and above the core's bottom is between the seat and the
   centre line: the console. Measured on the ten cabins: the core edge sits
   0.038-0.072 W from the centre plane, and the only shells wholly inboard of
   it were console parts -- the Sportage 2017's handbrake lever and button,
   gear-lever buttons and armrest-lid stitching (20,404 triangles), a strip
   of the Elantra's console side under the armrest (32, which its hand-cut
   seat had too), an indicator by the Optima's gear selector (88) and a
   Corolla console bit (8). Below the core's bottom (rails, a pedestal) is
   not judged. Works on triangles, so a --box --mode tris cut is judged by
   what it actually took. Returns { edge, bottom, parts: Map(shell -> selected
   triangles), tris }, edge and bottom in model units. `tol` is the 0.004 W:
   the console-clear check always uses that; a --seed variant's growth may
   take out more (lib/seat-vary.mjs consoleTol), never less. */
export function consoleParts(scene, tris, lim, side, tol = 0.004) {
  const F = scene.frame, S = scene.shells, w = F.wid, u = F.up;
  const per = new Map();
  const c = new Float32Array(9);
  for (const t of tris) {
    const s = scene.shellOf[t];
    let r = per.get(s);
    if (!r) per.set(s, r = { area: 0, n: 0, inb: Infinity, out: -Infinity, bot: Infinity, top: -Infinity });
    triCorners(scene, t, c);
    r.area += scene.area[t]; r.n++;
    for (let q = 0; q < 3; q++) {
      const d = (c[q * 3 + w] - F.mid) * side, h = c[q * 3 + u];
      if (d < r.inb) r.inb = d; if (d > r.out) r.out = d;
      if (h < r.bot) r.bot = h; if (h > r.top) r.top = h;
    }
  }
  const rows = [...per.values()];
  const total = rows.reduce((a, r) => a + r.area, 0);
  const byArea = rows.slice().sort((a, b) => b.area - a.area);
  let acc = 0, edge = Infinity, bottom = Infinity;
  for (const r of byArea) { if (acc >= 0.85 * total) break; acc += r.area; edge = Math.min(edge, r.inb); bottom = Math.min(bottom, r.bot); }
  const parts = new Map();
  let n = 0;
  for (const [s, r] of per) if (r.out < edge + tol * F.W && r.top > bottom) { parts.set(s, r.n); n += r.n; }
  return { edge: F.mid + side * edge, bottom, edgeW: edge / F.W, parts, tris: n };
}

/* Grow, then take out what lies on the console side of the result and grow
   again without it (a regrow, not a filter, so whatever was reached only
   through the console goes too). Twice at most: the core rarely moves.
   With `tune` (--seed) the first round also takes out what the variant
   leaves out (tuneDrops: the headrest, small pieces), and the console
   tolerance is the variant's. */
function growClear(scene, ctx, seeds, { lim, primary, side, adaptive, tune = null }) {
  let exclude = null;
  const grow = (ex) => adaptive ? growAdaptive(scene, ctx, seeds, { lim, primary, exclude: ex, tune }) : growFrom(scene, ctx, seeds, { lim, primary, exclude: ex, tune });
  let r = grow(null);
  const consoleShells = [], dropped = [];
  const tol = tune && tune.consoleTol !== undefined ? tune.consoleTol : 0.004;
  for (let round = 0; round < 2; round++) {
    const cp = consoleParts(scene, trisOfShells(scene, r.shells), lim, side, tol);
    const hits = [...cp.parts.keys()].filter((s) => !seeds.includes(s));
    const drops = tune && round === 0 ? tuneDrops(scene, r, seeds, tune).filter(([s]) => !cp.parts.has(s)) : [];
    if (!hits.length && !drops.length) break;
    exclude = new Map([...(exclude || []), ...hits.map((s) => [s, "on the console side of the seat"]), ...drops]);
    for (const s of hits) consoleShells.push(s);
    for (const [s, why] of drops) dropped.push({ shell: s, why });
    r = grow(exclude);
  }
  return { ...r, consoleShells, dropped };
}

/* What a --seed variant leaves out of a grown seat, once, from the first
   growth (judged again on a regrown seat, the top of what is left would
   look like the next headrest): with headrest: false, the headrest -- the
   shells that start above 68% of the seat's height, are at most 60% of its
   width and are centred within 20% of its width of its middle. Measured on
   the six calibrated seats: headrests start at 0.71-0.80 of the seat's
   height, 0.34-0.51 of its width, centred (0.00-0.02 off), and their posts
   and collars at 0.74-0.81, 0.10-0.14 off; the backrest's top panels that
   reach as high are 0.84-0.91 wide (the Sportage 2021, the Elantra) and its
   bolster tops 0.28-0.30 off centre (the Elantra), so they stay. A shell
   only in the top quarter missed the Camry's headrest, whose posts reach
   down to 0.71. With minShellShare, pieces smaller than that share of the
   seat's area -- stitching strips, buttons, a lever cap. The seed shell
   (the tapped one) always stays. Returns [[shell, why]]. */
function tuneDrops(scene, r, seeds, tune) {
  const F = scene.frame, S = scene.shells, u = F.up;
  const out = new Map();
  if (tune.headrest === false) {
    const w = F.wid, H = r.box.max[u] - r.box.min[u], Wd = r.box.max[w] - r.box.min[w], mid = (r.box.min[w] + r.box.max[w]) / 2;
    for (const s of r.shells) {
      if (seeds.includes(s) || S.min[s * 3 + u] < r.box.min[u] + 0.68 * H) continue;
      if (S.max[s * 3 + w] - S.min[s * 3 + w] > 0.6 * Wd || Math.abs((S.min[s * 3 + w] + S.max[s * 3 + w]) / 2 - mid) > 0.2 * Wd) continue;
      out.set(s, "the headrest (this variant leaves it out)");
    }
  }
  if (tune.minShellShare > 0) {
    let total = 0;
    for (const s of r.shells) total += S.area[s];
    for (const s of r.shells) if (!seeds.includes(s) && !out.has(s) && S.area[s] < tune.minShellShare * total) out.set(s, `pieces under ${+(tune.minShellShare * 100).toFixed(2)}% of the seat's area (this variant leaves them out)`);
  }
  return [...out];
}

function dedupeRefused(list) {
  const m = new Map();
  for (const r of list) { const c = m.get(r.shell); if (!c || r.d < c.d) m.set(r.shell, r); }
  return [...m.values()].sort((a, b) => a.d - b.d);
}

/* Nearest triangle to point p (optionally only within material groups
   `groups`): exact point-triangle distance, pruned by shell boxes. */
export function nearestTriangle(scene, p, groups = null) {
  const S = scene.shells;
  let best = Infinity, bestT = -1;
  const c = new Float32Array(9);
  const order = [];
  for (let s = 0; s < S.n; s++) {
    if (groups && !groups.has(S.group[s])) continue;
    let d2 = 0;
    for (let k = 0; k < 3; k++) { const lo = S.min[s * 3 + k], hi = S.max[s * 3 + k]; const e = p[k] < lo ? lo - p[k] : p[k] > hi ? p[k] - hi : 0; d2 += e * e; }
    order.push([d2, s]);
  }
  order.sort((a, b) => a[0] - b[0]);
  for (const [d2, s] of order) {
    if (d2 > best * best) break;
    for (let j = S.start[s]; j < S.start[s + 1]; j++) {
      const t = S.tris[j];
      triCorners(scene, t, c);
      const d = pointTriDist(p, c);
      if (d < best) { best = d; bestT = t; }
    }
  }
  return { tri: bestT, dist: best };
}

function pointTriDist(p, c) {
  // Ericson, Real-Time Collision Detection 5.1.5.
  const ax = c[0], ay = c[1], az = c[2], bx = c[3], by = c[4], bz = c[5], cx = c[6], cy = c[7], cz = c[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dist = (x, y, z) => Math.hypot(p[0] - x, p[1] - y, p[2] - z);
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return dist(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/* Proximity pieces of an arbitrary triangle selection (a box cut included):
   triangles whose surfaces come within `gapVox` voxels of each other are one
   piece. A seat is one piece; a belt guide on the pillar or a headliner strip
   caught with it is a second one. */
export function selectionPieces(scene, tris, lim) {
  // One voxel more than growth uses: grids are aligned differently, and a
  // piece only counts as apart when it is clearly apart.
  const v = lim.voxel, k = lim.gapVox + 1;
  let box = emptyBox();
  const c = new Float32Array(9);
  for (const t of tris) { triCorners(scene, t, c); for (let q = 0; q < 9; q++) { const a = q % 3; if (c[q] < box.min[a]) box.min[a] = c[q]; if (c[q] > box.max[a]) box.max[a] = c[q]; } }
  if (!tris.length) return { count: 0, sizes: [], pieceOf: new Int32Array(0) };
  const region = { min: box.min.map((x) => x - v * (k + 1)), max: box.max.map((x) => x + v * (k + 1)) };
  const nx = Math.ceil((region.max[0] - region.min[0]) / v) + 1, ny = Math.ceil((region.max[1] - region.min[1]) / v) + 1, nz = Math.ceil((region.max[2] - region.min[2]) / v) + 1;
  if (nx * ny * nz > 64e6) throw new Error("selection too large to cluster (" + nx + "x" + ny + "x" + nz + " voxels)");
  const rep = new Int32Array(nx * ny * nz).fill(-1);
  const parent = Int32Array.from(tris.keys());
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  tris.forEach((t, i) => {
    triCorners(scene, t, c);
    sampleTri(c, v * 0.5, (x, y, z) => {
      const vox = Math.floor((x - region.min[0]) / v) + nx * (Math.floor((y - region.min[1]) / v) + ny * Math.floor((z - region.min[2]) / v));
      if (rep[vox] < 0) rep[vox] = i; else union(i, rep[vox]);
    });
  });
  for (let vox = 0; vox < rep.length; vox++) {
    if (rep[vox] < 0) continue;
    const x = vox % nx, y = Math.floor(vox / nx) % ny, z = Math.floor(vox / (nx * ny));
    for (let dz = 0; dz <= k; dz++) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
      if (dz === 0 && (dy < 0 || (dy === 0 && dx <= 0))) continue;
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const r = rep[X + nx * (Y + ny * Z)];
      if (r >= 0) union(rep[vox], r);
    }
  }
  const ids = new Map();
  const pieceOf = new Int32Array(tris.length);
  const sizes = [];
  tris.forEach((t, i) => { const r = find(i); let id = ids.get(r); if (id === undefined) { id = sizes.length; ids.set(r, id); sizes.push(0); } pieceOf[i] = id; sizes[id]++; });
  return { count: sizes.length, sizes, pieceOf };
}

/* Area-weighted: which way along the length axis does this seat face? The
   backrest and headrest (the top 30% of the seat) sit behind the cushion
   (the bottom 35%), so front = from the top's centroid toward the bottom's.
   Returns { sign: +1/-1/0, strength: offset as a fraction of the seat's depth }. */
export function seatFacing(scene, tris) {
  const F = scene.frame, u = F.up, l = F.len;
  let lo = Infinity, hi = -Infinity, dLo = Infinity, dHi = -Infinity;
  for (const t of tris) { const y = scene.cen[t * 3 + u], z = scene.cen[t * 3 + l]; if (y < lo) lo = y; if (y > hi) hi = y; if (z < dLo) dLo = z; if (z > dHi) dHi = z; }
  const h = hi - lo;
  let aw = 0, az = 0, bw = 0, bz = 0;
  for (const t of tris) {
    const y = scene.cen[t * 3 + u], z = scene.cen[t * 3 + l], a = scene.area[t];
    if (y <= lo + 0.35 * h) { aw += a; az += a * z; }
    else if (y >= hi - 0.3 * h) { bw += a; bz += a * z; }
  }
  if (!aw || !bw) return { sign: 0, strength: 0 };
  const off = az / aw - bz / bw;
  const strength = Math.abs(off) / Math.max(dHi - dLo, 1e-9);
  return { sign: Math.sign(off), strength };
}

export const boxOfTris = (scene, tris) => {
  const b = emptyBox();
  const c = new Float32Array(9);
  for (const t of tris) { triCorners(scene, t, c); for (let q = 0; q < 9; q++) { const a = q % 3; if (c[q] < b.min[a]) b.min[a] = c[q]; if (c[q] > b.max[a]) b.max[a] = c[q]; } }
  return b;
};

export const trisOfShells = (scene, shells) => {
  const S = scene.shells;
  let n = 0;
  for (const s of shells) n += S.start[s + 1] - S.start[s];
  const out = new Int32Array(n);
  let o = 0;
  for (const s of shells) for (let j = S.start[s]; j < S.start[s + 1]; j++) out[o++] = S.tris[j];
  return out;
};

/* The headliner above the seat: the lowest surface over the seat's top
   (the footprint of its highest 20%, the headrest -- not the whole seat,
   because the roof slopes down toward the windscreen ahead of it) that
   belongs to a roof-sized piece (reaching the roof band, or wider or longer
   than any seat) and faces up or down -- the Optima's B-pillar trim runs
   past the backrest's outer top corner 0.002 H above it. A small part just above the headrest (its cap in another
   material, a map light) is not the ceiling. Returns the height, or
   Infinity when nothing is above. */
export function ceilingAbove(scene, tris, box, lim) {
  const F = scene.frame, S = scene.shells, u = F.up, w = F.wid, l = F.len;
  const cut = box.max[u] - 0.2 * (box.max[u] - box.min[u]);
  const fp = emptyBox();
  for (const t of tris) if (scene.cen[t * 3 + u] >= cut) for (const k of [w, l]) { const c = scene.cen[t * 3 + k]; if (c < fp.min[k]) fp.min[k] = c; if (c > fp.max[k]) fp.max[k] = c; }
  const roofy = new Uint8Array(S.n);
  for (let s = 0; s < S.n; s++) roofy[s] = S.max[s * 3 + u] > lim.roofTop || S.max[s * 3 + w] - S.min[s * 3 + w] > lim.maxW || S.max[s * 3 + l] - S.min[s * 3 + l] > lim.maxD ? 1 : 0;
  let best = Infinity;
  const c9 = new Float32Array(9);
  for (let t = 0; t < scene.T; t++) {
    const y = scene.cen[t * 3 + u];
    if (y <= box.max[u] || y >= best) continue;
    const cw = scene.cen[t * 3 + w], cl = scene.cen[t * 3 + l];
    if (cw < fp.min[w] || cw > fp.max[w] || cl < fp.min[l] || cl > fp.max[l]) continue;
    if (!roofy[scene.shellOf[t]]) continue;
    // Facing up or down: a headliner, not a pillar running past the headrest.
    triCorners(scene, t, c9);
    const ax = c9[3] - c9[0], ay = c9[4] - c9[1], az = c9[5] - c9[2], bx = c9[6] - c9[0], by = c9[7] - c9[1], bz = c9[8] - c9[2];
    const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (!nl || Math.abs(n[u]) < 0.7 * nl) continue;
    best = y;
  }
  return best;
}

/* The checks every result is held to. Returns [{ name, pass, detail }]. */
export function seatChecks(scene, tris, { lim, side, sourceTris = null, pieces = null }) {
  const F = scene.frame, u = F.up, w = F.wid, l = F.len;
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const n = tris.length;
  const b = boxOfTris(scene, tris);
  const pc = pieces || selectionPieces(scene, tris, lim);
  const main = pc.sizes.length ? Math.max(...pc.sizes) : 0;
  add("one-object", pc.count === 1, pc.count + " proximity piece(s)" + (pc.count > 1 ? " (triangles " + pc.sizes.slice().sort((a, c) => c - a).join(" + ") + "): something apart from the seat was caught" : ""));
  const dw = (b.max[w] - b.min[w]) / F.W, dh = (b.max[u] - b.min[u]) / F.H, dd = (b.max[l] - b.min[l]) / F.L;
  const sized = b.max[w] - b.min[w] <= lim.maxW && b.max[w] - b.min[w] >= lim.minW && b.max[u] - b.min[u] <= lim.maxH && b.max[u] - b.min[u] >= lim.minH && b.max[l] - b.min[l] <= lim.maxD && b.max[l] - b.min[l] >= lim.minD;
  add("seat-size", sized, `width ${dw.toFixed(3)} W, height ${dh.toFixed(3)} H, depth ${dd.toFixed(3)} L (a seat: ${(lim.minW / F.W).toFixed(2)}-${(lim.maxW / F.W).toFixed(2)} W, ${(lim.minH / F.H).toFixed(2)}-${(lim.maxH / F.H).toFixed(2)} H, ${(lim.minD / F.L).toFixed(2)}-${(lim.maxD / F.L).toFixed(2)} L)`);
  const top = (b.max[u] - F.ground) / F.H;
  const ceil = ceilingAbove(scene, tris, b, lim);
  const clear = ceil === Infinity ? null : (ceil - b.max[u]) / F.H;
  add("below-roof", b.max[u] <= lim.roofTop && b.max[u] >= lim.minTop && (clear === null || clear >= 0.015),
    `top at ${top.toFixed(3)} H (roof band from ${((lim.roofTop - F.ground) / F.H).toFixed(2)} H)` + (clear === null ? ", no ceiling found above" : `, ${clear.toFixed(3)} H below the ceiling above it`) + (b.max[u] < lim.minTop ? "; too low for a seat with a backrest" : ""));
  // The side wall: door cards, pillar trim and belt hardware start 0.34-0.37 W
  // out from the centre plane on every car measured, the seat's outer bolster
  // stops at 0.343-0.355 W.
  let beyond = 0;
  for (const t of tris) if ((scene.cen[t * 3 + w] - F.mid) * side > lim.wallEdge) beyond++;
  const reach = ((side > 0 ? b.max[w] - F.mid : F.mid - b.min[w]) / F.W);
  add("inside-walls", beyond === 0, beyond ? `${beyond} triangle(s) past ${(lim.wallEdge / F.W).toFixed(3)} W from the centre plane, in the door or pillar` : `outer edge at ${reach.toFixed(3)} W (side wall from ${(lim.wallEdge / F.W).toFixed(3)} W)`);
  let across = 0;
  for (const t of tris) if ((F.mid - scene.cen[t * 3 + w]) * side > lim.crossTol) across++;
  add("own-side", across === 0, across ? `${across} triangle(s) past the centre plane, in the other seat's half` : `all on the ${side > 0 ? "+" : "-"}${"xyz"[w]} side of the centre plane`);
  // The console: what lies wholly between the seat's inboard edge and the
  // centre line (consoleParts) -- the handbrake, buttons and lid stitching
  // own-side cannot see because they stop short of the centre plane.
  const cp = consoleParts(scene, tris, lim, side);
  add("console-clear", cp.parts.size === 0, cp.parts.size
    ? `${cp.tris} triangle(s) in ${cp.parts.size} shell(s) lie wholly inboard of the seat's inboard edge (${cp.edgeW.toFixed(3)} W from the centre plane) above its bottom: console parts`
    : `nothing inboard of the seat's inboard edge (${cp.edgeW.toFixed(3)} W from the centre plane)`);
  const maxTris = Math.min(250000, Math.max(20000, Math.floor(0.08 * scene.T)));
  const shareOk = !sourceTris || n <= 0.6 * sourceTris;
  add("triangle-count", n >= lim.minTris && n <= maxTris && shareOk, `${n} triangles (sane: ${lim.minTris}-${maxTris}` + (sourceTris ? `, and at most 60% of the ${sourceTris} in the source materials` : "") + ")");
  return checks;
}

// ---- the car's orientation ---------------------------------------------------

const AXES = { x: 0, y: 1, z: 2 };
/* "+z" -> { axis: 2, sign: 1 }. */
export function parseAxisHint(s) {
  const m = /^([+-])?([xyz])$/i.exec(String(s || "").trim());
  if (!m) return null;
  return { axis: AXES[m[2].toLowerCase()], sign: m[1] === "-" ? -1 : 1 };
}
const levi = (i, j, k) => ((i - j) * (j - k) * (k - i)) / 2;
const axisName = (sign, axis) => (sign > 0 ? "+" : "-") + "xyz"[axis];
/* Which side of the centre plane is the car's LEFT, given the sign of its
   front along the length axis: left = up x front. */
export function leftSign(F, front) { return front * levi(F.up, F.len, F.wid); }

/* A steering wheel named as such (Camry Steering_Wheel_Gray, the Maxima's
   maxima_steer): its area-weighted centre, or null. Road wheels are never
   called "steer". */
export function findSteeringWheel(scene) {
  const F = scene.frame;
  const re = /steer|lenkrad|volant|руль/i;
  const hit = scene.visits.map((v) => re.test(v.matName) || re.test(v.meshName) || re.test(v.nodeName));
  if (!hit.some(Boolean)) return null;
  const c = [0, 0, 0];
  let a = 0;
  const b = emptyBox();
  for (let t = 0; t < scene.T; t++) {
    if (!hit[scene.triVisit[t]]) continue;
    const w = scene.area[t];
    for (let k = 0; k < 3; k++) { const x = scene.cen[t * 3 + k]; c[k] += w * x; if (x < b.min[k]) b.min[k] = x; if (x > b.max[k]) b.max[k] = x; }
    a += w;
  }
  if (!a) return null;
  const centre = c.map((x) => x / a);
  // A wheel is small and sits in the cabin, off the centre line.
  if (b.max[F.len] - b.min[F.len] > 0.2 * F.L || b.max[F.wid] - b.min[F.wid] > 0.3 * F.W) return null;
  const lateral = (centre[F.wid] - F.mid) / F.W;
  if (Math.abs(lateral) < 0.05) return null;
  const names = [...new Set(scene.visits.filter((v, i) => hit[i]).map((v) => (re.test(v.matName) ? v.matName : v.meshName || v.nodeName)))];
  return { centre, lateral, names };
}

/* An export that names its seat meshes (the Maxima: maxima_seats_FL_plastic_0,
   maxima_seats_FL_white_leather_0, ... one mesh per material): the name's
   seat token plus the short position codes after it ("seats_FL") is the
   seat's key, as --mesh would take it. When most of `shells` carry one key
   and everything with that key is the size of one seat, that is the answer
   -- every material in it (the Maxima's back shell is `plastic`) and nothing
   around it. */
function seatKey(name) {
  const parts = String(name || "").split(/[_.\s-]+/);
  const i = parts.findIndex((p) => /seat/i.test(p));
  if (i < 0) return null;
  let key = parts[i];
  for (let j = i + 1; j < parts.length && parts[j].length <= 3 && !/^\d+$/.test(parts[j]); j++) key += "_" + parts[j];
  return key;
}
export function namedSeatNode(scene, shells, { lim, sources = null }) {
  const F = scene.frame, S = scene.shells;
  const keyOf = (v) => seatKey(v.meshName) || seatKey(v.nodeName);
  const count = new Map();
  let total = 0;
  for (const s of shells) { const k = keyOf(scene.visits[S.visit[s]]); total += S.count[s]; if (k) count.set(k, (count.get(k) || 0) + S.count[s]); }
  const [key, n] = [...count].sort((a, b) => b[1] - a[1])[0] || [];
  if (!key || n < 0.5 * total) return {};
  const mine = [];
  for (let s = 0; s < S.n; s++) {
    const v = scene.visits[S.visit[s]];
    if (keyOf(v) === key && v.first && (!sources || sources.has(S.group[s]))) mine.push(s);
  }
  const b = boxOfTris(scene, trisOfShells(scene, mine));
  const ok = b.max[F.wid] - b.min[F.wid] <= lim.maxW && b.max[F.up] - b.min[F.up] <= lim.maxH && b.max[F.len] - b.min[F.len] <= lim.maxD;
  if (!ok) return { warning: `meshes named *${key}* are larger than one seat; grew the seat instead` };
  return { shells: mine, mesh: key };
}

// ---- --pick ------------------------------------------------------------------

/* The seat under a tapped point (model space, what model-viewer's
   positionAndNormalFromPoint returns). `sources`: Set of material groups, or
   null for "the material under the tap". Throws with a message meant for the
   person who tapped. Two steps, so seat-split --seed can grow several
   variants from one tap: pickPlan finds the shell under the point (and
   refuses a point that is not on a seat), pickGrow grows the seat from it. */
export function pickSeat(scene, p, { lim, sources = null }) {
  return pickGrow(scene, pickPlan(scene, p, { lim, sources }), { lim, sources });
}

/* The seed shell under the point: { side, seed, near, warnings, named }. */
export function pickPlan(scene, p, { lim, sources = null }) {
  const F = scene.frame, S = scene.shells;
  const warnings = [];
  const near = nearestTriangle(scene, p, sources);
  if (near.tri < 0) throw new SeatError("no triangle found" + (sources ? " in the --source materials" : ""));
  /* model-viewer's positionAndNormalFromPoint returns a point ON a surface
     (0.05% of the length off at most, after the dial page's 4 decimals on the
     0.18-unit Altima). A point 1% of the length (~5 cm) from every surface
     is in mid-air: a point taken on another model or in another unit, and
     growing from "the nearest shell" would cut whatever happens to be
     there. Refused, not warned. */
  if (near.dist > 0.01 * F.L) throw new SeatError(`the point is ${(near.dist / F.L * 100).toFixed(1)}% of the car's length from the nearest surface${sources ? " of the --source materials" : ""} (more than 1%): it is not on this model's surface -- was it taken on another model or in other units? Tap the seat itself`);
  const lateral = p[F.wid] - F.mid;
  if (Math.abs(lateral) < 0.04 * F.W) throw new SeatError("the point is on the car's centre line (the console), not on a seat: tap the seat itself");
  const side = Math.sign(lateral);
  let seed = scene.shellOf[near.tri];
  const why = shellVeto(scene, seed, lim, side);
  if (why) {
    // A tap on a seam can land on the neighbouring trim: take the nearest
    // shell a seat could contain, if one is within ~3 cm.
    let best = Infinity, alt = -1;
    const c = new Float32Array(9);
    for (let s = 0; s < S.n; s++) {
      if (sources && !sources.has(S.group[s])) continue;
      let d2 = 0;
      for (let k = 0; k < 3; k++) { const lo = S.min[s * 3 + k], hi = S.max[s * 3 + k]; const e = p[k] < lo ? lo - p[k] : p[k] > hi ? p[k] - hi : 0; d2 += e * e; }
      if (d2 > (0.006 * F.L) ** 2 || shellVeto(scene, s, lim, side)) continue;
      for (let j = S.start[s]; j < S.start[s + 1]; j++) { triCorners(scene, S.tris[j], c); const d = pointTriDist(p, c); if (d < best) { best = d; alt = s; } }
    }
    const sizeWhy = why === "wider than a seat" || why === "longer than a seat" || why === "taller than a seat";
    if (alt < 0 || best > 0.006 * F.L) throw new SeatError(`the tapped surface (${scene.groupNames[S.group[seed]]}, ${S.count[seed]} triangles) ${why}, so it cannot be part of a seat` + (sizeWhy ? "; if the tap WAS on the seat, this export does not separate the seat from the cabin around it -- use --box with --mode tris" : "; tap the middle of the seat's backrest or cushion"));
    warnings.push(`the tapped surface ${why}; used the seat piece ${(best / F.L * 1000).toFixed(1)} permille of the car's length away`);
    seed = alt;
  }
  const named = namedSeatNode(scene, [seed], { lim, sources });
  return { side, seed, near, warnings, named };
}

/* The seat grown from pickPlan's seed. `tune` and `glim` (seat-split --seed,
   lib/seat-vary.mjs growTune): the growth's tuning and its limits -- the
   calibrated ones with another voxel and gap; null / lim = the calibrated
   seat. tune.named: false grows a named seat mesh instead of taking it whole. */
export function pickGrow(scene, plan, { lim, sources = null, tune = null, glim = lim }) {
  const S = scene.shells;
  const { side, seed, near, named } = plan;
  const warnings = plan.warnings.slice();
  if (named.shells && !(tune && tune.named === false)) return { method: "named-mesh", mesh: named.mesh, side, seed, shells: named.shells, warnings, near };
  if (named.warning) warnings.push(named.warning);
  const primary = sources || new Set([S.group[seed]]);
  const ctx = prepareRegion(scene, seatRegion(scene, [seed], lim), { lim: glim, side, keep: new Set([seed]) });
  const r = growClear(scene, ctx, [seed], { lim: glim, primary, side, adaptive: !sources, tune });
  if (r.added && r.added.length) warnings.push("the seat is also made of " + r.added.join(", ") + " (it fills the seat's footprint): grew through it too");
  return { method: "grown", side, seed, shells: r.shells, refused: r.refused, vetoed: ctx.vetoed, warnings, near, primary: r.primary || primary, consoleShells: r.consoleShells,
    dropped: r.dropped, namedSkipped: named.shells ? named.mesh : null };
}

// ---- --auto --------------------------------------------------------------------

const box3IoU = (a, b) => {
  let inter = 1, va = 1, vb = 1;
  for (let k = 0; k < 3; k++) {
    inter *= Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
    va *= a.max[k] - a.min[k]; vb *= b.max[k] - b.min[k];
  }
  return inter / (va + vb - inter || 1);
};

/* Every seat-like object on one side of the cabin: seeds are the largest
   shells where a front-row seat's cushion or backrest can sit; each grows
   like a pick, and a shell taken by one object cannot seed another. */
function seatCandidates(scene, side, { lim, sources }) {
  const F = scene.frame, S = scene.shells, w = F.wid, u = F.up, l = F.len;
  const region = { min: [...F.lo], max: [...F.hi] };
  region.min[l] = F.lo[l] + 0.12 * F.L; region.max[l] = F.hi[l] - 0.12 * F.L;
  region.min[u] = F.ground + 0.04 * F.H; region.max[u] = F.ground + 0.96 * F.H;
  if (side > 0) { region.min[w] = F.mid - lim.crossTol; region.max[w] = F.mid + 0.5 * F.W; }
  else { region.min[w] = F.mid - 0.5 * F.W; region.max[w] = F.mid + lim.crossTol; }
  const ctx = prepareRegion(scene, region, { lim, side });
  const seeds = ctx.local.filter((s) => {
    if (sources && !sources.has(S.group[s])) return false;
    const cw = ((S.min[s * 3 + w] + S.max[s * 3 + w]) / 2 - F.mid) * side / F.W;
    const cu = ((S.min[s * 3 + u] + S.max[s * 3 + u]) / 2 - F.ground) / F.H;
    return cw > 0.06 && cw < 0.32 && cu > 0.22 && cu < 0.8;
  }).sort((a, b) => S.area[b] - S.area[a]).slice(0, 40);
  const taken = new Set();
  const out = [];
  for (const seed of seeds) {
    if (taken.has(seed) || out.length >= 12) continue;
    const primary = sources || new Set([S.group[seed]]);
    const r = sources ? growFrom(scene, ctx, [seed], { lim, primary }) : growAdaptive(scene, ctx, [seed], { lim, primary });
    for (const s of r.shells) taken.add(s);
    const tris = trisOfShells(scene, r.shells);
    const b = boxOfTris(scene, tris);
    const dw = (b.max[w] - b.min[w]) / F.W, dh = (b.max[u] - b.min[u]) / F.H, dd = (b.max[l] - b.min[l]) / F.L;
    const valid = tris.length >= lim.minTris && dw * F.W >= lim.minW && dh * F.H >= lim.minH && dd * F.L >= lim.minD && b.max[u] >= lim.minTop && b.max[u] <= lim.roofTop && b.min[u] <= F.ground + 0.45 * F.H;
    const score = Math.exp(-(((dw - 0.30) / 0.07) ** 2) - (((dh - 0.6) / 0.15) ** 2));
    out.push({ side, seed, primary, ctx, shells: r.shells, tris, box: b, dims: [dw, dh, dd], valid, score, facing: seatFacing(scene, tris), refused: r.refused });
  }
  return { list: out, cells: ctx.cells, local: ctx.local.length };
}

/* The cabin's seat pairs: valid candidates either side of the centre plane
   whose boxes overlap by IoU >= 0.35 once one is mirrored, best first.
   `facing` is the way both seats of the best pair face (backrest behind the
   cushion), or 0 when they disagree or either is weaker than 0.12 of its
   depth -- the confidence --auto has always required. */
export function seatPairs(scene, { lim, sources = null }) {
  const F = scene.frame;
  const cand = [...seatCandidates(scene, 1, { lim, sources }).list, ...seatCandidates(scene, -1, { lim, sources }).list];
  const valid = cand.filter((c) => c.valid);
  const pairs = [];
  for (const a of valid) for (const b of valid) {
    if (a.side !== 1 || b.side !== -1) continue;
    const mb = { min: [...b.box.min], max: [...b.box.max] };
    mb.min[F.wid] = 2 * F.mid - b.box.max[F.wid]; mb.max[F.wid] = 2 * F.mid - b.box.min[F.wid];
    const iou = box3IoU(a.box, mb);
    if (iou < 0.35) continue;
    const c = (a.box.min[F.len] + a.box.max[F.len] + b.box.min[F.len] + b.box.max[F.len]) / 4;
    pairs.push({ a, b, iou, score: iou * Math.sqrt(a.score * b.score), centre: c });
  }
  pairs.sort((x, y) => y.score - x.score);
  const top = pairs[0] || null;
  let facing = 0;
  if (top) { const fa = top.a.facing, fb = top.b.facing; facing = fa.sign && fa.sign === fb.sign && Math.min(fa.strength, fb.strength) >= 0.12 ? fa.sign : 0; }
  return { cand, valid, pairs, top, facing };
}

/* Where does the driver sit? Every selection is judged by this (seat-split's
   driver-side check), because a seat on the wrong side passes every other
   check: the first verifier's `--auto --front -z` on the Sentra and the
   Altima, and a tap on either car's passenger seat, wrote a red passenger
   seat with all seven checks green.
     front  which way the car faces along the length axis: the front row's
            shape (seatPairs facing), else the selection's own shape
            (>= 0.12 of its depth), and a named steering wheel ahead of the
            seats; when those disagree the front is unknown. --front
            overrides, but a --front that CONTRADICTS the evidence is a
            conflict, not a note: that is how the wrong seat got written.
     side   left-hand drive puts the driver on the car's left (up x front);
            --driver right takes the other side. A named steering wheel is
            where the driver sits whatever the front: one on the right with
            no --driver is a conflict (a right-hand-drive car? say so).
   Returns { expected: +1/-1 along the width axis, or 0 when it cannot
   tell; front; conflicts: [...]; warnings: [...]; why }. */
export function driverSide(scene, { front = null, driver = null, pairFacing = 0, pairCentre = null, tris = null, wheel = undefined }) {
  const F = scene.frame;
  const conflicts = [], warnings = [], from = [];
  if (wheel === undefined) wheel = findSteeringWheel(scene);
  let selFacing = 0, ref = pairCentre;
  if (tris && tris.length) {
    const fc = seatFacing(scene, tris);
    if (fc.strength >= 0.12) selFacing = fc.sign;
    if (ref === null) { const b = boxOfTris(scene, tris); ref = (b.min[F.len] + b.max[F.len]) / 2; }
  }
  const shape = pairFacing || selFacing;
  const shapeFrom = pairFacing ? "the front seats' shape" : "the seat's shape";
  let fWheel = 0;
  if (wheel && ref !== null) { const d = wheel.centre[F.len] - ref; if (Math.abs(d) > 0.03 * F.L) fWheel = Math.sign(d); }
  let inferred = shape || fWheel;
  if (shape && fWheel && shape !== fWheel) {
    conflicts.push(`${shapeFrom} says the car faces ${axisName(shape, F.len)} but the steering wheel (${wheel.names.join(", ")}) is toward ${axisName(fWheel, F.len)}`);
    inferred = 0;
  }
  let f;
  if (front) {
    f = front.sign;
    const against = [shape && shape !== f && `${shapeFrom} (backrest behind the cushion) says ${axisName(shape, F.len)}`, fWheel && fWheel !== f && `the steering wheel (${wheel.names.join(", ")}) is toward ${axisName(fWheel, F.len)}`].filter(Boolean);
    if (against.length) conflicts.push(`--front ${axisName(f, F.len)} contradicts the model: ${against.join(" and ")}`);
    from.push("--front");
  } else {
    f = inferred;
    if (shape && f === shape) from.push(shapeFrom);
    if (fWheel && f === fWheel) from.push("the steering wheel");
  }
  const left = f ? leftSign(F, f) : 0;
  const wSide = wheel ? Math.sign(wheel.lateral) : 0;
  let expected = 0;
  if (driver) {
    expected = f ? (driver === "right" ? -left : left) : 0;
    if (expected && wSide && wSide !== expected) warnings.push(`--driver ${driver} puts the driver on the ${axisName(expected, F.wid)} side, but the file's steering wheel (${wheel.names.join(", ")}) is on the ${axisName(wSide, F.wid)} side`);
  } else if (wSide) {
    if (f && wSide !== left) conflicts.push(`the steering wheel (${wheel.names.join(", ")}) is on the car's right, but a left-hand-drive driver sits on the left: pass --driver right for a right-hand-drive car, or --driver left`);
    expected = f ? left : wSide;
  } else expected = left;
  const why = expected
    ? `the driver sits on the ${axisName(expected, F.wid)} side (` + (f ? `front ${axisName(f, F.len)} from ${from.join(" and ")}, ` : "") + (driver ? `--driver ${driver}` : wSide && !f ? "the steering wheel's side" : "left-hand drive") + ")"
    : "cannot tell which side the driver sits on: " + (driver && !f ? `--driver ${driver} needs the car's front, ` : "") + "no confident seat shape and no steering wheel named in the file give the car's front; pass --front +" + "xyz"[F.len] + " or -" + "xyz"[F.len];
  return { expected, front: f, conflicts, warnings, why, wheel };
}

/* The driver's seat without a tap. Finds the front row as the best-matching
   mirror-image pair of seat-like objects either side of the centre plane,
   decides which way the car faces (the seats' own shape -- backrest behind
   the cushion -- and a steering wheel if the export names one, or --front),
   and takes the car's left seat (left-hand drive), or --driver's side; the
   chosen seat is grown again from its seed without the console
   (growClear). Throws with what it found when it cannot decide. A --front
   that contradicts the seats or the wheel is NOT thrown: it comes back in
   `conflicts`, which fail seat-split's driver-side check, so --force can
   still write what the hint asked for.
   Two steps, so seat-split --seed can grow several variants of the one
   driver's seat: autoPlan finds the front row, the front and the driver's
   side (calibrated, never varied -- that is what decides WHICH seat), and
   autoGrow grows the chosen seat. */
export function autoSeat(scene, opts) {
  return autoGrow(scene, autoPlan(scene, opts), opts);
}

export function autoPlan(scene, { lim, sources = null, front = null, driver = null }) {
  const F = scene.frame;
  const notes = [];
  if (front && front.axis !== F.len) throw new SeatError(`--front ${axisName(front.sign, front.axis)} is not the car's length axis (${"xyz"[F.len]})`);
  const { cand, valid, pairs, top, facing } = seatPairs(scene, { lim, sources });
  const centreOf = (c) => c.box.min.map((v, k) => +((v + c.box.max[k]) / 2).toPrecision(6));
  if (!pairs.length) {
    const best = valid.sort((x, y) => y.score - x.score)[0];
    throw new SeatError("no mirror-image pair of front seats found" + (best ? `; the most seat-like object (${best.tris.length} triangles) is on the ${axisName(best.side, F.wid)} side -- if that is the driver's seat, run --pick ${centreOf(best).join(",")}` : " and nothing seat-like at all: does this export have a cabin?"));
  }
  const fa = top.a.facing, fb = top.b.facing;
  const wheel = findSteeringWheel(scene);
  let fWheel = 0;
  if (wheel) { const d = wheel.centre[F.len] - top.centre; if (Math.abs(d) > 0.03 * F.L) fWheel = Math.sign(d); }
  let f;
  if (front) f = front.sign;
  else {
    if (facing && fWheel && facing !== fWheel) throw new SeatError(`cannot tell which way the car faces: the seats' shape says ${axisName(facing, F.len)}, the steering wheel (${wheel.names.join(", ")}) says ${axisName(fWheel, F.len)}; pass --front`);
    f = facing || fWheel;
    if (!f) throw new SeatError(`cannot tell which way the car faces (seat shape ${fa.strength.toFixed(2)} / ${fb.strength.toFixed(2)}, ${wheel ? "steering wheel level with the seats" : "no steering wheel named in the file"}); pass --front +${"xyz"[F.len]} or -${"xyz"[F.len]}, or use --pick`);
    notes.push(`front is ${axisName(f, F.len)} (from ${[facing && "the seats' shape", fWheel && "the steering wheel"].filter(Boolean).join(" and ")})`);
  }
  // The front row: the frontmost good pair (a rear row can pair up too).
  const good = pairs.filter((p) => p.score >= 0.5 * top.score && (!p.a.facing.sign || p.a.facing.sign === f || p.a.facing.strength < 0.12));
  const row = good.sort((x, y) => (y.centre - x.centre) * f)[0] || top;
  const fromRear = (f > 0 ? row.centre - F.lo[F.len] : F.hi[F.len] - row.centre) / F.L;
  if (fromRear < 0.33) throw new SeatError(`the best seat pair sits ${(fromRear * 100).toFixed(0)}% of the length from the rear: that is a rear row, and no front row was found; use --pick`);
  const left = leftSign(F, f);
  const dSide = driver === "right" ? -left : left;
  if (wheel && !driver && Math.sign(wheel.lateral) !== dSide) throw new SeatError(`the steering wheel (${wheel.names.join(", ")}) is on the car's right but a left-hand-drive driver sits on the left: pass --driver left or --driver right`);
  if (wheel) notes.push(`steering wheel ${wheel.names.join(", ")} on the ${Math.sign(wheel.lateral) === left ? "left" : "right"}`);
  const seat = row.a.side === dSide ? row.a : row.b;
  const common = { side: dSide, front: f, pair: row, candidates: cand.length, pairs: pairs.length, wheel, pairFacing: facing, pairCentre: top.centre };
  const named = namedSeatNode(scene, seat.shells, { lim, sources });
  return { seat, row, fromRear, dSide, notes, named, common };
}

/* The driver's seat autoPlan chose, grown. `tune`/`glim` as for pickGrow;
   with another voxel or gap the proximity graph is rebuilt over the part of
   the plan's half-cabin region a seat grown from that seed can reach. */
export function autoGrow(scene, plan, { lim, sources = null, driver = null, tune = null, glim = lim }) {
  const F = scene.frame;
  const { seat, row, fromRear, dSide, named } = plan;
  const notes = plan.notes.slice();
  const common = { ...plan.common, notes };
  if (named.shells && !(tune && tune.named === false)) { notes.push(`most of it is mesh ${named.mesh}: took that whole mesh`); return { method: "auto+named-mesh", mesh: named.mesh, shells: named.shells, refused: [], consoleShells: [], ...common }; }
  if (named.warning) notes.push(named.warning);
  let ctx = seat.ctx;
  if (glim.voxel !== lim.voxel || glim.gapVox !== lim.gapVox) {
    const a = seat.ctx.region, b = seatRegion(scene, [seat.seed], lim);
    ctx = prepareRegion(scene, { min: a.min.map((v, k) => Math.max(v, b.min[k])), max: a.max.map((v, k) => Math.min(v, b.max[k])) }, { lim: glim, side: dSide });
  }
  // The chosen candidate, grown again from its seed without the console.
  const r = growClear(scene, ctx, [seat.seed], { lim: glim, primary: seat.primary, side: dSide, adaptive: !sources, tune });
  notes.push(`front-row pair: mirror overlap ${row.iou.toFixed(2)}, ${(fromRear * 100).toFixed(0)}% of the length from the rear; driver (${driver || "left, LHD"}) on the ${axisName(dSide, F.wid)} side`);
  return { method: "auto", shells: r.shells, refused: r.refused, consoleShells: r.consoleShells, dropped: r.dropped, namedSkipped: named.shells ? named.mesh : null, ...common };
}
