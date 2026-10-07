/* cabin-find: which surfaces of a car are its CABIN -- the passenger
   compartment's dash, door cards, seats, carpet, headliner, pillar trims --
   found from the air around them, not from boxes or material names.

   Why air: Sketchfab exports mix cabin and body in one material (the Camry's
   Index_0_1 atlas holds the dash, the wheels and the lamps; the Maxima's
   black.002 the door cards and the sills), so no material list can say which
   triangles are inside. And a box cannot either: the door card and the door
   skin it is bolted to are 5-10 cm apart, the dash top and the cowl under
   the windscreen less. What tells them apart is which AIR a surface faces:
   the door skin faces the street, the door card faces the cabin.

   So the car is voxelised (every surface, glass included: glass closes the
   cabin), and the empty space is split into
     outside  everything a probe ball of radius r can reach from beyond the
              car -- the morphological opening of the free space. A ball of
              ~5 cm cannot squeeze through a panel gap, a door-card seam or
              the slot a window drops into, so the cabin stays closed even
              where the export leaves small holes;
     cabin    the largest enclosed pocket the same ball fits in (the cabin's
              air, from the floor to the headliner, the footwells, an SUV's
              cargo bay), chosen at the driver's seat when the file has one;
     other    smaller pockets: the inside of a door, a closed trunk, the
              space behind the dash.
   Every triangle is then sampled and asked what lies within k voxels of it:
   cabin air, outside air, both (a single-skin pillar), or neither (a
   bracket inside the dash). Shell by shell (lib/seat-scene.mjs: welded
   pieces inside one primitive, so a door card comes whole) that becomes the
   share of its area facing the cabin, the share facing outside, and the
   share inside the cabin ENVELOPE -- the cabin air plus its walls -- that
   cabin-black.mjs decides with.

   Units: everything in voxels of the car's own size (seat-scene carFrame:
   L, W, H, up/length/width axes), so the Altima's 0.18-unit toy and the
   Optima's inches read like the metre cars. */
import { triCorners } from "./seat-scene.mjs";

// Bits of the voxel flag grid.
export const SOLID = 1, OUT = 2, CAB = 4, EDGE = 64;

/* Surface samples of a triangle at spacing <= step (as seat-find's
   sampleTri): corners and centroid for a small triangle, a barycentric grid
   for a large one. */
export function sampleTri(c, step, cb) {
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

/* The grid: voxel v = L / res over the car's robust extents (seat-scene
   carFrame's area quantiles, so the Corolla's stray gauge meshes a metre
   above the roof do not stretch it), plus a margin wide enough for the
   probe to go round the car. Surfaces outside it are simply not voxelised:
   they are outside by definition. */
export function makeGrid(scene, { res, pad }) {
  const F = scene.frame;
  const v = F.L / res;
  const min = [0, 0, 0], max = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const ext = F.hi[k] - F.lo[k];
    min[k] = F.lo[k] - 0.04 * ext - pad * v;
    max[k] = F.hi[k] + 0.04 * ext + pad * v;
  }
  const nx = Math.ceil((max[0] - min[0]) / v) + 1, ny = Math.ceil((max[1] - min[1]) / v) + 1, nz = Math.ceil((max[2] - min[2]) / v) + 1;
  const N = nx * ny * nz;
  if (N > 60e6) throw new Error(`voxel grid too large (${nx}x${ny}x${nz})`);
  const flag = new Uint8Array(N);
  // The outermost layer: never expanded from, so neighbour offsets never
  // leave the array (no per-step coordinate checks).
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) flag[x + nx * (y + ny * z)] |= EDGE;
  }
  const n26 = [], n6 = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy && !dz) continue;
    const o = dx + nx * (dy + ny * dz);
    n26.push(o);
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) n6.push(o);
  }
  const at = (x, y, z) => {
    const i = Math.floor((x - min[0]) / v), j = Math.floor((y - min[1]) / v), k = Math.floor((z - min[2]) / v);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return i + nx * (j + ny * k);
  };
  return { v, min, max, nx, ny, nz, N, flag, n26: Int32Array.from(n26), n6: Int32Array.from(n6), at };
}

