#!/usr/bin/env node
/* export-fix: make an export match what the rest of these tools assume before
   the recipe runs on it -- geometry where the node transforms say it is, and
   no vertex colours in the way of the shading bake. Run it FIRST, before
   seat-split: in the lab (the Build tab's "Export fixes" group) that means on
   the shipped file at the start of the draft chain; by hand, on the original.
   seat-split, vertex-shading and occlusion-patch refuse a skinned input for
   the reason under --unskin.

   Usage:
     node tools/export-fix.mjs <in.glb> --report [--unskin] [--drop-color0] [--json]
     node tools/export-fix.mjs <in.glb> <out.glb> [--unskin] [--drop-color0] [--force] [--json]
   --check is the old name of --report and still works.

   --report  read-only: what the file carries and whether it can be fixed.
     summary: { skins, joints, usedJoints, worstIdentityError, unskinnable,
     skinnedNodes, animations, color0Prims, color0Bake, color0Foreign,
     color0Materials, orphanedAccessors, primitives }. `unskinnable` reads
     "can be UN-skinned": the file has a skin and every used joint passes the
     identity test below, so --unskin would work. worstIdentityError is 0 when
     there is no skin, -1 when a weight names a joint the skin does not have. With --unskin and/or --drop-color0 the whole fix runs in
     memory and its checks are reported -- a dry run -- and nothing is written.
     The report's checks never fail the run; they say what a write would do.

   --unskin  Drops a skin that does nothing. The 2021 Elantra exports 136
     joints and no animation: every skinning matrix is the identity, so
     three.js renders each vertex at its raw POSITION and ignores the mesh
     node's transform. Nothing looks wrong on screen -- but seat-split's boxes
     and vertex-shading's seam distances go through the node's world matrix,
     which on a Sketchfab export is the Z-up -> Y-up rotation, so they see the
     car lying on its side in a space that is never drawn. This removes the
     skin and gives each formerly-skinned node the world matrix the renderer
     was already using (the identity), which means local = inverse(parent
     world) -- clearing the node's own translation/rotation/scale is NOT
     enough, because the rotation sits on an ancestor and the car comes out on
     its side. Children of such a node (rare) are re-parented in place: they
     get local = their old world matrix, so nothing else moves.
     It REFUSES (no --force: a non-identity skin moved off its rig is simply
     drawn in the wrong place) unless jointWorld * inverseBind is the identity
     for every joint a vertex is actually weighted to. Check the USED joints
     only, per skin: this rig also carries a _rootJoint and "_end_" tip joints
     scaled by 100 that nothing is weighted to, and they are not identities.
     A vertex with all-zero weights counts as using its first joint, because
     three.js's normalizeSkinWeights gives it (1,0,0,0).
     Joint nodes the removed skin leaves behind are deleted when they and
     everything under them are empty transforms (no mesh, camera, extension,
     extras, animation channel) that were all joints of a removed skin; any
     other node is kept.

   --drop-color0  Removes COLOR_0. tools/vertex-shading.mjs refuses a file that
     already has it, since that is how it stops shading a car twice. The
     Elantra ships a COLOR_0 that is a game shader's data channels, not a
     colour: R is ~1 everywhere while G, B and A carry masks. Rendered
     side by side, with and without, the two are identical -- but confirm that
     for a new car before dropping it (the report's color0Materials gives each
     material's mean channel values to judge by).
     It drops only a FOREIGN COLOR_0. vertex-shading's own bake (a normalised
     8-bit grey VEC3, or any primitive of a material carrying its
     extras.vertexShading marker -- the Maxima's body) IS the panel-gap
     shading, and dropping it silently would undo that work; it is kept, with a
     warning, unless --force.

   Orphans: removing an attribute or a skin in gltf-transform leaves its
   accessor in the document, and the writer stores an orphaned accessor
   UNCOMPRESSED next to the Draco data. Measured: --drop-color0 on the Elantra
   wrote 6,613,592 B from 3,964,440 (+2.65 MB of dead VEC4 floats), --unskin
   on a skinned Accent 4,430,072 B from 966,948 (JOINTS_0, WEIGHTS_0 and the
   inverse-bind matrices). So this tool frees every accessor nothing refers to
   before it writes -- accessors only. It does NOT run gltf-transform's
   prune(): that also drops unused UV sets and collapses solid-colour
   textures, and the project rule is that texture bytes are never touched.
   An input that already carries orphans (an older draft) has them freed too.

   Checks (a failed one refuses the write, exit 3, unless --force; in --report
   they are only reported):
     skin-is-identity          worst |jointWorld*inverseBind - I| <= 1e-4 over
                               the used joints (a hard refusal for --unskin)
     skinned-nodes-in-place    every formerly skinned node's world matrix is
                               the identity (what the renderer was using)
     other-nodes-unmoved       every other node's world matrix is unchanged
     no-skin-left              no skin, no JOINTS_0/WEIGHTS_0 remains
     color0-dropped            no foreign COLOR_0 remains
     no-orphaned-accessors     nothing written that nothing refers to
     textures-unchanged        same images, byte for byte (md5), as the input
   and, read back from the written file (a failure deletes it, unless --force):
     written-textures-identical  the file's image bytes hash as the input's
     written-draco-kept          a Draco input is still Draco on every primitive

   A write that changes nothing (no skin to drop, no foreign COLOR_0, no
   orphan) ends ok:false, "nothing to fix", and writes nothing: each re-encode
   of an unchanged file only drifts its Draco data.

   Exit codes: 0 ok, 1 refused/failed, 2 usage, 3 a check failed. With --json
   the last stdout line is LAB_JSON {...} on every path (lib/shade-cli.mjs). */
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { Accessor } from "@gltf-transform/core";
import { createIO, writeGlb, fileSize } from "./lib/gltf-io.mjs";
import { parseArgs, runTool, UsageError } from "./lib/shade-cli.mjs";

