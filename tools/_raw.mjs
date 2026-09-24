import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
const b = [1e9,1e9,1e9,-1e9,-1e9,-1e9]; const p = [0,0,0];
const per = new Map();
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute("POSITION");
  const name = prim.getMaterial()?.getName() ?? "(none)";
  const s = per.get(name) || [1e9,1e9,1e9,-1e9,-1e9,-1e9];
  for (let i=0;i<pos.getCount();i++){ pos.getElement(i,p);
    for(let k=0;k<3;k++){ if(p[k]<b[k])b[k]=p[k]; if(p[k]>b[k+3])b[k+3]=p[k];
      if(p[k]<s[k])s[k]=p[k]; if(p[k]>s[k+3])s[k+3]=p[k]; } }
  per.set(name, s);
}
const f=(v)=>v.toFixed(3);
console.log("RAW bounds: " + b.map(f).join(", ") + "   size " + [b[3]-b[0],b[4]-b[1],b[5]-b[2]].map(f).join(" x "));
for (const [n, s] of per) console.log("  " + n.padEnd(34) + s.map(f).join(","));