/* Marks every voxel a surface passes through as SOLID. `skip(visitIndex)`
   leaves a primitive out (nothing is, by default: glass closes the cabin). */
export function rasterize(scene, g, skip = null) {
  const c = new Float32Array(9);
  const step = g.v * 0.5;
  const { flag, nx, ny, nz } = g;
  const iv = 1 / g.v, x0 = g.min[0], y0 = g.min[1], z0 = g.min[2];
  const mark = (x, y, z) => {
    const i = Math.floor((x - x0) * iv), j = Math.floor((y - y0) * iv), k = Math.floor((z - z0) * iv);
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) flag[i + nx * (j + ny * k)] |= SOLID;
  };
  for (let t = 0; t < scene.T; t++) {
    if (skip && skip(scene.triVisit[t])) continue;
    triCorners(scene, t, c);
    const e = Math.max(Math.abs(c[3] - c[0]) + Math.abs(c[4] - c[1]) + Math.abs(c[5] - c[2]), Math.abs(c[6] - c[0]) + Math.abs(c[7] - c[1]) + Math.abs(c[8] - c[2]), Math.abs(c[6] - c[3]) + Math.abs(c[7] - c[4]) + Math.abs(c[8] - c[5]));
    if (e <= step) { mark(c[0], c[1], c[2]); mark(c[3], c[4], c[5]); mark(c[6], c[7], c[8]); continue; }
    sampleTri(c, step, mark);
  }
}

/* Chessboard distance (in voxels) from the nearest SOLID voxel, capped at
   cap: multi-source BFS over the 26-neighbourhood. */
export function distanceField(g, cap) {
  const { flag, N, n26 } = g;
  const dist = new Uint8Array(N).fill(255);
  let front = [];
  for (let i = 0; i < N; i++) if (flag[i] & SOLID) { dist[i] = 0; front.push(i); }
  for (let d = 1; d <= cap && front.length; d++) {
    const next = [];
    for (const i of front) {
      if (flag[i] & EDGE) continue;
      for (const o of n26) { const j = i + o; if (dist[j] === 255) { dist[j] = d; next.push(j); } }
    }
    front = next;
  }
  return dist;
}

/* Connected pieces (6-neighbourhood) of the voxels where `inSet(i)`. Returns
   { label: Int32Array (-1 = not in the set), size[], edge[] (reaches the
   grid's outer layer) }. The outer layer itself is never labelled: a piece
   that reaches it is outside. */
export function components(g, inSet) {
  const { N, flag, n6 } = g;
  const label = new Int32Array(N).fill(-1);
  const size = [], edge = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || (flag[s] & EDGE) || !inSet(s)) continue;
    const id = size.length;
    let n = 0, top = 0, e = false;
    label[s] = id; stack[top++] = s;
    while (top) {
      const i = stack[--top];
      n++;
      for (const o of n6) {
        const j = i + o;
        if (label[j] !== -1 || !inSet(j)) continue;
        if (flag[j] & EDGE) { e = true; continue; }
        label[j] = id; stack[top++] = j;
      }
    }
    size.push(n); edge.push(e);
  }
  return { label, size, edge };
}

/* Grows a set by `steps` voxels over the 26-neighbourhood: from the voxels
   where seed(i), through voxels where pass(j), marking `bit`. */
export function dilate(g, seed, pass, steps, bit) {
  const { flag, N, n26 } = g;
  let front = [];
  for (let i = 0; i < N; i++) if (seed(i)) { flag[i] |= bit; front.push(i); }
  for (let d = 0; d < steps && front.length; d++) {
    const next = [];
    for (const i of front) {
      if (flag[i] & EDGE) continue;
      for (const o of n26) { const j = i + o; if (!(flag[j] & bit) && pass(j)) { flag[j] |= bit; next.push(j); } }
    }
    front = next;
  }
}

