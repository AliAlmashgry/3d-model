import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { writeFileSync, mkdirSync } from "node:fs";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const [path, matName, outDir] = process.argv.slice(2);
const doc = await io.read(path);
const mat = doc.getRoot().listMaterials().find((m) => m.getName() === matName);
if (!mat) { console.error("no material " + matName); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const slots = { base: mat.getBaseColorTexture(), mr: mat.getMetallicRoughnessTexture(), occl: mat.getOcclusionTexture(), normal: mat.getNormalTexture() };
for (const [slot, tex] of Object.entries(slots)) {
  if (!tex) { console.log(slot + ": none"); continue; }
  const ext = tex.getMimeType() === "image/jpeg" ? "jpg" : "png";
  const f = outDir + "/" + slot + "." + ext;
  writeFileSync(f, Buffer.from(tex.getImage()));
  console.log(slot + ": " + tex.getSize().join("x") + " -> " + f);
}
console.log("occlusionStrength=" + mat.getOcclusionStrength() + " baseFactor=" + mat.getBaseColorFactor().map(v=>v.toFixed(2)).join(","));
