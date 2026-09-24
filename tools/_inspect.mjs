import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
const path = process.argv[2];
const doc = await io.read(path);
const root = doc.getRoot();

const xform = (m, p) => [
  m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12],
  m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13],
  m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14],
];

// world bounds + per-material triangle counts & bounds
const matStats = new Map();
let total = 0;
const bounds = [Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
const meshStats = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  let meshTris = 0;
  const mb = [Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices();
    const tris = idx ? idx.getCount()/3 : pos.getCount()/3;
    meshTris += tris; total += tris;
    const name = prim.getMaterial() ? prim.getMaterial().getName() : "(none)";
    const s = matStats.get(name) || { tris: 0, b: [Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity] };
    const p = [0,0,0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      const w = xform(m, p);
      for (let k = 0; k < 3; k++) {
        if (w[k] < bounds[k]) bounds[k] = w[k];
        if (w[k] > bounds[k+3]) bounds[k+3] = w[k];
        if (w[k] < s.b[k]) s.b[k] = w[k];
        if (w[k] > s.b[k+3]) s.b[k+3] = w[k];
        if (w[k] < mb[k]) mb[k] = w[k];
        if (w[k] > mb[k+3]) mb[k+3] = w[k];
      }
    }
    s.tris += tris;
    matStats.set(name, s);
  }
  meshStats.push({ node: node.getName(), mesh: mesh.getName(), tris: meshTris, b: mb });
}

const f = (n) => Number(n).toFixed(3);
console.log("== " + path);
console.log("triangles: " + total.toLocaleString() + "  nodes-with-mesh: " + meshStats.length);
console.log("world bounds: " + bounds.map(f).join(", "));
console.log("size: " + [bounds[3]-bounds[0], bounds[4]-bounds[1], bounds[5]-bounds[2]].map(f).join(" x "));

console.log("\n-- materials (" + root.listMaterials().length + ")");
for (const mat of root.listMaterials()) {
  const s = matStats.get(mat.getName()) || { tris: 0, b: [] };
  const tex = [];
  if (mat.getBaseColorTexture()) tex.push("base");
  if (mat.getMetallicRoughnessTexture()) tex.push("mr");
  if (mat.getOcclusionTexture()) tex.push("occl");
  if (mat.getNormalTexture()) tex.push("normal");
  if (mat.getEmissiveTexture()) tex.push("emis");
  const exts = mat.listExtensions().map((e) => e.extensionName.replace("KHR_materials_",""));
  console.log([
    mat.getName().padEnd(28),
    String(Math.round(s.tris)).padStart(7) + " tris",
    mat.getAlphaMode().padEnd(6),
    "bc=" + mat.getBaseColorFactor().map((v)=>v.toFixed(2)).join(","),
    "m=" + mat.getMetallicFactor().toFixed(2),
    "r=" + mat.getRoughnessFactor().toFixed(2),
    "[" + tex.join(" ") + "]",
    exts.length ? "ext:" + exts.join(",") : "",
    s.b.length ? "box " + s.b.map(f).join(",") : "",
  ].join(" "));
}

console.log("\n-- textures (" + root.listTextures().length + ")");
for (const t of root.listTextures()) {
  const img = t.getImage();
  const size = t.getSize();
  console.log("  " + (t.getName()||"(unnamed)").padEnd(34) + " " + (size ? size.join("x") : "?") + " " + t.getMimeType() + " " + (img ? (img.byteLength/1024).toFixed(0)+"KB" : ""));
}

const uvSets = new Set();
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives())
  for (const sem of prim.listSemantics()) if (/TEXCOORD|COLOR/.test(sem)) uvSets.add(sem);
console.log("\nattributes: " + [...uvSets].sort().join(", "));

if (process.argv.includes("--meshes")) {
  console.log("\n-- meshes");
  for (const m of meshStats.sort((a,b)=>b.tris-a.tris))
    console.log("  " + String(Math.round(m.tris)).padStart(7) + "  " + (m.mesh||m.node) + "  box " + m.b.map(f).join(","));
}

/* Cabin candidates: a material whose whole bbox sits inside the body box
   shrunk toward its centre — the cabin, the dash and the seats — plus how
   high it sits, so seats (low) separate from headliner (high). */
const span = [bounds[3]-bounds[0], bounds[4]-bounds[1], bounds[5]-bounds[2]];
const axes = span.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
const L = axes[0][1], W = axes[1][1], H = axes[2][1];   // length, width, height axes
const inset = (i, frac) => [bounds[i] + span[i]*frac, bounds[i+3] - span[i]*frac];
const [lo_L, hi_L] = inset(L, 0.18), [lo_W, hi_W] = inset(W, 0.12), [lo_H, hi_H] = inset(H, 0.10);
console.log("\n-- cabin candidates (axes: length=" + "xyz"[L] + " width=" + "xyz"[W] + " height=" + "xyz"[H] + ")");
for (const [name, s] of [...matStats.entries()].sort((a,b)=>b[1].tris-a[1].tris)) {
  if (!s.b.length || s.b[0] === Infinity) continue;
  const inside = s.b[L] >= lo_L && s.b[L+3] <= hi_L && s.b[W] >= lo_W && s.b[W+3] <= hi_W && s.b[H] >= lo_H && s.b[H+3] <= hi_H;
  if (!inside) continue;
  const relH = ((s.b[H] - bounds[H]) / span[H] * 100).toFixed(0) + "-" + ((s.b[H+3] - bounds[H]) / span[H] * 100).toFixed(0) + "%h";
  const relL = ((s.b[L] - bounds[L]) / span[L] * 100).toFixed(0) + "-" + ((s.b[L+3] - bounds[L]) / span[L] * 100).toFixed(0) + "%l";
  console.log("  " + String(Math.round(s.tris)).padStart(7) + "  " + name.padEnd(34) + " " + relH + "  " + relL);
}
