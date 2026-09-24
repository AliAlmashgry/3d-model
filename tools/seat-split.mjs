#!/usr/bin/env node
/* seat-split: give a car's driver's seat its own material, the way the Camry's
   Driver_Seat_Red was made, so the page's look profile can paint it red.

   Sketchfab exports keep the whole cabin in one material and usually one mesh,
   so the seat has to be carved out geometrically. The cabin primitive is
   still many disconnected SHELLS (seat, headrest, each pillar's trim, the
   headliner, door cards...), so the unit of selection is a shell: vertices
   are welded by world position, triangles sharing a vertex form a shell, and
   a whole shell is moved when more than --min-inside (default 0.5) of its
   triangles have their centroid inside the box you give (minus --exclude
   boxes). The selected triangles go to a new primitive on the same mesh with
   a new flat material named Driver_Seat (the profile's red, no textures --
   distinct values, so a later `dedup` cannot fold it back into the cabin
   material).

   Why shells and not loose triangles: the headrest tip sits at ~90% of the
   car's height and the B-pillar trim and headliner (same material) overlap
   it in height and in x, so any box tall enough for the headrest also
   catches strips of pillar and roof -- the Camry's first split painted "a
   red dot in the mid pillar" and both Nissans painted the B-pillar and a
   headliner strip. Those are separate shells, mostly outside the box, so
   the shell rule rejects them while the seat (99% inside) comes whole,
   base included. --mode tris restores the old centroid-per-triangle cut.

   Usage:
     node tools/seat-split.mjs <in.glb> --report [--box x0,y0,z0,x1,y1,z1] [--mesh <substr>] [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris]
     node tools/seat-split.mjs <in.glb> <out.glb> (--box x0,y0,z0,x1,y1,z1 | --mesh <substr>) [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris] [--name Driver_Seat]

   --report prints the model's world bounds and every material's world bounds,
   mesh names and triangle count; with --box or --mesh it also says how many
   triangles of each material would be selected, and (shell mode) lists every
   shell that touches the box with its inside fraction and whether it is
   selected, so box and threshold are tuned before anything is written.
   --source limits the split to primitives using those materials
   (recommended: the cabin material named in the car's look.interior).
   --mesh selects whole meshes/nodes whose name contains the text, for an
   export that already has a seat mesh (e.g. seats_FL); with it a box is
   optional. --exclude x0,y0,z0,x1,y1,z1 (repeatable) removes centroids from
   the "inside" count, now only needed for small hardware fully inside the
   box (a seat-belt guide on the pillar). Take the box top to about 94% of
   the car's height so the headrest shell counts as inside. Run it on the
   ORIGINAL export (root assets/), then compress the result into
   visual-search-standalone/assets/ as usual. */
import { NodeIO, Accessor, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "report") { flags.report = true; continue; }
    if (key === "exclude") { (flags.exclude = flags.exclude || []).push(argv[++i]); continue; }
    flags[key] = argv[++i];
  } else positional.push(a);
}
const [inPath, outPath] = positional;
if (!inPath || (!flags.report && !outPath)) {
  console.error("usage: seat-split <in.glb> --report [--box ...] [--mesh substr] [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris]\n       seat-split <in.glb> <out.glb> (--box x0,y0,z0,x1,y1,z1 | --mesh substr) [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris] [--name Driver_Seat]");
  process.exit(2);
}
const seatName = flags.name || "Driver_Seat";
const box = flags.box ? parseBox(flags.box) : null;
const mode = flags.mode || "shell";
if (mode !== "shell" && mode !== "tris") { console.error("--mode wants shell or tris"); process.exit(2); }
const minInside = flags["min-inside"] !== undefined ? Number(flags["min-inside"]) : 0.5;
if (Number.isNaN(minInside) || minInside <= 0 || minInside > 1) { console.error("--min-inside wants a fraction in (0, 1]"); process.exit(2); }
// --source a,b limits to primitives using those materials; --mesh substr limits
// to meshes/nodes whose name contains it (a named seat needs no box at all).
const sources = flags.source ? flags.source.split(",").map((s) => s.trim()) : null;
const meshFilter = flags.mesh || null;
const selectable = (node, mesh, prim) => {
  if (sources && (!prim.getMaterial() || !sources.includes(prim.getMaterial().getName()))) return false;
  if (meshFilter && !((mesh.getName() || "").includes(meshFilter) || (node.getName() || "").includes(meshFilter))) return false;
  return true;
};
if (!flags.report && !box && !meshFilter) { console.error("give --box, or --mesh for a seat that is its own mesh"); process.exit(2); }
const selecting = !!(box || meshFilter);