const TOOL = "export-fix";
const USAGE = "usage: export-fix <in.glb> --report [--unskin] [--drop-color0] [--json]\n       export-fix <in.glb> <out.glb> [--unskin] [--drop-color0] [--force] [--json]\n       (--check = --report)";
const SPEC = { bool: ["unskin", "drop-color0", "check", "report", "force", "json"] };
const IDENTITY_TOL = 1e-4;   // jointWorld * inverseBind against I
const PLACE_TOL = 1e-5;      // world matrices after the edit, relative
const TINT_TOL = 0.05;       // mean COLOR_0 channel this far from 1 tints the material

const mul = (a, b) => { const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
/* 4x4 inverse, column-major (Gauss-Jordan; these are affine, so it is exact
   enough and the checks below prove it). */
function invert(m) {
  const a = Array.from(m), inv = I.slice();
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + piv])) piv = r;
    if (piv !== c) for (let k = 0; k < 4; k++) {
      [a[k * 4 + c], a[k * 4 + piv]] = [a[k * 4 + piv], a[k * 4 + c]];
      [inv[k * 4 + c], inv[k * 4 + piv]] = [inv[k * 4 + piv], inv[k * 4 + c]];
    }
    const d = a[c * 4 + c];
    if (Math.abs(d) < 1e-12) throw new Error("singular node matrix");
    for (let k = 0; k < 4; k++) { a[k * 4 + c] /= d; inv[k * 4 + c] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[c * 4 + r];
      if (!f) continue;
      for (let k = 0; k < 4; k++) { a[k * 4 + r] -= f * a[k * 4 + c]; inv[k * 4 + r] -= f * inv[k * 4 + c]; }
    }
  }
  return inv;
}
/* Largest element difference, relative to the element's size: a car modelled
   in centimetres has translations in the thousands, and 1e-5 of those is
   still far below a Draco quantisation step. */
const matErr = (a, b) => { let w = 0; for (let k = 0; k < 16; k++) w = Math.max(w, Math.abs(a[k] - b[k]) / Math.max(1, Math.abs(b[k]))); return w; };
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const fmtE = (x) => x.toExponential(2);
const multiset = (arr) => arr.slice().sort().join(",");

