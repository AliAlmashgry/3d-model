import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const mul=(a,b)=>{const o=new Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;};
const f=(m)=>m.map((v)=>v.toFixed(2)).join(",");
for (const skin of root.listSkins()) {
  const ibm = skin.getInverseBindMatrices(); const joints = skin.listJoints();
  console.log("joints " + joints.length);
  for (let i = 0; i < 4; i++) {
    console.log(" joint " + i + " name=" + joints[i].getName());
    console.log("   world  " + f(joints[i].getWorldMatrix()));
    console.log("   ibm    " + f(ibm.getElement(i, new Array(16))));
    console.log("   skin   " + f(mul(joints[i].getWorldMatrix(), ibm.getElement(i, new Array(16)))));
  }
}
const n = root.listNodes().find((x) => x.getSkin());
console.log("skinned node " + n.getName() + " world " + f(n.getWorldMatrix()));
for (const s of doc.getRoot().listScenes()) console.log("scene children: " + s.listChildren().map((c)=>c.getName()).join(", "));