function parseBox(s) {
  const v = s.split(",").map(Number);
  if (v.length !== 6 || v.some((n) => Number.isNaN(n))) throw new Error("--box wants six numbers: x0,y0,z0,x1,y1,z1");
  return { min: [Math.min(v[0], v[3]), Math.min(v[1], v[4]), Math.min(v[2], v[5])], max: [Math.max(v[0], v[3]), Math.max(v[1], v[4]), Math.max(v[2], v[5])] };
}
// --exclude boxes (repeatable) take centroids out of the "inside" count, for
// small hardware that sits fully inside the box but is not the seat.
const excludes = (flags.exclude || []).map(parseBox);
const within = (b, p) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
const inBox = (p) => (!box || within(box, p)) && !excludes.some((b) => within(b, p));
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const pad = (n, w) => String(n).padStart(w);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
const doc = await io.read(inPath);
const root = doc.getRoot();

/* Every (node, primitive) pair with its world matrix. A mesh shared by several
   nodes is visited once per node; the split is applied on the first visit only
   and the others are reported, since one primitive cannot be split two ways. */
const visits = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) visits.push({ node, mesh, prim, m });
}

function triangles(prim) {
  const pos = prim.getAttribute("POSITION");
  const idx = prim.getIndices();
  const arr = idx ? idx.getArray() : null;
  const count = arr ? arr.length / 3 : pos.getCount() / 3;
  return { pos, idx, arr, count, index: (t, k) => (arr ? arr[t * 3 + k] : t * 3 + k) };
}

// ---- gather -----------------------------------------------------------------
/* One pass over every triangle: model and per-material world bounds for the
   report, and for the selectable primitives (first visit only) each
   triangle's world-space corners and whether its centroid is inside the box,
   kept for the shell pass and the split. */
const stats = new Map(); // material name -> { tris, selected, min, max, meshes:Set }
const modelMin = [Infinity, Infinity, Infinity], modelMax = [-Infinity, -Infinity, -Infinity];
const grow = (mn, mx, p) => { for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } };
const seen = new Set();
const cand = []; // { local, corners, inside, matName } per selectable triangle
const candPrims = new Map(); // prim -> { mesh, ids: indices into cand }
for (const { node, mesh, prim, m } of visits) {
  if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
  const matName = prim.getMaterial() ? prim.getMaterial().getName() : "(none)";
  if (!stats.has(matName)) stats.set(matName, { tris: 0, selected: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], meshes: new Set() });
  const s = stats.get(matName);
  s.meshes.add(mesh.getName() || node.getName() || "?");
  const first = !seen.has(prim);
  seen.add(prim);
  const sel = selectable(node, mesh, prim);
  if (sel && !first) console.warn("note: mesh " + mesh.getName() + " is instanced by more than one node; split once, under the first");
  const gather = first && sel;
  if (gather) candPrims.set(prim, { mesh, ids: [] });
  const t = triangles(prim);
  const v = [0, 0, 0];
  for (let i = 0; i < t.count; i++) {
    const c = [0, 0, 0];
    const corners = [];
    for (let k = 0; k < 3; k++) {
      const p = xform(m, t.pos.getElement(t.index(i, k), v));
      grow(s.min, s.max, p); grow(modelMin, modelMax, p);
      c[0] += p[0] / 3; c[1] += p[1] / 3; c[2] += p[2] / 3;
      if (gather) corners.push(p);
    }
    if (first) s.tris++;
    if (gather) {
      candPrims.get(prim).ids.push(cand.length);
      cand.push({ local: i, corners, inside: selecting && inBox(c), matName });
    }
  }
}

// ---- shells -----------------------------------------------------------------
/* Weld the selectable triangles' corners by quantized world position and join
   triangles that share a corner; each connected set is a shell. */
