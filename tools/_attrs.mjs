import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
const seen = new Map();
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const key = (prim.getMaterial()?.getName() ?? "(none)") + " :: " + prim.listSemantics().sort().join(",");
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [k, v] of [...seen.entries()].sort()) console.log(String(v).padStart(4) + "x  " + k);
