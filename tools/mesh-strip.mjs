#!/usr/bin/env node
/* mesh-strip: delete whole meshes from a GLB by name.

   Sketchfab exports keep small add-on parts as their own meshes, so anything
   the demo should not show -- the licence plates and the black backing panel
   behind a front plate -- can be dropped outright instead of carved out of a
   shared surface. Run --report first to read the names, triangle counts and
   world bounds, then pass the ones to delete.

   Usage:
     node tools/mesh-strip.mjs <in.glb> --report [--match <substr>]
     node tools/mesh-strip.mjs <in.glb> <out.glb> --remove <substr>[,<substr>...]

   A plate that sat in a pocket pressed into the boot lid (both Nissans, rear)
   leaves the pocket's baked shadow behind as a black rectangle. The old
   --drop-occlusion cleared the whole occlusion map for that, and it is gone:
   that map is what greys the body and draws its seam lines, the Camry's look
   (see tools/occlusion-patch.mjs, which lifts only the pocket).

   A substring matches against both the mesh name and its node's name. Every
   matching primitive is removed, a node whose mesh ends up empty is detached,
   and orphaned accessors and materials are pruned. If any --remove term
   matches nothing the tool writes nothing and exits non-zero, so a typo in a
   long Sketchfab name cannot silently ship an unchanged file. Run it on the
   ORIGINAL export (root assets/) after the seat split, then compress into
   visual-search-standalone/assets/ as usual; the Camry has no original, so it
   is stripped in place and re-encoded. */
import { NodeIO, Primitive } from "@gltf-transform/core";
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
    flags[key] = argv[++i];
  } else positional.push(a);
}
const [inPath, outPath] = positional;
if (!inPath || (!flags.report && !outPath)) {
  console.error("usage: mesh-strip <in.glb> --report [--match substr]\n       mesh-strip <in.glb> <out.glb> --remove substr[,substr...]");
  process.exit(2);
}
if (flags["drop-occlusion"]) {
  console.error("--drop-occlusion is gone: the occlusion map carries the body's shading and seam lines. Lift only the plate pocket with tools/occlusion-patch.mjs --pocket.");
  process.exit(2);
}
const removes = flags.remove ? flags.remove.split(",").map((s) => s.trim()).filter(Boolean) : [];
if (!flags.report && !removes.length) { console.error("give --remove <substr>[,<substr>...]"); process.exit(2); }
const matchFilter = flags.match || null;

const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const nameOf = (node, mesh) => (mesh && mesh.getName()) || node.getName() || "?";
const hits = (node, mesh, term) => (mesh.getName() || "").includes(term) || (node.getName() || "").includes(term);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
const doc = await io.read(inPath);
const root = doc.getRoot();

const visits = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) visits.push({ node, mesh, prim });
}

// ---- report -----------------------------------------------------------------
const rows = [];
for (const { node, mesh, prim } of visits) {
  if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
  const label = nameOf(node, mesh);
  const matched = removes.filter((t) => hits(node, mesh, t));
  if (matchFilter && !label.includes(matchFilter) && !matched.length) continue;
  const pos = prim.getAttribute("POSITION");
  if (!pos) continue;
  const m = node.getWorldMatrix();
  const idx = prim.getIndices();
  const arr = idx ? idx.getArray() : null;
  const n = arr ? arr.length : pos.getCount();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p = xform(m, pos.getElement(arr ? arr[i] : i, v));
    for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  }
  rows.push({ label, mat: prim.getMaterial() ? prim.getMaterial().getName() : "(none)", tris: n / 3, lo, hi, matched });
}
rows.sort((a, b) => (b.matched.length - a.matched.length) || (b.tris - a.tris));
const shown = flags.report ? rows.slice(0, matchFilter || removes.length ? rows.length : 60) : rows.filter((r) => r.matched.length);
console.log(inPath + ": " + visits.length + " primitives, " + root.listMeshes().length + " meshes, " + root.listMaterials().length + " materials");
if (removes.length) console.log("remove terms: " + removes.join(", "));
for (const r of shown) {
  console.log("  " + (r.matched.length ? "REMOVE  " : "        ") + "tris=" + String(r.tris).padStart(6) + "  " + f3(r.lo) + " -> " + f3(r.hi) + "  mat=" + r.mat.padEnd(14) + "  " + r.label);
}
if (flags.report && !matchFilter && !removes.length && rows.length > 60) console.log("  ... " + (rows.length - 60) + " more (use --match to filter)");

// Every term must match something, or a typo would ship an unchanged file.
const unmatched = removes.filter((t) => !visits.some(({ node, mesh }) => hits(node, mesh, t)));
if (unmatched.length) {
  console.error("no mesh matches: " + unmatched.join(", ") + (flags.report ? "" : " -- writing nothing"));
  if (!flags.report) process.exit(1);
}
if (flags.report) process.exit(0);

// ---- strip ------------------------------------------------------------------
let removedPrims = 0, removedTris = 0;
const touched = new Set();
for (const { node, mesh, prim } of visits) {
  if (!removes.some((t) => hits(node, mesh, t))) continue;
  const idx = prim.getIndices();
  const pos = prim.getAttribute("POSITION");
  removedTris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
  mesh.removePrimitive(prim);
  prim.dispose();
  removedPrims++;
  touched.add(mesh);
  console.log("removed primitive from " + nameOf(node, mesh));
}
let detached = 0;
for (const mesh of touched) {
  if (mesh.listPrimitives().length) continue;
  for (const node of root.listNodes()) if (node.getMesh() === mesh) { node.setMesh(null); detached++; }
  mesh.dispose();
}
/* Drop accessors and textures the removed primitives were the only users of,
   so the plate's own image does not ride along as dead weight. Anything still
   referenced by another primitive or material keeps its parent and stays. */
const orphaned = (prop) => prop.listParents().every((p) => p.propertyType === "Root");
let freedAccessors = 0, freedTextures = 0, freedMaterials = 0;
for (const acc of root.listAccessors()) if (orphaned(acc)) { acc.dispose(); freedAccessors++; }
for (const mat of root.listMaterials()) if (orphaned(mat)) { mat.dispose(); freedMaterials++; }
for (const tex of root.listTextures()) if (orphaned(tex)) { tex.dispose(); freedTextures++; }
await io.write(outPath, doc);
console.log("wrote " + outPath + ": removed " + removedPrims + " primitives (" + removedTris + " triangles), emptied " + detached + " nodes, freed " + freedAccessors + " accessors / " + freedMaterials + " materials / " + freedTextures + " textures");
