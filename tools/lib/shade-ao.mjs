/* vertex-shading's ambient-occlusion pass, spread over worker threads.

   The kernel below is the single-threaded one the Maxima was baked with
   (2026-09-17, 2.5 min for 233k vertices x 128 rays against 1.18M triangles),
   moved here unchanged: per vertex, cosine-weighted spiral-stratified rays
   rotated by a spin that depends only on the vertex's index in its primitive,
   an any-hit BVH test, and the other side tried when the first is under half
   open. Every vertex is independent, so splitting the vertices across threads
   cannot change a result: the BVH, the triangles and the positions are shared
   read-only (SharedArrayBuffer), each worker writes only its own vertices'
   slots, and the output is bit-identical to the single-threaded pass for any
   thread count and any scheduling (checked with --threads 1 against 8).

   aoPass(opts) -> [{ ao: Float32Array, sign: Int8Array }] per target, where
   ao is the final shade (strength, floor and hidden-below applied, exactly as
   before) and sign is -1 where the more open side was the flipped normal --
   the seam pass needs it to know which way is "behind".

   opts.raw (vertex-shading --seed): ao is the OPENNESS instead -- the share
   of open rays on the more open side, before strength, floor and
   hidden-below -- so each variant can apply its own drawn values with
   aoShade() without tracing again (the trace is the whole cost: 54 s on the
   Maxima, the shade a few ms). The rays, the side picked and the sign do not
   depend on those three, only on the distance, which a seeded run draws once
   (lib/variation.mjs "sticky"). */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { buildBvh, occluded } from "./shade-geom.mjs";

export function makeDirs(rays) {
  const dirs = []; // cosine-weighted, spiral-stratified
  for (let k = 0; k < rays; k++) {
    const u1 = (k + 0.5) / rays, phi = k * 2.399963229728653;
    const r = Math.sqrt(u1);
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u1)]);
  }
  return dirs;
}

/* Shades vertices [i0, i1) of one target into ao/sign (offset `base`). */
export function aoKernel(bvh, P, N, base, i0, i1, ao, sign, o) {
  const { dirs, eps, ground, groundY, distance, strength, floor, hiddenBelow, hiddenShade } = o;
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
      if (ground && dy < 0 && (sy - groundY) / -dy < distance) continue;
      if (!occluded(bvh, sx, sy, sz, dx, dy, dz, distance)) open++;
    }
    return open / dirs.length;
  };
  for (let i = i0; i < i1; i++) {
    const o3 = (base + i) * 3;
    const nx = N[o3], ny = N[o3 + 1], nz = N[o3 + 2];
    sign[base + i] = 1;
    if (!nx && !ny && !nz) { ao[base + i] = 1; continue; }
    const spin = (((i * 2654435761) % 1000) / 1000) * 6.283185307179586;
    let a = openness(P[o3], P[o3 + 1], P[o3 + 2], nx, ny, nz, spin);
    if (a < 0.5) {
      const flipped = openness(P[o3], P[o3 + 1], P[o3 + 2], -nx, -ny, -nz, spin);
      if (flipped > a) { a = flipped; sign[base + i] = -1; }
    }
    // Enclosed on both sides: only ever seen through a crack between two
    // patches of a panel, where a baked black shows as a dotted line.
    ao[base + i] = o.raw ? a : a < hiddenBelow ? hiddenShade : Math.max(floor, 1 - strength * (1 - a));
  }
}

/* The kernel's shade of an openness a, for a raw pass (the same expression;
   the caller stores it in a Float32Array as the kernel does). */
export const aoShade = (a, { strength, floor, hiddenBelow, hiddenShade }) => (a < hiddenBelow ? hiddenShade : Math.max(floor, 1 - strength * (1 - a)));

const shared = (C, n) => new C(new SharedArrayBuffer(Math.max(1, n) * C.BYTES_PER_ELEMENT));

/* opts: { occTris: Float32Array, targets: [{count, pos, nrm}], rays, distance
   (model units), ground, groundY, size, strength, floor, hiddenBelow,
   hiddenShade, threads, onProgress(done, total), raw } */
export async function aoPass(opts) {
  const threads = Math.max(1, Math.min(opts.threads || availableParallelism(), 64));
  const total = opts.targets.reduce((s, t) => s + t.count, 0);
  const T = shared(Float32Array, opts.occTris.length); T.set(opts.occTris);
  const bvh = buildBvh(T, shared);
  const P = shared(Float64Array, total * 3), N = shared(Float64Array, total * 3);
  const bases = [];
  let base = 0;
  for (const tg of opts.targets) { bases.push(base); P.set(tg.pos.subarray(0, tg.count * 3), base * 3); N.set(tg.nrm.subarray(0, tg.count * 3), base * 3); base += tg.count; }
  const ao = shared(Float32Array, total), sign = shared(Int8Array, total);
  const kern = { dirs: makeDirs(opts.rays), eps: opts.size * 2e-4, ground: !!opts.ground, groundY: opts.groundY, distance: opts.distance,
    strength: opts.strength, floor: opts.floor, hiddenBelow: opts.hiddenBelow, hiddenShade: opts.hiddenShade, raw: !!opts.raw };
  const CHUNK = 1024;
  const chunks = [];
  opts.targets.forEach((tg, ti) => { for (let i = 0; i < tg.count; i += CHUNK) chunks.push([bases[ti], i, Math.min(tg.count, i + CHUNK)]); });
  const progress = shared(Int32Array, 2); // [next chunk, vertices done]
  if (threads === 1) {
    for (const [b, i0, i1] of chunks) { aoKernel(bvh, P, N, b, i0, i1, ao, sign, kern); progress[1] += i1 - i0; opts.onProgress && opts.onProgress(progress[1], total); }
  } else {
    const workers = [];
    for (let w = 0; w < threads; w++) {
      workers.push(new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./shade-ao-worker.mjs", import.meta.url), { workerData: { bvh, P, N, ao, sign, kern, chunks, progress } });
        worker.on("message", (m) => { if (m === "done") resolve(); });
        worker.on("error", reject);
        worker.on("exit", (code) => { if (code) reject(new Error("AO worker exited with " + code)); });
      }));
    }
    const tick = setInterval(() => opts.onProgress && opts.onProgress(Atomics.load(progress, 1), total), 1000);
    try { await Promise.all(workers); } finally { clearInterval(tick); }
    opts.onProgress && opts.onProgress(total, total);
  }
  return opts.targets.map((tg, ti) => ({ ao: ao.subarray(bases[ti], bases[ti] + tg.count), sign: sign.subarray(bases[ti], bases[ti] + tg.count) }));
}