const shells = []; // { n, inside, min, max, selected }
const shellOf = new Int32Array(cand.length);
if (selecting && mode === "shell") {
  const size = Math.max(...modelMax.map((v, k) => v - modelMin[k]));
  const q = size / 20000;
  const key = (p) => Math.round(p[0] / q) + "," + Math.round(p[1] / q) + "," + Math.round(p[2] / q);
  const parent = new Int32Array(cand.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const byVertex = new Map();
  cand.forEach((t, i) => {
    for (const p of t.corners) {
      const k = key(p);
      const j = byVertex.get(k);
      if (j === undefined) byVertex.set(k, i); else union(i, j);
    }
  });
  const ids = new Map(); // union-find root -> shell index
  cand.forEach((t, i) => {
    const r = find(i);
    let id = ids.get(r);
    if (id === undefined) { id = shells.length; ids.set(r, id); shells.push({ n: 0, inside: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], selected: false }); }
    shellOf[i] = id;
    const sh = shells[id];
    sh.n++;
    if (t.inside) sh.inside++;
    for (const p of t.corners) grow(sh.min, sh.max, p);
  });
  // Strictly more than the threshold: a 2-triangle sliver with one centroid
  // inside is not "half a seat".
  for (const sh of shells) sh.selected = sh.inside / sh.n > minInside;
}
const chosen = (i) => (mode === "shell" && selecting ? shells[shellOf[i]].selected : cand[i].inside);
for (let i = 0; i < cand.length; i++) if (chosen(i)) stats.get(cand[i].matName).selected++;

// ---- report -----------------------------------------------------------------
console.log("model world bounds: " + f3(modelMin) + " -> " + f3(modelMax) + "  size " + f3(modelMax.map((v, k) => v - modelMin[k])));
if (box) console.log("box: " + f3(box.min) + " -> " + f3(box.max));
for (const b of excludes) console.log("exclude: " + f3(b.min) + " -> " + f3(b.max));
if (meshFilter) console.log("mesh filter: *" + meshFilter + "*");
if (selecting) console.log("mode: " + mode + (mode === "shell" ? " (a whole shell moves when more than " + Math.round(minInside * 100) + "% of its triangles are inside)" : " (each triangle on its own centroid)"));
for (const [name, s] of [...stats.entries()].sort((a, b) => b[1].tris - a[1].tris)) {
  console.log("  " + name.padEnd(22) + " tris=" + pad(s.tris, 7) + (selecting ? "  selected=" + pad(s.selected, 6) : "") + "  bounds " + f3(s.min) + " -> " + f3(s.max) + "  meshes: " + [...s.meshes].slice(0, 4).join(", ") + (s.meshes.size > 4 ? " +" + (s.meshes.size - 4) : ""));
}
if (selecting && mode === "shell") {
  const touching = shells.filter((sh) => sh.inside > 0).sort((a, b) => b.inside - a.inside);
  console.log("shells touching the box: " + touching.length + " of " + shells.length);
  for (const sh of touching.slice(0, 40)) {
    console.log("  " + (sh.selected ? "SELECTED" : "   -    ") + " tris=" + pad(sh.n, 6) + " inside=" + pad(sh.inside, 6) + " " + pad(Math.round(100 * sh.inside / sh.n), 3) + "%  bounds " + f3(sh.min) + " -> " + f3(sh.max));
  }
  if (touching.length > 40) console.log("  ... " + (touching.length - 40) + " more");
}
if (flags.report) process.exit(0);

// ---- split ------------------------------------------------------------------
let seatMat = root.listMaterials().find((mt) => mt.getName() === seatName);
if (!seatMat) {
  seatMat = doc.createMaterial(seatName)
    .setBaseColorFactor([0.863, 0.058, 0.058, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8)
    .setEmissiveFactor([0.025, 0.002, 0.002]);
}
const buffer = root.listBuffers()[0] || doc.createBuffer();
let moved = 0;
for (const [prim, { mesh, ids }] of candPrims) {
  const t = triangles(prim);
  const inside = [], outside = [];
  for (const ci of ids) {
    const i = cand[ci].local;
    (chosen(ci) ? inside : outside).push(t.index(i, 0), t.index(i, 1), t.index(i, 2));
  }
  if (!inside.length) continue;
  const Typed = t.pos.getCount() < 65536 ? Uint16Array : Uint32Array;
  const mk = (list) => doc.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer).setArray(new Typed(list));
  const oldIdx = prim.getIndices();
  prim.setIndices(mk(outside));
  if (oldIdx && oldIdx.listParents().every((p) => p.propertyType === "Root")) oldIdx.dispose();
  const seatPrim = doc.createPrimitive().setMode(prim.getMode()).setMaterial(seatMat).setIndices(mk(inside));
  for (const sem of prim.listSemantics()) seatPrim.setAttribute(sem, prim.getAttribute(sem));
  mesh.addPrimitive(seatPrim);
  moved += inside.length / 3;
  console.log("moved " + inside.length / 3 + " triangles from " + mesh.getName() + " (" + (prim.getMaterial() ? prim.getMaterial().getName() : "none") + ") to " + seatName);
}
if (!moved) { console.error("nothing selected: not writing " + outPath); process.exit(1); }
await io.write(outPath, doc);
console.log("wrote " + outPath + " with " + moved + " seat triangles under material " + seatName);
