/* seat-box: the original selection modes of seat-split -- a box (with
   --exclude boxes and the shell rule) or a mesh-name filter -- on the shared
   seat-scene arrays, so they are judged by the same checks as --pick/--auto.

   One deliberate change from the pre-2026-09-30 tool: shells are welded per
   primitive by exact position (seat-scene), not across primitives on a
   size/20000 grid. That grid was finer than the original exports' spacing
   but COARSER than one Draco step on a shipped file -- on the Altima (0.18
   units long, 14-bit positions) vertices one quantum apart fell in one cell,
   so the seat was welded into the cabin-wide 1548-triangle shell and the
   known-good box selected nothing.

   seat-split --seed varies a box cut (lib/seat-vary.mjs): the box's faces
   move in or out (padBox, before this is called), --min-inside is drawn
   unless given, and -- unless --mode is given -- borderTris may cut the
   borderline shells by triangle (below). */

/* Selection by --box (+ --exclude, --min-inside, --mode) and/or --mesh.
   `sources`: Set of material names or null. Only a mesh's first instance is
   selectable, as before. Returns { tris, touching } where touching lists
   every shell with a centroid in the box. borderTris (--seed variants only):
   a shell with more than 20% but not more than minInside of its centroids
   inside is not left out but cut by triangle -- its inside part moves
   (touching[].part). */
export function boxSelect(scene, { box = null, excludes = [], minInside = 0.5, mode = "shell", sources = null, meshFilter = null, borderTris = false }) {
  const S = scene.shells;
  const within = (b, x, y, z) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];
  const selectable = scene.visits.map((v) => v.first
    && (!sources || sources.has(v.matName))
    && (!meshFilter || v.meshName.includes(meshFilter) || v.nodeName.includes(meshFilter)));
  const inside = new Uint8Array(scene.T);
  const insideCount = new Int32Array(S.n);
  for (let t = 0; t < scene.T; t++) {
    if (!selectable[scene.triVisit[t]]) continue;
    const x = scene.cen[t * 3], y = scene.cen[t * 3 + 1], z = scene.cen[t * 3 + 2];
    const ok = (!box || within(box, x, y, z)) && !excludes.some((b) => within(b, x, y, z));
    if (ok) { inside[t] = 1; insideCount[scene.shellOf[t]]++; }
  }
  const tris = [];
  const touching = [];
  if (mode === "tris") {
    for (let t = 0; t < scene.T; t++) if (inside[t]) tris.push(t);
  } else {
    for (let s = 0; s < S.n; s++) {
      if (!insideCount[s]) continue;
      // Strictly more than the threshold: a 2-triangle sliver with one
      // centroid inside is not "half a seat".
      const sel = insideCount[s] / S.count[s] > minInside;
      const part = !sel && borderTris && insideCount[s] / S.count[s] > 0.2;
      touching.push({ shell: s, n: S.count[s], inside: insideCount[s], selected: sel, ...(part ? { part } : {}) });
      if (sel) for (let j = S.start[s]; j < S.start[s + 1]; j++) tris.push(S.tris[j]);
      else if (part) for (let j = S.start[s]; j < S.start[s + 1]; j++) if (inside[S.tris[j]]) tris.push(S.tris[j]);
    }
    touching.sort((a, b) => b.inside - a.inside);
  }
  return { tris, touching };
}
