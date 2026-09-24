import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [inP, outP] = process.argv.slice(2);
const doc = await io.read(inP);
let n = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives())
  if (prim.getAttribute("COLOR_0")) { prim.setAttribute("COLOR_0", null); n++; }
console.log("dropped COLOR_0 from " + n + " primitives");
await io.write(outP, doc);
