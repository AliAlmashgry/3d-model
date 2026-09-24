import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [path, boxStr] = process.argv.slice(2);
const bx = boxStr.split(",").map(Number);
const doc = await io.read(path);
const xform=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
const tally = new Map();
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION"); const idx = prim.getIndices();
    const name = prim.getMaterial()?.getName() ?? "(none)";
    const n = idx ? idx.getCount() : pos.getCount();
    const p = [0,0,0]; let inside = 0, total = 0;
    for (let i = 0; i < n; i += 3) {
      const c = [0,0,0];
      for (let k = 0; k < 3; k++) { pos.getElement(idx ? idx.getScalar(i+k) : i+k, p); const w = xform(m, p);
        c[0]+=w[0]/3; c[1]+=w[1]/3; c[2]+=w[2]/3; }
      total++;
      if (c[0]>=bx[0]&&c[1]>=bx[1]&&c[2]>=bx[2]&&c[0]<=bx[3]&&c[1]<=bx[4]&&c[2]<=bx[5]) inside++;
    }
    const t = tally.get(name) || { inside: 0, total: 0 };
    t.inside += inside; t.total += total; tally.set(name, t);
  }
}
for (const [n, t] of [...tally.entries()].sort((a,b)=>b[1].inside-a[1].inside))
  if (t.inside) console.log(String(t.inside).padStart(7) + " / " + String(t.total).padStart(7) + "  " + n);
