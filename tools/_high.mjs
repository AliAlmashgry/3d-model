import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [path, axis, thr] = process.argv.slice(2);
const A = { x: 0, y: 1, z: 2 }[axis];
const doc = await io.read(path);
const xf=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION"); const p=[0,0,0]; let mn=1e9,mx=-1e9;
    for (let i=0;i<pos.getCount();i++){pos.getElement(i,p);const w=xf(m,p)[A];if(w<mn)mn=w;if(w>mx)mx=w;}
    if (mx > Number(thr)) console.log("node=" + node.getName() + " mesh=" + mesh.getName() + " mat=" + (prim.getMaterial()?.getName()) + " range=" + mn.toFixed(3) + ".." + mx.toFixed(3));
  }
}