/* What a COLOR_0 is: "bake" when it is what vertex-shading writes (a
   normalised 8-bit VEC3 with R = G = B everywhere -- the same test
   vertex-shading's colorKind uses), "foreign" otherwise. A material carrying
   vertex-shading's marker counts as a bake whatever the accessor looks like. */
function colorKind(prim) {
  const acc = prim.getAttribute("COLOR_0");
  if (!acc) return null;
  const mat = prim.getMaterial();
  if (mat && (mat.getExtras() || {}).vertexShading) return "bake";
  if (acc.getType() !== "VEC3" || acc.getComponentType() !== Accessor.ComponentType.UNSIGNED_BYTE || !acc.getNormalized()) return "foreign";
  const a = acc.getArray();
  for (let i = 0; i < a.length; i += 3) if (a[i] !== a[i + 1] || a[i] !== a[i + 2]) return "foreign";
  return "bake";
}
/* Mean of each channel in 0..1, so a report shows whether a COLOR_0 would
   tint anything: three.js multiplies RGB into the base colour. */
function channelMeans(acc, sums) {
  const a = acc.getArray(), n = acc.getElementSize();
  const ct = acc.getComponentType(), T = Accessor.ComponentType;
  const scale = ct === T.UNSIGNED_BYTE ? 255 : ct === T.UNSIGNED_SHORT ? 65535 : 1;   // the spec allows only these and FLOAT
  for (let i = 0; i < a.length; i += n) for (let k = 0; k < n; k++) sums[k] += a[i + k] / scale;
  sums.count += a.length / n;
}

/* The written file's image bytes, straight from its GLB chunks -- no decode,
   so this proves what is on disk, not what gltf-transform holds in memory. */
