import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
let min = [9,9,9,9], max = [-9,-9,-9,-9], n = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const c = prim.getAttribute("COLOR_0"); if (!c) continue;
  const e = new Array(c.getType() === "VEC4" ? 4 : 3).fill(0);
  for (let i = 0; i < c.getCount(); i++) { c.getElement(i, e); n++;
    for (let k = 0; k < e.length; k++) { if (e[k] < min[k]) min[k] = e[k]; if (e[k] > max[k]) max[k] = e[k]; } }
}
console.log("COLOR_0 verts=" + n + " min=" + min.map((v)=>v===9?"-":v.toFixed(3)).join(",") + " max=" + max.map((v)=>v===-9?"-":v.toFixed(3)).join(","));