/* The canopy: the columns of the car's plan (length x width) that lie under
   its greenhouse -- the window glass and the roof between it. The cabin is
   under the canopy; the engine bay (under the bonnet) and most of a sedan's
   boot (under the boot lid) are not. Without this the cabin's air runs on
   into whatever the export left open to it: the Elantra has no firewall, so
   its engine bay is one pocket with the footwells, and its boot one with
   the rear bench -- all of it "cabin" by connection alone.
     glass   the see-through glass shells that reach the roof line (their top
             above 0.8 H): windscreen, side windows, rear window, sunroof.
             Lamp lenses stop below 0.75 H on every car measured.
     roof    columns whose highest surface is above roofLine (0.82 H; the
             roof is at 0.93-1.0 H, a sedan's bonnet and boot lid stay below
             0.75 H, the Sportage's bonnet below 0.72 H).
   The two are closed over the pillars (a 2D closing of `close` cells, the
   gap a pillar leaves between two panes), their holes filled, and the
   result grown by `margin` cells (the toe board and the pedals sit a little
   ahead of the windscreen's foot). Returns { plan: Uint8Array over the
   plan, 1 = under the canopy; PL, PW; glassShells; cells; len: [lo, hi] }. */
export function canopyPlan(scene, g, { glassVisit, roofLine, close, margin }) {
  const F = scene.frame, S = scene.shells;
  const dims = [g.nx, g.ny, g.nz];
  const PL = dims[F.len], PW = dims[F.wid], PU = dims[F.up];
  const plan = new Uint8Array(PL * PW);
  const st = [1, g.nx, g.nx * g.ny];
  // The roof: columns with a surface above the roof line.
  const roofIdx = Math.max(0, Math.floor((F.ground + roofLine * F.H - g.min[F.up]) / g.v));
  for (let l = 0; l < PL; l++) for (let w = 0; w < PW; w++) {
    for (let u = PU - 1; u >= roofIdx; u--) {
      if (g.flag[l * st[F.len] + w * st[F.wid] + u * st[F.up]] & SOLID) { plan[l + PL * w] = 1; break; }
    }
  }
  // The glass that reaches the roof line.
  let glassShells = 0;
  const c = new Float32Array(9);
  for (let s = 0; s < S.n; s++) {
    if (!glassVisit || !glassVisit[S.visit[s]]) continue;
    if ((S.max[s * 3 + F.up] - F.ground) / F.H < 0.8) continue;
    glassShells++;
    for (let j = S.start[s]; j < S.start[s + 1]; j++) {
      triCorners(scene, S.tris[j], c);
      sampleTri(c, g.v * 0.5, (x, y, z) => {
        const p = [x, y, z];
        const l = Math.floor((p[F.len] - g.min[F.len]) / g.v), w = Math.floor((p[F.wid] - g.min[F.wid]) / g.v);
        if (l >= 0 && w >= 0 && l < PL && w < PW) plan[l + PL * w] = 1;
      });
    }
  }
  // 2D chessboard dilation (val 1) or erosion (val 0), n cells.
  const grow = (src, n, val) => {
    let cur = src;
    for (let it = 0; it < n; it++) {
      const nxt = cur.slice();
      for (let l = 0; l < PL; l++) for (let w = 0; w < PW; w++) {
        if (cur[l + PL * w] === val) continue;
        let hit = false;
        for (let dl = -1; dl <= 1 && !hit; dl++) for (let dw = -1; dw <= 1; dw++) {
          const L2 = l + dl, W2 = w + dw;
          const v = L2 < 0 || W2 < 0 || L2 >= PL || W2 >= PW ? 0 : cur[L2 + PL * W2];
          if (v === val) { hit = true; break; }
        }
        if (hit) nxt[l + PL * w] = val;
      }
      cur = nxt;
    }
    return cur;
  };
  let closed = grow(grow(plan, close, 1), close, 0);
  // Fill holes: whatever the plan's border cannot reach through open cells.
  const seen = new Uint8Array(PL * PW);
  const stack = [];
  for (let l = 0; l < PL; l++) stack.push(l, l + PL * (PW - 1));
  for (let w = 0; w < PW; w++) stack.push(PL * w, PL - 1 + PL * w);
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || closed[i]) continue;
    seen[i] = 1;
    const l = i % PL, w = Math.floor(i / PL);
    if (l > 0) stack.push(i - 1);
    if (l < PL - 1) stack.push(i + 1);
    if (w > 0) stack.push(i - PL);
    if (w < PW - 1) stack.push(i + PL);
  }
  for (let i = 0; i < PL * PW; i++) if (!seen[i]) closed[i] = 1;
  if (margin > 0) closed = grow(closed, margin, 1);
  let cells = 0, lmin = Infinity, lmax = -Infinity;
  for (let l = 0; l < PL; l++) for (let w = 0; w < PW; w++) if (closed[l + PL * w]) { cells++; if (l < lmin) lmin = l; if (l > lmax) lmax = l; }
  return { plan: closed, PL, PW, glassShells, cells, len: [g.min[F.len] + lmin * g.v, g.min[F.len] + (lmax + 1) * g.v] };
}

