#!/usr/bin/env node
/* export-fix: make an export match what the rest of these tools assume before
   the recipe runs on it -- geometry where the node transforms say it is, and
   no vertex colours in the way of the shading bake. Run it on the ORIGINAL in
   repo-root assets/, first, before seat-split.

   Usage:
     node tools/export-fix.mjs <in.glb> <out.glb> [--unskin] [--drop-color0]
     node tools/export-fix.mjs <in.glb> --check

   --unskin  Drops a skin that does nothing. The 2021 Elantra exports 136
     joints and no animation: every skinning matrix is the identity, so
     three.js renders each vertex at its raw POSITION and ignores the mesh
     node's transform. Nothing looks wrong on screen -- but seat-split's boxes
     and vertex-shading's seam distances go through the node's world matrix,
     which on a Sketchfab export is the Z-up -> Y-up rotation, so they see the
     car lying on its side in a space that is never drawn. This removes the
     skin and gives each formerly-skinned node the world matrix the renderer
     was already using (the identity), which means local = inverse(parent
     world) -- clearing the node's own translation/rotation/scale is NOT
     enough, because the rotation sits on an ancestor and the car comes out on
     its side.
     It refuses unless jointWorld * inverseBind is the identity for every joint
     a vertex is actually weighted to. Check the USED joints only: this rig
     also carries a _rootJoint and "_end_" tip joints scaled by 100 that
     nothing is weighted to, and they are not identities.

   --drop-color0  Removes COLOR_0. tools/vertex-shading.mjs refuses a file that
     already has it, since that is how it stops shading a car twice. The
     Elantra ships a COLOR_0 that is a game shader's data channels, not a
     colour: R is ~1 everywhere while G, B and A carry masks. Rendered
     side by side, with and without, the two are identical -- but confirm that
     for a new car before dropping it. Run `prune` afterwards, or the orphaned
     accessors stay in the buffer (2.7MB, on the Elantra).

   --check reports both without writing. */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [inPath, outPath] = argv.filter((a) => !a.startsWith("--"));
const check = flags.has("--check");
const doUnskin = flags.has("--unskin");
const doDropColor = flags.has("--drop-color0");
if (!inPath || (!check && (!outPath || (!doUnskin && !doDropColor)))) {
  console.error("usage: export-fix <in.glb> <out.glb> [--unskin] [--drop-color0]");
  console.error("       export-fix <in.glb> --check");
  process.exit(2);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
const doc = await io.read(inPath);
const root = doc.getRoot();


const mul = (a, b) => { const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
/* 4x4 inverse, column-major (Gauss-Jordan; these are affine, so it is exact
   enough and the check below proves it). */
function invert(m) {
  const a = m.slice(), inv = I.slice();
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + piv])) piv = r;
    if (piv !== c) for (let k = 0; k < 4; k++) {
      [a[k * 4 + c], a[k * 4 + piv]] = [a[k * 4 + piv], a[k * 4 + c]];
      [inv[k * 4 + c], inv[k * 4 + piv]] = [inv[k * 4 + piv], inv[k * 4 + c]];
    }
    const d = a[c * 4 + c];
    if (Math.abs(d) < 1e-12) throw new Error("singular node matrix");
    for (let k = 0; k < 4; k++) { a[k * 4 + c] /= d; inv[k * 4 + c] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[c * 4 + r];
      if (!f) continue;
      for (let k = 0; k < 4; k++) { a[k * 4 + r] -= f * a[k * 4 + c]; inv[k * 4 + r] -= f * inv[k * 4 + c]; }
    }
  }
  return inv;
}

/* Only joints a vertex actually leans on: this rig also carries a _rootJoint
   and "_end_" tip joints scaled by 100 that nothing is weighted to. */
const used = new Set();
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  const j = prim.getAttribute("JOINTS_0"), w = prim.getAttribute("WEIGHTS_0");
  if (!j || !w) continue;
  const je = [0,0,0,0], we = [0,0,0,0];
  for (let i = 0; i < j.getCount(); i++) { j.getElement(i, je); w.getElement(i, we);
    for (let k = 0; k < 4; k++) if (we[k] > 1e-6) used.add(je[k]); }
}
let worst = 0;
for (const skin of root.listSkins()) {
  const ibm = skin.getInverseBindMatrices();
  const joints = skin.listJoints();
  for (let i = 0; i < joints.length; i++) {
    if (!used.has(i)) continue;
    const m = mul(joints[i].getWorldMatrix(), ibm.getElement(i, new Array(16)));
    for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(m[k] - I[k]));
  }
}
console.log("worst |jointWorld*inverseBind - I| = " + worst.toExponential(2));
if (root.listSkins().length && worst > 1e-4) {
  console.error("skinning is NOT the identity -- refusing to drop it");
  process.exit(1);
}


let cleared = 0;
for (const node of doUnskin ? root.listNodes() : []) {
  if (!node.getSkin()) continue;
  /* With the skin gone the node's own world transform starts applying again,
     and on a Sketchfab export that is the Z-up -> Y-up rotation carried by an
     ancestor, which lays the car on its side. The renderer was placing these
     vertices at their raw POSITION, so the node's world matrix has to become
     the identity: local = inverse(parent world) = inverse(this world) once the
     local matrix is cleared. */
  const world = node.getWorldMatrix();
  node.setSkin(null);
  node.setTranslation([0, 0, 0]); node.setRotation([0, 0, 0, 1]); node.setScale([1, 1, 1]);
  const parentWorld = node.getWorldMatrix();   // local is identity now
  node.setMatrix(invert(parentWorld));
  void world;
  const mesh = node.getMesh();
  if (mesh) for (const prim of mesh.listPrimitives())
    for (const sem of ["JOINTS_0", "WEIGHTS_0"]) if (prim.getAttribute(sem)) prim.setAttribute(sem, null);
  cleared++;
}
if (doUnskin) for (const skin of root.listSkins()) skin.dispose();
if (doUnskin) console.log("cleared skin from " + cleared + " nodes");
let dropped = 0;
if (doDropColor) {
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives())
    if (prim.getAttribute("COLOR_0")) { prim.setAttribute("COLOR_0", null); dropped++; }
  console.log("dropped COLOR_0 from " + dropped + " primitives (run `prune` next)");
}
if (check) {
  let withColor = 0;
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives())
    if (prim.getAttribute("COLOR_0")) withColor++;
  console.log("skins=" + root.listSkins().length + "  COLOR_0 primitives=" + withColor);
  process.exit(0);
}
await io.write(outPath, doc);
