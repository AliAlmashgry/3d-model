/* Bake away a skin that does nothing: this export has 136 joints and no
   animation, so every skinning matrix is the identity and three.js renders
   each vertex at its raw POSITION, ignoring the mesh node's transform. That
   hides the model from every position-based tool here (seat-split's boxes,
   the seam tools), so the skin is removed and the nodes reset to identity --
   which is exactly what the renderer was already doing.
   Checks first: |jointWorld * inverseBind - I| must be ~0 for every joint. */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [inPath, outPath] = process.argv.slice(2);
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
if (worst > 1e-4) { console.error("skinning is NOT the identity -- refusing to drop it"); process.exit(1); }
if (!outPath) process.exit(0);

let cleared = 0;
for (const node of root.listNodes()) {
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
for (const skin of root.listSkins()) skin.dispose();
console.log("cleared skin from " + cleared + " nodes");
await io.write(outPath, doc);
