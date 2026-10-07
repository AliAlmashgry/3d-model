/* seat-scene: the geometry seat-split works on, flattened into typed arrays so
   a 3.3M-triangle export (the Sportage 2017) is read, welded and searched in
   seconds instead of minutes of per-triangle JS objects.

   What it builds from a gltf-transform Document:
     visits   every (node, primitive) pair with its WORLD-space positions, so a
              mesh instanced twice (a mirrored passenger seat, say) is seen
              twice; `first` marks the visit a split may edit.
     triangles  centroid (cen), area, owning visit (triVisit), local index,
              shell id (shellOf) -- all Float32Array / Int32Array of length T.
     shells   connected pieces WITHIN one visit: triangles sharing an index
              or an identical position. Per shell: triangle count, area, AABB,
              visit, material group, and a CSR list of its triangles.
     frame    the car's axes and robust extents (see carFrame).

   Why shells stop at a primitive's edge: a Draco file quantises each
   primitive on its own grid, so two primitives' copies of one seam vertex
   come back a fraction of a millimetre apart and a position weld across
   primitives splits or joins them by luck. Inside one primitive equal source
   positions decode to equal floats, so the weld is exact. Pieces that belong
   together across primitives (a seat whose back shell is another material)
   are joined later by proximity, which is what seat-find does anyway. */
import { Primitive } from "@gltf-transform/core";

export function buildScene(doc, { alias = null } = {}) {
  const root = doc.getRoot();
  const groupNames = [];
  const groupIds = new Map();
  const groupOf = (name) => {
    const g = alias && alias.has(name) ? alias.get(name) : name;
    let id = groupIds.get(g);
    if (id === undefined) { id = groupNames.length; groupIds.set(g, id); groupNames.push(g); }
    return id;
  };
  const visits = [];
  const seenPrim = new Set();
  const nodesOfMesh = new Map();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    nodesOfMesh.set(mesh, (nodesOfMesh.get(mesh) || 0) + 1);
  }
  let T = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    mesh.listPrimitives().forEach((prim, primIndex) => {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) return;
      const posAcc = prim.getAttribute("POSITION");
      if (!posAcc) return;
      const local = posAcc.getArray();
      const vc = posAcc.getCount();
      const pos = new Float32Array(vc * 3);
      for (let i = 0, j = 0; i < vc; i++, j += 3) {
        const x = local[j], y = local[j + 1], z = local[j + 2];
        pos[j] = m[0] * x + m[4] * y + m[8] * z + m[12];
        pos[j + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        pos[j + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      const idxAcc = prim.getIndices();
      const idx = idxAcc ? idxAcc.getArray() : null;
      const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(vc / 3);
      const matName = prim.getMaterial() ? prim.getMaterial().getName() : "(none)";
      visits.push({
        node, mesh, prim, primIndex, matName, group: groupOf(matName),
        first: !seenPrim.has(prim), instanced: nodesOfMesh.get(mesh) > 1,
        meshName: mesh.getName() || "", nodeName: node.getName() || "",
        pos, idx, vc, triStart: T, triCount,
      });
      seenPrim.add(prim);
      T += triCount;
    });
  }

  const cen = new Float32Array(T * 3);
  const area = new Float32Array(T);
  const triVisit = new Int32Array(T);
  const shellOf = new Int32Array(T);
  // Per-shell accumulators, grown as shells are found.
  let cap = 1024, S = 0;
  let sCount = new Int32Array(cap), sVisit = new Int32Array(cap), sGroup = new Int32Array(cap);
  let sMin = new Float32Array(cap * 3), sMax = new Float32Array(cap * 3), sArea = new Float64Array(cap);
  const growShells = () => {
    cap *= 2;
    const g = (a, n) => { const b = new a.constructor(cap * n); b.set(a); return b; };
    sCount = g(sCount, 1); sVisit = g(sVisit, 1); sGroup = g(sGroup, 1);
    sMin = g(sMin, 3); sMax = g(sMax, 3); sArea = g(sArea, 1);
  };

  for (let vi = 0; vi < visits.length; vi++) {
    const v = visits[vi];
    const { pos, idx, vc, triStart, triCount } = v;
    // Weld identical positions: open-addressing hash over the float bits.
    const bits = new Uint32Array(pos.buffer, pos.byteOffset, vc * 3);
    let size = 1; while (size < vc * 2) size <<= 1;
    const table = new Int32Array(size).fill(-1);
    const parent = new Int32Array(vc);
    for (let i = 0; i < vc; i++) {
      const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
      let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (size - 1);
      for (;;) {
        const j = table[h];
        if (j < 0) { table[h] = i; parent[i] = i; break; }
        if (bits[j * 3] === a && bits[j * 3 + 1] === b && bits[j * 3 + 2] === c) { parent[i] = j; break; }
        h = (h + 1) & (size - 1);
      }
    }
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      let a = find(i0), b = find(i1);
      if (a !== b) parent[a] = b;
      a = find(i1); b = find(i2);
      if (a !== b) parent[a] = b;
    }
    const rootShell = new Int32Array(vc).fill(-1);
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const r = find(i0);
      let s = rootShell[r];
      if (s < 0) {
        if (S === cap) growShells();
        s = S++;
        rootShell[r] = s;
        sVisit[s] = vi; sGroup[s] = v.group;
        sMin[s * 3] = sMin[s * 3 + 1] = sMin[s * 3 + 2] = Infinity;
        sMax[s * 3] = sMax[s * 3 + 1] = sMax[s * 3 + 2] = -Infinity;
      }
      const g = triStart + t;
      shellOf[g] = s;
      triVisit[g] = vi;
      const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
      const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
      cen[g * 3] = (ax + bx + cx) / 3; cen[g * 3 + 1] = (ay + by + cy) / 3; cen[g * 3 + 2] = (az + bz + cz) / 3;
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      area[g] = ar;
      sCount[s]++; sArea[s] += ar;
      const o = s * 3;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
        if (x < sMin[o]) sMin[o] = x; if (x > sMax[o]) sMax[o] = x;
        if (y < sMin[o + 1]) sMin[o + 1] = y; if (y > sMax[o + 1]) sMax[o + 1] = y;
        if (z < sMin[o + 2]) sMin[o + 2] = z; if (z > sMax[o + 2]) sMax[o + 2] = z;
      }
    }
  }
  // CSR: the triangles of each shell, in order.
  const shellStart = new Int32Array(S + 1);
  for (let t = 0; t < T; t++) shellStart[shellOf[t] + 1]++;
  for (let s = 0; s < S; s++) shellStart[s + 1] += shellStart[s];
  const fill = shellStart.slice(0, S);
  const shellTris = new Int32Array(T);
  for (let t = 0; t < T; t++) shellTris[fill[shellOf[t]]++] = t;

  const scene = {
    doc, visits, T, cen, area, triVisit, shellOf, groupNames, groupOf: (n) => groupIds.get(alias && alias.has(n) ? alias.get(n) : n),
    shells: { n: S, count: sCount.subarray(0, S), visit: sVisit.subarray(0, S), group: sGroup.subarray(0, S), min: sMin.subarray(0, S * 3), max: sMax.subarray(0, S * 3), area: sArea.subarray(0, S), start: shellStart, tris: shellTris },
  };
  scene.frame = carFrame(scene);
  return scene;
}

