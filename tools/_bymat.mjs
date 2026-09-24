import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [path, ...mats] = process.argv.slice(2);
const doc = await io.read(path);
const xform=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial(); if (!mat || !mats.includes(mat.getName())) continue;
    const pos = prim.getAttribute("POSITION"); const m = node.getWorldMatrix();
    const b=[1e9,1e9,1e9,-1e9,-1e9,-1e9]; const p=[0,0,0];
    for (let i=0;i<pos.getCount();i++){pos.getElement(i,p);const w=xform(m,p);for(let k=0;k<3;k++){if(w[k]<b[k])b[k]=w[k];if(w[k]>b[k+3])b[k+3]=w[k];}}
    const idx = prim.getIndices();
    console.log("node=" + node.getName() + "  mesh=" + mesh.getName() + "  mat=" + mat.getName() +
      "  tris=" + ((idx?idx.getCount():pos.getCount())/3) + "  box " + b.map((v)=>v.toFixed(3)).join(","));
  }
}
