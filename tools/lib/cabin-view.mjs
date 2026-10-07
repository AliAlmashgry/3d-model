/* cabin-view: what of a car can be SEEN from around it, and how -- straight
   on, or through a window. cabin-black.mjs's two outward checks stand on
   this, and deliberately not on the voxel air of lib/cabin-find.mjs that
   chose the triangles: a check that reused the classifier's own picture of
   the car would only repeat its answer.

   The car is drawn from VIEWS around it -- 8 azimuths at 8, 30 and 55
   degrees of elevation, and 4 steep ones at 75 (the page's camera orbits
   above the ground, so nothing from below) -- with an orthographic
   z-buffer of triangle ids, one pixel ~ L/360 (1.3 cm on a 4.8 m car).
   Every view keeps two depths per pixel: the nearest OPAQUE surface and the
   nearest WINDOW glass (cabin-black decides which shells are windows: the
   see-through glass that reaches the roof line). A surface whose pixel has
   window glass in front of it is seen THROUGH a window: the cabin as a
   passer-by sees it. One with no window in front is seen straight on: the
   outside of the car -- and that includes what sits behind a lamp's lens,
   which is not drawn at all (transparent, but not a window: a headlamp's
   chrome reflector seen through its lens is outside, not cabin). Invisible
   materials (alpha 0: the Camry's Outline_* highlight shells, the
   Corolla's e180_glass) are not drawn either.

   Per triangle, summed over the views: direct[t] and viaGlass[t], pixels.
   Plain JS on typed arrays: a few seconds for the Camry (246k triangles),
   longer for the Maxima (1.33M). */
import { triCorners } from "./seat-scene.mjs";

export const VIEW_SET = (() => {
  const v = [];
  for (const el of [8, 30, 55]) for (let az = 0; az < 360; az += 45) v.push([az, el]);
  for (let az = 0; az < 360; az += 90) v.push([az + 45, 75]);
  return v;
})();

/* visibility(scene, { shellKind }) -- shellKind: Uint8Array over
   scene.shells, 0 opaque, 1 window glass, 2 not drawn. Returns { direct: Uint32Array(T), viaGlass: Uint32Array(T),
   views, px (pixel size, model units), throughGlass (total pixels) }. */
export function visibility(scene, { shellKind, res = 360, views = VIEW_SET }) {
  const F = scene.frame, T = scene.T;
  const direct = new Uint32Array(T), viaGlass = new Uint32Array(T);
  const px = F.L / res;
  const centre = [0, 0, 0];
  for (let a = 0; a < 3; a++) centre[a] = (F.lo[a] + F.hi[a]) / 2;
  const R = 0.5 * Math.hypot(F.hi[0] - F.lo[0], F.hi[1] - F.lo[1], F.hi[2] - F.lo[2]) * 1.06;
  const size = Math.ceil((2 * R) / px);
  const depth = new Float32Array(size * size), glass = new Float32Array(size * size), id = new Int32Array(size * size);
  // Axis unit vectors of the car frame.
  const e = (a) => { const x = [0, 0, 0]; x[a] = 1; return x; };
  const U = e(F.up), Lx = e(F.len), Wx = e(F.wid);
  // Every drawn triangle's corners, relative to the centre, once for all views.
  const draw = [];
  for (let t = 0; t < T; t++) if (shellKind[scene.shellOf[t]] !== 2) draw.push(t);
  const ids = Int32Array.from(draw), K = ids.length;
  const P9 = new Float32Array(K * 9), kindOf = new Uint8Array(K);
  {
    const c = new Float32Array(9);
    for (let q = 0; q < K; q++) {
      triCorners(scene, ids[q], c);
      for (let k = 0; k < 9; k++) P9[q * 9 + k] = c[k] - centre[k % 3];
      kindOf[q] = shellKind[scene.shellOf[ids[q]]];
    }
  }
  let throughGlass = 0;
  for (const [az, el] of views) {
    const ra = (az * Math.PI) / 180, re = (el * Math.PI) / 180;
    // Direction from the car toward the camera.
    const toCam = [0, 1, 2].map((k) => Math.cos(re) * (Math.cos(ra) * Lx[k] + Math.sin(ra) * Wx[k]) + Math.sin(re) * U[k]);
    const fwd = toCam.map((x) => -x); // camera looks along fwd
    // right = fwd x up (up = car up, unless looking straight down)
    let right = [fwd[1] * U[2] - fwd[2] * U[1], fwd[2] * U[0] - fwd[0] * U[2], fwd[0] * U[1] - fwd[1] * U[0]];
    let rl = Math.hypot(...right);
    if (rl < 1e-6) { right = Lx.slice(); rl = 1; }
    right = right.map((x) => x / rl);
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    depth.fill(Infinity); glass.fill(Infinity); id.fill(-1);
    const half = size / 2;
    const P = new Float64Array(9);
    const r0 = right[0] / px, r1 = right[1] / px, r2 = right[2] / px, u0 = up[0] / px, u1 = up[1] / px, u2 = up[2] / px;
    for (let q9 = 0; q9 < K; q9++) {
      const k = kindOf[q9], t = ids[q9], o9 = q9 * 9;
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let q = 0; q < 3; q++) {
        const x = P9[o9 + q * 3], y = P9[o9 + q * 3 + 1], z = P9[o9 + q * 3 + 2];
        const sx = x * r0 + y * r1 + z * r2 + half;
        const sy = half - (x * u0 + y * u1 + z * u2);
        const d = x * fwd[0] + y * fwd[1] + z * fwd[2];
        P[q * 3] = sx; P[q * 3 + 1] = sy; P[q * 3 + 2] = d;
        if (sx < minx) minx = sx; if (sx > maxx) maxx = sx;
        if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
      }
      const x0 = Math.max(0, Math.ceil(minx - 0.5)), x1 = Math.min(size - 1, Math.floor(maxx - 0.5));
      const y0 = Math.max(0, Math.ceil(miny - 0.5)), y1 = Math.min(size - 1, Math.floor(maxy - 0.5));
      if (x0 > x1 || y0 > y1) continue;
      const ax = P[0], ay = P[1], bx = P[3], by = P[4], cx = P[6], cy = P[7];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const inv = 1 / area;
      for (let yy = y0; yy <= y1; yy++) {
        const py = yy + 0.5;
        for (let xx = x0; xx <= x1; xx++) {
          const pxx = xx + 0.5;
          const w0 = ((bx - pxx) * (cy - py) - (by - py) * (cx - pxx)) * inv;
          const w1 = ((cx - pxx) * (ay - py) - (cy - py) * (ax - pxx)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * P[2] + w1 * P[5] + w2 * P[8];
          const o = yy * size + xx;
          if (k === 1) { if (d < glass[o]) glass[o] = d; }
          else if (d < depth[o]) { depth[o] = d; id[o] = t; }
        }
      }
    }
    for (let o = 0; o < size * size; o++) {
      const t = id[o];
      if (t < 0) continue;
      if (glass[o] < depth[o]) { viaGlass[t]++; throughGlass++; } else direct[t]++;
    }
  }
  return { direct, viaGlass, views: views.length, px, size, throughGlass };
}
