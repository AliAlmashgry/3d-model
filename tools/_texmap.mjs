import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
const rows = [];
for (const t of doc.getRoot().listTextures()) {
  const users = [];
  for (const m of doc.getRoot().listMaterials()) {
    for (const [slot, tex] of [["base", m.getBaseColorTexture()], ["mr", m.getMetallicRoughnessTexture()],
      ["occl", m.getOcclusionTexture()], ["normal", m.getNormalTexture()], ["emis", m.getEmissiveTexture()]])
      if (tex === t) users.push(m.getName() + ":" + slot);
  }
  rows.push({ kb: t.getImage().byteLength / 1024, size: t.getSize().join("x"), mime: t.getMimeType(), users });
}
rows.sort((a, b) => b.kb - a.kb);
let total = 0;
for (const r of rows) { total += r.kb; console.log(r.kb.toFixed(0).padStart(6) + "KB  " + r.size.padEnd(10) + r.mime.replace("image/","").padEnd(5) + "  " + r.users.join(", ")); }
console.log("total textures: " + (total/1024).toFixed(2) + " MB");
