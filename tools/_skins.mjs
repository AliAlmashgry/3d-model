import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
const r = doc.getRoot();
console.log("skins: " + r.listSkins().length + "  animations: " + r.listAnimations().length + "  nodes: " + r.listNodes().length);
let skinned = 0;
for (const n of r.listNodes()) if (n.getSkin()) skinned++;
console.log("nodes with skin: " + skinned);
for (const s of r.listSkins()) console.log("  skin joints=" + s.listJoints().length + " name=" + s.getName());