function rawGlb(file) {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(path.basename(file) + " is not a GLB");
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  const binAt = 20 + jsonLen;
  const bin = binAt + 8 <= b.length ? b.subarray(binAt + 8, binAt + 8 + b.readUInt32LE(binAt)) : null;
  const images = (json.images || []).map((im) => {
    if (im.bufferView === undefined) return "uri:" + im.uri;
    const bv = json.bufferViews[im.bufferView];
    if (!bin || (bv.buffer || 0) !== 0) return "external:" + im.bufferView;
    return md5(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  });
  return { json, images };
}

await runTool(TOOL, USAGE, async (run) => {
  const { flags, positional } = parseArgs(process.argv.slice(2), SPEC);
  const report = !!(flags.report || flags.check);
  const doUnskin = !!flags.unskin, doDrop = !!flags["drop-color0"];
  const [inPath, outPath] = positional;
  run.input = inPath || null;
  /* At most the paths the mode takes. A stray word used to become the output
     path in --check mode -- the lab server passes no output there, so
     `--check victim.json` overwrote victim.json with a glTF and a .bin. */
  if (!inPath) throw new UsageError("give <in.glb>");
  if (report && positional.length > 1) throw new UsageError("--report takes one path, got " + positional.length + ": " + positional.map((p) => path.basename(p)).join(" "));
  if (!report && positional.length !== 2) throw new UsageError(positional.length > 2 ? "too many paths (" + positional.length + "): give <in.glb> <out.glb>" : "give <out.glb>, or --report");
  if (!report && !doUnskin && !doDrop) throw new UsageError("nothing asked: give --unskin and/or --drop-color0 (or --report)");
  if (!report && !/\.glb$/i.test(outPath)) throw new UsageError("the output must be a .glb (a .gltf would write a separate .bin next to it): " + path.basename(outPath));
  if (!report && path.resolve(outPath) === path.resolve(inPath)) throw new UsageError("write to a new file, not over the input");
  run.bytesIn = fileSize(inPath);
  if (run.bytesIn === null) throw new Error("cannot read " + path.basename(inPath));
  const inName = path.basename(inPath);

  // Recipe Draco bits on write -- see lib/gltf-io.mjs for what the default did.
  const io = await createIO({ encoder: !report });
  const doc = await io.read(inPath);
  const root = doc.getRoot();
  const nodes = root.listNodes();
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const draco = root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression");
  const orphaned = (p) => p.listParents().every((x) => x.propertyType === "Root");
  const imagesBefore = root.listTextures().map((t) => md5(t.getImage() || new Uint8Array()));

  // ---- the skin -------------------------------------------------------------
  /* Used joints per skin, from the nodes that carry it: indices in JOINTS_0
     are into THAT skin's joint list, so one set across skins would test the
     wrong joints on a file with two rigs. */
  const skins = root.listSkins();
  const skinnedNodes = nodes.filter((n) => n.getSkin());
  const used = new Map(skins.map((s) => [s, new Set()]));
  const je = [0, 0, 0, 0], we = [0, 0, 0, 0];
  for (const node of skinnedNodes) {
    const set = used.get(node.getSkin()), mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const j = prim.getAttribute("JOINTS_0"), w = prim.getAttribute("WEIGHTS_0");
      if (!j || !w) continue;
      for (let i = 0; i < j.getCount(); i++) {
        j.getElement(i, je); w.getElement(i, we);
        let sum = 0;
        for (let k = 0; k < 4; k++) { sum += we[k]; if (we[k] > 1e-6) set.add(je[k]); }
        if (!(sum > 1e-6)) set.add(je[0]);
      }
    }
  }
  let worst = 0, worstAt = null, jointCount = 0, usedCount = 0;
  for (const skin of skins) {
    const ibm = skin.getInverseBindMatrices();
    const joints = skin.listJoints();
    jointCount += joints.length; usedCount += used.get(skin).size;
    for (const i of used.get(skin)) {
      if (!joints[i]) { worst = Infinity; worstAt = "joint index " + i + " past the end of " + (skin.getName() || "a skin"); continue; }
      const m = mul(joints[i].getWorldMatrix(), ibm ? ibm.getElement(i, new Array(16)) : I);
      for (let k = 0; k < 16; k++) { const e = Math.abs(m[k] - I[k]); if (e > worst) { worst = e; worstAt = joints[i].getName() || "joint " + i; } }
    }
  }
  const identity = worst <= IDENTITY_TOL;
  const animations = root.listAnimations();

  // ---- COLOR_0 --------------------------------------------------------------
  const kinds = new Map(prims.map((p) => [p, colorKind(p)]));
  const byMat = new Map();
  for (const p of prims) {
    const kind = kinds.get(p);
    if (!kind) continue;
    const acc = p.getAttribute("COLOR_0"), name = p.getMaterial() ? p.getMaterial().getName() : "(none)";
    if (!byMat.has(name)) byMat.set(name, { material: name, prims: 0, kind, type: acc.getType() + "/" + acc.getComponentType(), sums: Object.assign([0, 0, 0, 0], { count: 0 }) });
    const row = byMat.get(name);
    row.prims++;
    if (row.kind !== kind) row.kind = "mixed";
    channelMeans(acc, row.sums);
  }
  const color0Materials = [...byMat.values()].map(({ sums, ...r }) => ({ ...r, mean: sums.slice(0, r.type.startsWith("VEC4") ? 4 : 3).map((s) => +(s / Math.max(1, sums.count)).toFixed(3)) }));
  const color0Prims = [...kinds.values()].filter(Boolean).length;
  const color0Bake = [...kinds.values()].filter((k) => k === "bake").length;
  const orphansIn = root.listAccessors().filter(orphaned).length;

  Object.assign(run.summary, {
    skins: skins.length, joints: jointCount, usedJoints: usedCount,
    worstIdentityError: Number.isFinite(worst) ? +worst.toExponential(3) : -1,
    unskinnable: skins.length > 0 && identity,
    skinnedNodes: skinnedNodes.length, animations: animations.length,
    color0Prims, color0Bake, color0Foreign: color0Prims - color0Bake, color0Materials,
    orphanedAccessors: orphansIn, primitives: prims.length,
  });
  run.log(inName + ": " + prims.length + " primitives, " + skins.length + " skin(s)" +
    (skins.length ? " (" + jointCount + " joints, " + usedCount + " used, " + skinnedNodes.length + " skinned nodes; worst |jointWorld*inverseBind - I| = " + (Number.isFinite(worst) ? fmtE(worst) : "n/a") + (worstAt && !identity ? " at " + worstAt : "") + ")" : "") +
    ", COLOR_0 on " + color0Prims + " (" + color0Bake + " vertex-shading bake)" + (orphansIn ? ", " + orphansIn + " orphaned accessors" : ""));
  /* A COLOR_0 whose RGB is not ~white is drawn: three.js multiplies it into
     the base colour (vertexColors is on whenever COLOR_0 exists). On the
     Elantra most of it is (1,1,1,a) -- the masks sit in alpha, which nothing
     reads -- but hash_8A7A2BEF averages (0.95,1,0) and the tyre wall's G/B
     are masks, so dropping the attribute changes how THOSE look. Name them;
     the full table is in summary.color0Materials. */
  const tinting = color0Materials.filter((r) => r.kind !== "bake" && r.mean.slice(0, 3).some((v) => Math.abs(v - 1) > TINT_TOL));
  for (const r of tinting) run.log("  COLOR_0 tints " + r.material + ": " + r.prims + " prim(s), " + r.type + ", mean " + JSON.stringify(r.mean));

  /* Gates --unskin only: --drop-color0 on a file with a real, moving rig is
     a fine thing to do, and the skin stays. */
  if (skins.length && (report || doUnskin)) run.check("skin-is-identity", identity, identity
    ? "worst " + fmtE(worst) + " over " + usedCount + " used joint(s) (limit " + IDENTITY_TOL + "): the renderer draws every vertex at its raw POSITION"
    : "worst " + (Number.isFinite(worst) ? fmtE(worst) : "n/a") + " at " + worstAt + " (limit " + IDENTITY_TOL + "): the rig really moves vertices, so dropping it would draw them in the wrong place");
  if (skins.length && animations.length) run.warn(animations.length + " animation(s) in the file: the identity test reads the rest pose; removing the skin also stops any that drive its joints");
  if (report && !doUnskin && !doDrop) {
    if (skins.length && identity) run.warn("an identity skin: the other tools would see this car through its node transforms, not where it is drawn -- run Export fixes with --unskin first");
    if (color0Prims - color0Bake) run.warn((color0Prims - color0Bake) + " primitive(s) carry a foreign COLOR_0 (vertex-shading refuses its material) -- --drop-color0 removes it");
    if (tinting.length) run.warn("COLOR_0 tints " + tinting.length + " material(s) on screen (" + tinting.map((r) => r.material).join(", ") + "): dropping it changes their colour -- compare the car with the draft before saving");
    if (orphansIn) run.warn(orphansIn + " orphaned accessor(s) are stored uncompressed; any write by this tool frees them");
    return run.finish(true);
  }

  // ---- the fix, in memory ---------------------------------------------------
  if (doUnskin && skins.length && !identity && !report) {
    return run.finish(false, inName + ": the skin is not the identity (worst " + (Number.isFinite(worst) ? fmtE(worst) : "n/a") + " at " + worstAt + ") -- refusing to drop it; nothing written", 1);
  }
  if (doUnskin && skins.length && !identity) run.warn("--unskin would refuse: the skin is not the identity");
  const worldBefore = new Map(nodes.map((n) => [n, n.getWorldMatrix().slice()]));
  const formerlySkinned = new Set();
  const formerJoints = new Set();
  let freedNodes = 0;
  if (doUnskin && skins.length && identity) {
    /* With the skin gone the node's own world transform starts applying again,
       and on a Sketchfab export that is the Z-up -> Y-up rotation carried by
       an ancestor, which lays the car on its side. The renderer was placing
       these vertices at their raw POSITION, so the node's world matrix has to
       become the identity: local = inverse(parent world). */
    for (const skin of skins) for (const j of skin.listJoints()) formerJoints.add(j);
    for (const node of skinnedNodes) {
      node.setSkin(null);
      const parent = node.getParentNode();
      node.setMatrix(parent ? invert(parent.getWorldMatrix()) : I);
      const mesh = node.getMesh();
      if (mesh) for (const prim of mesh.listPrimitives())
        for (const sem of ["JOINTS_0", "WEIGHTS_0"]) if (prim.getAttribute(sem)) prim.setAttribute(sem, null);
      formerlySkinned.add(node);
    }
    /* Anything that hung under a node whose transform just changed is put
       back where it was: top-down, local = inverse(new parent world) * old
       world. Formerly skinned nodes are skipped (they were just placed). */
    const visit = (node) => {
      if (!formerlySkinned.has(node) && matErr(node.getWorldMatrix(), worldBefore.get(node)) > PLACE_TOL) {
        const parent = node.getParentNode();
        node.setMatrix(parent ? mul(invert(parent.getWorldMatrix()), worldBefore.get(node)) : worldBefore.get(node));
      }
      for (const c of node.listChildren()) visit(c);
    };
    for (const scene of root.listScenes()) for (const n of scene.listChildren()) visit(n);
    for (const skin of skins) skin.dispose();
    /* Former joints that are now empty transforms, whole subtree included. */
    const animated = new Set(animations.flatMap((a) => a.listChannels().map((c) => c.getTargetNode())));
    const empty = (n) => formerJoints.has(n) && !n.getMesh() && !n.getCamera() && !n.getSkin() && !animated.has(n) &&
      !n.listExtensions().length && !Object.keys(n.getExtras() || {}).length && n.listChildren().every(empty);
    const drop = (n) => { for (const c of n.listChildren()) drop(c); n.dispose(); freedNodes++; };
    for (const n of [...formerJoints]) if (!n.isDisposed() && empty(n) && !(n.getParentNode() && empty(n.getParentNode()))) drop(n);
    run.log((report ? "would clear" : "cleared") + " the skin from " + formerlySkinned.size + " node(s), " + freedNodes + " empty joint node(s) " + (report ? "would go" : "deleted"));
  } else if (doUnskin && !skins.length) run.warn("--unskin: " + inName + " has no skin");

  let dropped = 0, keptBake = 0;
  const keptMats = new Set();
  if (doDrop) {
    for (const p of prims) {
      const kind = kinds.get(p);
      if (!kind) continue;
      if (kind === "bake" && !flags.force) { keptBake++; keptMats.add(p.getMaterial() ? p.getMaterial().getName() : "(none)"); continue; }
      p.setAttribute("COLOR_0", null); dropped++;
    }
    if (dropped && tinting.length) run.warn((report ? "would drop" : "dropped") + " a COLOR_0 that tints " + tinting.map((r) => r.material).join(", ") + ": compare those parts with the original before saving");
    if (keptBake) run.warn("kept vertex-shading's grey bake on " + keptBake + " primitive(s) of " + [...keptMats].join(", ") + " -- that IS the panel-gap shading; --force drops it too");
    else if (dropped && color0Bake && flags.force) run.warn((report ? "would drop" : "dropped") + " vertex-shading's bake too (--force): the panel-gap shading of those materials is gone");
    if (!color0Prims) run.warn("--drop-color0: " + inName + " has no COLOR_0");
    run.log((report ? "would drop" : "dropped") + " COLOR_0 from " + dropped + " primitive(s)");
  }

  /* Accessor-only cleanup -- see the header for why not prune(). */
  let freed = 0;
  for (const a of root.listAccessors()) if (orphaned(a)) { a.dispose(); freed++; }
  Object.assign(run.summary, { unskinnedNodes: formerlySkinned.size, freedNodes, droppedColor0: dropped, keptBake, freedAccessors: freed });
  run.log((report ? "would free " : "freed ") + freed + " orphaned accessor(s)");

  // ---- checks ---------------------------------------------------------------
  if (formerlySkinned.size) {
    let w = 0, at = null;
    for (const n of formerlySkinned) { const e = matErr(n.getWorldMatrix(), I); if (e > w) { w = e; at = n.getName(); } }
    run.check("skinned-nodes-in-place", w <= PLACE_TOL, formerlySkinned.size + " formerly skinned node(s), worst |world - I| " + fmtE(w) + (w > PLACE_TOL ? " at " + at + " (a sheared parent cannot be undone by a TRS node)" : ""));
    let o = 0, oAt = null, count = 0;
    for (const n of root.listNodes()) {
      if (formerlySkinned.has(n) || !worldBefore.has(n)) continue;
      count++;
      const e = matErr(n.getWorldMatrix(), worldBefore.get(n)); if (e > o) { o = e; oAt = n.getName(); }
    }
    run.check("other-nodes-unmoved", o <= PLACE_TOL, count + " other node(s), worst change " + fmtE(o) + (o > PLACE_TOL ? " at " + oAt : ""));
    const leftAttr = root.listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getAttribute("JOINTS_0") || p.getAttribute("WEIGHTS_0")).length;
    run.check("no-skin-left", !root.listSkins().length && !leftAttr && !root.listNodes().some((n) => n.getSkin()), root.listSkins().length + " skin(s), " + leftAttr + " primitive(s) with JOINTS_0/WEIGHTS_0");
  }
  if (doDrop && color0Prims) {
    const left = root.listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getAttribute("COLOR_0") && (flags.force || colorKind(p) === "foreign")).length;
    run.check("color0-dropped", left === 0, dropped + " dropped, " + left + " foreign left" + (keptBake ? ", " + keptBake + " bake(s) kept" : ""));
  }
  const orphansLeft = root.listAccessors().filter(orphaned).length;
  run.check("no-orphaned-accessors", orphansLeft === 0, freed + " freed, " + orphansLeft + " left");
  const imagesAfter = root.listTextures().map((t) => md5(t.getImage() || new Uint8Array()));
  run.check("textures-unchanged", multiset(imagesAfter) === multiset(imagesBefore), imagesAfter.length + " image(s) of " + imagesBefore.length + " before, " + (multiset(imagesAfter) === multiset(imagesBefore) ? "md5-identical" : "DIFFERENT bytes"));

  if (report) {
    if (!formerlySkinned.size && !dropped && !freed) run.warn("a write with these flags would change nothing (\"nothing to fix\")");
    return run.finish(true);
  }
  if (!formerlySkinned.size && !dropped && !freed) {
    return run.finish(false, "nothing to fix in " + inName + ": " + [doUnskin ? "no skin" : null, doDrop ? (keptBake ? "only vertex-shading's bake as COLOR_0 (kept; --force drops it)" : "no COLOR_0") : null].filter(Boolean).join(", ") + "; nothing written", 1);
  }
  if (run.failed.length && !flags.force) {
    return run.finish(false, "checks failed (" + run.failed.map((c) => c.name).join(", ") + "); nothing written. Pass --force to write anyway.", 3);
  }
  if (run.failed.length) run.warn("writing despite failed checks (--force): " + run.failed.map((c) => c.name).join(", "));

  // ---- write, then read the file back ----------------------------------------
  await writeGlb(io, doc, outPath);
  const outName = path.basename(outPath);
  const written = rawGlb(outPath);
  const imgOk = multiset(written.images) === multiset(imagesBefore);
  run.check("written-textures-identical", imgOk, written.images.length + " image(s) in " + outName + ", " + (imgOk ? "md5-identical to the input's" : "NOT the input's bytes"));
  if (draco) {
    const wp = (written.json.meshes || []).flatMap((m) => m.primitives);
    const dp = wp.filter((p) => p.extensions && p.extensions.KHR_draco_mesh_compression).length;
    run.check("written-draco-kept", dp === wp.length, dp + " of " + wp.length + " primitives Draco-compressed");
  }
  const lateFail = run.failed.filter((c) => c.name.startsWith("written-"));
  if (lateFail.length && !flags.force) {
    rmSync(outPath, { force: true });
    return run.finish(false, "the written file failed " + lateFail.map((c) => c.name).join(", ") + "; deleted " + outName + ". Pass --force to keep it.", 3);
  }
  run.output = outPath;
  return run.finish(true);
});