/* Grows OUT and CAB together, one voxel per step, into the free voxels
   neither holds, up to `steps`: a narrow space takes the label of the air
   nearest to it along free space (a slot that joins the two is split where
   the fronts meet). 26-neighbourhood. */
export function claimGaps(g, steps) {
  const { flag, N, n26 } = g;
  let front = [];
  for (let i = 0; i < N; i++) if (flag[i] & (OUT | CAB)) front.push(i);
  for (let d = 0; d < steps && front.length; d++) {
    const next = [];
    for (const i of front) {
      if (flag[i] & EDGE) continue;
      const lab = flag[i] & (OUT | CAB);
      for (const o of n26) {
        const j = i + o;
        const f = flag[j];
        if (f & (SOLID | OUT | CAB)) continue;
        flag[j] = f | lab;
        next.push(j);
      }
    }
    front = next;
  }
}

export const DCAB_CAP = 24;
/* Chessboard distance (voxels) of every voxel from the cabin's air, through
   solid and free alike, capped at `cap` (cap = farther). */
export function cabinDistance(g, cap) {
  const { flag, N, n26 } = g;
  const d = new Uint8Array(N).fill(cap);
  let front = [];
  for (let i = 0; i < N; i++) if (flag[i] & CAB) { d[i] = 0; front.push(i); }
  for (let k = 1; k < cap && front.length; k++) {
    const next = [];
    for (const i of front) {
      if (flag[i] & EDGE) continue;
      for (const o of n26) { const j = i + o; if (d[j] > k) { d[j] = k; next.push(j); } }
    }
    front = next;
  }
  return d;
}

/* The whole air analysis. opts:
     res     voxels along the car's length (v = L / res)
     probe   the probe ball's radius r in voxels: free space narrower than
             2r+1 voxels is not passable
     gap     narrow spaces next to the cabin or the outside air (the probe
             cannot enter them) join that air up to this many voxels away
     seat    world-space box of the driver's seat, or null: the cabin is the
             pocket over its cushion; without it, the pocket over the middle
             of the car between the front seats' heads
     glassVisit  Uint8Array over scene.visits, 1 = see-through glass (for
             the canopy); canopy: { roofLine, close, margin } (canopyPlan)
   Returns { g, dcab (each voxel's distance from the cabin air, capped at
   DCAB_CAP), cabin: { voxels, box (world), core }, canopy, pockets, fail }
   -- fail is a message when no closed cabin was found. */