/* The three corners of global triangle t, written into out[0..8]. */
export function triCorners(scene, t, out) {
  const v = scene.visits[scene.triVisit[t]];
  const l = t - v.triStart;
  const i0 = v.idx ? v.idx[l * 3] : l * 3, i1 = v.idx ? v.idx[l * 3 + 1] : l * 3 + 1, i2 = v.idx ? v.idx[l * 3 + 2] : l * 3 + 2;
  const p = v.pos;
  out[0] = p[i0 * 3]; out[1] = p[i0 * 3 + 1]; out[2] = p[i0 * 3 + 2];
  out[3] = p[i1 * 3]; out[4] = p[i1 * 3 + 1]; out[5] = p[i1 * 3 + 2];
  out[6] = p[i2 * 3]; out[7] = p[i2 * 3 + 1]; out[8] = p[i2 * 3 + 2];
  return out;
}

/* The car's frame, from where its surface area lies rather than its raw
   bounds, so a stray part cannot stretch it (four 60-triangle gauge meshes a
   metre above the Corolla 2017's roof moved its raw top by 0.1 m).
     up    glTF's +Y, unless Y is plainly not the smallest extent.
     len   the longer horizontal axis; wid the other.
     lo/hi per axis, the 0.1% / 99.9% area quantiles of triangle centroids.
     L W H the robust extents; mid the centre plane on the width axis. */
export function carFrame(scene) {
  const { T, cen, area } = scene;
  const q = (axis, fracs) => {
    // Area-weighted quantiles on a stride sample, sorted in a typed array.
    const stride = Math.max(1, Math.floor(T / 400000));
    const n = Math.ceil(T / stride);
    const keys = new Float64Array(n);
    let tot = 0, k = 0;
    for (let t = 0; t < T; t += stride) { keys[k++] = cen[t * 3 + axis]; }
    const order = new Uint32Array(k); for (let i = 0; i < k; i++) order[i] = i;
    order.sort((a, b) => keys[a] - keys[b]);
    const w = new Float64Array(k);
    for (let i = 0, t = 0; i < k; i++, t += stride) { w[i] = area[t] + 1e-12; tot += w[i]; }
    return fracs.map((f) => {
      let acc = 0;
      for (const i of order) { acc += w[i]; if (acc >= f * tot) return keys[i]; }
      return keys[order[k - 1]];
    });
  };
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) { const [l, h] = q(a, [0.001, 0.999]); lo[a] = l; hi[a] = h; }
  const ext = hi.map((h, a) => h - lo[a]);
  let up = 1;
  if (!(ext[1] <= ext[0] && ext[1] <= ext[2])) up = ext.indexOf(Math.min(...ext));
  const horiz = [0, 1, 2].filter((a) => a !== up);
  const len = ext[horiz[0]] >= ext[horiz[1]] ? horiz[0] : horiz[1];
  const wid = horiz[0] === len ? horiz[1] : horiz[0];
  return { up, len, wid, lo, hi, L: ext[len], W: ext[wid], H: ext[up], mid: (lo[wid] + hi[wid]) / 2, ground: lo[up], top: hi[up], upFallback: up !== 1 };
}