export function analyseAir(scene, opts) {
  const F = scene.frame;
  const { res, probe: r, gap } = opts;
  const g = makeGrid(scene, { res, pad: r + 3 });
  rasterize(scene, g);
  const dist = distanceField(g, r + 1);
  const { flag } = g;
  const core = (i) => !(flag[i] & SOLID) && dist[i] > r;
  // Outside: the probe-reachable free space connected to the grid's border.
  const comp = components(g, core);
  const outsideIds = new Set(comp.size.map((_, i) => i).filter((i) => comp.edge[i]));
  const outsideCore = (i) => comp.label[i] >= 0 && outsideIds.has(comp.label[i]);
  // The cabin: enclosed probe-reachable space under the canopy.
  const canopy = canopyPlan(scene, g, { glassVisit: opts.glassVisit, ...opts.canopy });
  const under = new Uint8Array(g.N);
  {
    const c = [0, 0, 0];
    for (let z = 0, i = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++, i++) {
      c[0] = x; c[1] = y; c[2] = z;
      if (canopy.plan[c[F.len] + canopy.PL * c[F.wid]]) under[i] = 1;
    }
  }
  const cab = components(g, (i) => under[i] && core(i) && !outsideCore(i));
  // Where the cabin's air must be: over the driver's seat cushion, or else
  // the middle of the car at head height between the front seats.
  const probeBox = (() => {
    const b = { min: [0, 0, 0], max: [0, 0, 0] };
    if (opts.seat) {
      const s = opts.seat;
      for (let a = 0; a < 3; a++) {
        const lo = s.min[a], hi = s.max[a], mid = (lo + hi) / 2, half = (hi - lo) / 2;
        if (a === F.up) { b.min[a] = lo + 0.45 * (hi - lo); b.max[a] = hi + 0.1 * F.H; }
        else { b.min[a] = mid - 0.6 * half; b.max[a] = mid + 0.6 * half; }
      }
    } else {
      b.min[F.wid] = F.mid - 0.12 * F.W; b.max[F.wid] = F.mid + 0.12 * F.W;
      b.min[F.up] = F.ground + 0.45 * F.H; b.max[F.up] = F.ground + 0.8 * F.H;
      const c = (F.lo[F.len] + F.hi[F.len]) / 2;
      b.min[F.len] = c - 0.12 * F.L; b.max[F.len] = c + 0.12 * F.L;
    }
    return b;
  })();
  const hits = new Map();
  let outsideHits = 0;
  for (let z = probeBox.min[2]; z <= probeBox.max[2]; z += g.v) for (let y = probeBox.min[1]; y <= probeBox.max[1]; y += g.v) for (let x = probeBox.min[0]; x <= probeBox.max[0]; x += g.v) {
    const i = g.at(x, y, z);
    if (i < 0) continue;
    const l = cab.label[i];
    if (l >= 0) hits.set(l, (hits.get(l) || 0) + 1);
    else if (outsideCore(i)) outsideHits++;
  }
  let cabinId = -1, fail = null;
  if (hits.size) cabinId = [...hits].sort((a, b) => cab.size[b[0]] - cab.size[a[0]])[0][0];
  else fail = outsideHits
    ? "the cabin is open to the outside: the air over the " + (opts.seat ? "driver's seat" : "front seats") + " connects to the air around the car through a gap wider than the probe (a missing window?)"
    : "no air found over the " + (opts.seat ? "driver's seat" : "front seats") + ": is there a cabin in this export?";
  // Outside and cabin air: their probe-reachable cores grown back by r
  // through free voxels (the opening).
  dilate(g, outsideCore, (j) => !(flag[j] & SOLID), r, OUT);
  if (cabinId >= 0) dilate(g, (i) => cab.label[i] === cabinId, (j) => !(flag[j] & SOLID), r, CAB);
  // What a surface faces: the air within k voxels, through anything.
  // The narrow spaces the probe cannot enter (the wedge where the dash meets
  // the windscreen, a panel gap, the tyre's clearance in its arch) belong to
  // whichever air reaches them first through free space, up to `gap` voxels.
  claimGaps(g, gap);
  // How far every voxel is from the cabin's air (through anything, capped):
  // the envelope a cabin surface lies in is "within m voxels of it".
  const dcab = cabinDistance(g, DCAB_CAP);
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let cabVox = 0;
  if (cabinId >= 0) {
    for (let z = 0, i = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++, i++) {
      if (!(flag[i] & CAB)) continue;
      cabVox++;
      const p = [g.min[0] + (x + 0.5) * g.v, g.min[1] + (y + 0.5) * g.v, g.min[2] + (z + 0.5) * g.v];
      for (let a = 0; a < 3; a++) { if (p[a] < box.min[a]) box.min[a] = p[a]; if (p[a] > box.max[a]) box.max[a] = p[a]; }
    }
  }
  const pockets = cab.size.map((n, id) => ({ id, n })).filter((p) => p.id !== cabinId).sort((a, b) => b.n - a.n);
  return { g, dist, dcab, cabinId, cabin: { voxels: cabVox, box, core: cabinId >= 0 ? cab.size[cabinId] : 0 }, canopy, outsideIds, pockets, probeBox, fail };
}

/* Per triangle: what its surface faces. Each surface sample looks along
   the triangle's normal, both ways, for the first free voxel within ~2
   voxels (0.6, 1.3, 2.0 v): cabin air, outside air, or neither (another
   pocket, or solid all the way: a face pressed against another part). A
   ray along the normal and not a ball around the sample, so a tyre 2 cm
   under a thin wheel-arch panel does not "face" the cabin above the arch.
   Fractions of the samples (0..255): facing cabin air only, outside air
   only, and both (a single-skin part between the two: a pillar, a sunroof
   blind); and how far the triangle lies from the cabin's air, in voxels,
   capped: envDist at its centroid (what the area shares use), envNear at
   the nearest of its corners and centroid (a triangle lies outside the
   envelope only when all of it does: one big carpet triangle can reach
   from the footwell under the engine bay). */
export function triangleFaces(scene, g, dcab) {
  const T = scene.T;
  const fCab = new Uint8Array(T), fOut = new Uint8Array(T), fBoth = new Uint8Array(T), envDist = new Uint8Array(T), envNear = new Uint8Array(T);
  const c = new Float32Array(9);
  // Samples one voxel apart: what a surface faces is a per-voxel answer, and
  // a triangle smaller than a voxel (most of a dense cabin) is asked once,
  // at its centroid.
  const step = g.v;
  const { flag } = g;
  const s0 = 0.6 * g.v, s1 = 1.3 * g.v, s2 = 2.0 * g.v;
  const gnx = g.nx, gny = g.ny, gnz = g.nz, iv = 1 / g.v, x0 = g.min[0], y0 = g.min[1], z0 = g.min[2];
  let nx = 0, ny = 0, nz = 0;
  const probe = (x, y, z) => {
    const i = Math.floor((x - x0) * iv), j = Math.floor((y - y0) * iv), k = Math.floor((z - z0) * iv);
    if (i < 0 || j < 0 || k < 0 || i >= gnx || j >= gny || k >= gnz) return -1;
    return flag[i + gnx * (j + gny * k)];
  };
  const side = (x, y, z, sgn) => {
    let f = probe(x + sgn * nx * s0, y + sgn * ny * s0, z + sgn * nz * s0);
    if (f < 0) return OUT;
    if (!(f & SOLID)) return f & (OUT | CAB);
    f = probe(x + sgn * nx * s1, y + sgn * ny * s1, z + sgn * nz * s1);
    if (f < 0) return OUT;
    if (!(f & SOLID)) return f & (OUT | CAB);
    f = probe(x + sgn * nx * s2, y + sgn * ny * s2, z + sgn * nz * s2);
    if (f < 0) return OUT;
    if (!(f & SOLID)) return f & (OUT | CAB);
    return 0;
  };
  let n = 0, a = 0, b = 0, ab = 0;
  const one = (x, y, z) => {
    n++;
    const s = side(x, y, z, 1) | side(x, y, z, -1);
    const sc = s & CAB, so = s & OUT;
    if (sc && so) ab++; else if (sc) a++; else if (so) b++;
  };
  const step2 = step * step;
  for (let t = 0; t < T; t++) {
    triCorners(scene, t, c);
    const ux = c[3] - c[0], uy = c[4] - c[1], uz = c[5] - c[2], wx = c[6] - c[0], wy = c[7] - c[1], wz = c[8] - c[2];
    nx = uy * wz - uz * wy; ny = uz * wx - ux * wz; nz = ux * wy - uy * wx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    n = 0; a = 0; b = 0; ab = 0;
    let e = DCAB_CAP, ec = DCAB_CAP;
    for (let q = 0; q < 4; q++) {
      const x = q < 3 ? c[q * 3] : (c[0] + c[3] + c[6]) / 3, y = q < 3 ? c[q * 3 + 1] : (c[1] + c[4] + c[7]) / 3, z = q < 3 ? c[q * 3 + 2] : (c[2] + c[5] + c[8]) / 3;
      const i = g.at(x, y, z);
      const dd = i < 0 ? DCAB_CAP : dcab[i];
      if (dd < e) e = dd;
      if (q === 3) ec = dd;
    }
    const vx = c[6] - c[3], vy = c[7] - c[4], vz = c[8] - c[5];
    const e2 = Math.max(ux * ux + uy * uy + uz * uz, wx * wx + wy * wy + wz * wz, vx * vx + vy * vy + vz * vz);
    if (e2 <= step2) one((c[0] + c[3] + c[6]) / 3, (c[1] + c[4] + c[7]) / 3, (c[2] + c[5] + c[8]) / 3);
    else sampleTri(c, step, one);
    fCab[t] = Math.round(255 * a / n); fOut[t] = Math.round(255 * b / n); fBoth[t] = Math.round(255 * ab / n); envDist[t] = ec; envNear[t] = e;
  }
  return { fCab, fOut, fBoth, envDist, envNear };
}

/* Per shell: its area and the area facing cabin air only, outside air only,
   both, neither (hidden); and envArea[s * (DCAB_CAP + 1) + d], the area of
   its triangles lying exactly d voxels from the cabin air (so the area
   within any margin m is a prefix sum, for every --seed variant's
   envelope without re-sampling). */
export function shellFaces(scene, faces) {
  const S = scene.shells, D = DCAB_CAP + 1;
  const out = { cab: new Float64Array(S.n), out: new Float64Array(S.n), both: new Float64Array(S.n), hidden: new Float64Array(S.n), area: new Float64Array(S.n), envArea: new Float64Array(S.n * D) };
  for (let s = 0; s < S.n; s++) {
    for (let j = S.start[s]; j < S.start[s + 1]; j++) {
      const t = S.tris[j], a = scene.area[t];
      const fc = faces.fCab[t] / 255, fo = faces.fOut[t] / 255, fb = faces.fBoth[t] / 255;
      out.area[s] += a;
      out.cab[s] += a * fc;
      out.out[s] += a * fo;
      out.both[s] += a * fb;
      out.hidden[s] += a * Math.max(0, 1 - fc - fo - fb);
      out.envArea[s * D + Math.min(DCAB_CAP, faces.envDist[t])] += a;
    }
  }
  return out;
}
/* The share of shell s's area within m voxels of the cabin air. */
export function envShare(sf, s, m) {
  const D = DCAB_CAP + 1;
  let a = 0;
  for (let d = 0; d <= Math.min(m, DCAB_CAP); d++) a += sf.envArea[s * D + d];
  return sf.area[s] ? a / sf.area[s] : 0;
}
