#!/usr/bin/env node
/* vertex-shading: give a car body the Camry's shading when its export has no
   occlusion map to carry it -- ray-traced ambient occlusion plus the seam
   lines, baked into vertex colours (COLOR_0). Runs on the SHIPPED Draco file.

   History worth keeping: the first Maxima bake (2026-09-17) shipped with
   every seam as TWO parallel lines and was reverted. A vertex colour is not
   prefiltered the way a map is, so its band must be wider than a map's -- but
   the guard meant to spare a panel tucked behind another was unsigned, so it
   also lit the faces INSIDE each gap, and a wide band darkening both skins
   around a lit strip reads as two lines as soon as pixels resolve it (a phone
   at device pixel ratio 3). --seam-behind is now signed against the outward
   side, which the AO pass already picks per vertex, so a gap's own walls stay
   dark. Judge every candidate at BOTH densities: the desktop metrics all
   passed while the phone was wrong -- the self-checks below now read the
   phone's pixel from the data before anything is written.

   The benchmark and the reasoning are tools/occlusion-patch.mjs's: the Camry's
   body reads well because its paint's occlusion map is on (panel luminance 185
   at page size against 204-207 unshaded) and draws each panel gap as a thin
   line (page-scale door-seam contrast 18). That tool patches a map in place.
   The Maxima has no map, no images at all, and every body part carries its own
   overlapping 0-1 UVs, so no single map could hold one; its body is dense
   (347k triangles, support loops a few mm from every panel edge), so the same
   shading is stored per vertex instead. three.js multiplies COLOR_0 into the
   base colour, so the page's silver from CAR_LOOK_PROFILE lands on top.

   Per vertex of the material, shade = ao * seam, written as an 8-bit colour.

     ao    cosine-weighted hemisphere rays against every opaque triangle of the
           model (and, with --ao-ground, a ground plane under the tyres), out
           to --ao-distance mm. Both sides of the surface are tried and the more
           open one kept, so a panel whose normals point inward still reads its
           outside. --ao-strength eases it (1 - s * (1 - ao)), --ao-floor
           clamps it, and --ao-hidden-below t replaces a vertex whose more open
           side is still under t with --ao-hidden-shade (default 0.8): such
           surfaces are enclosed, seen only through the hairline cracks between
           patches of one panel, and baked black they show as dotted lines.
           Spread over worker threads (--threads n, default every core; see
           lib/shade-ao.mjs): each vertex is independent, so the colours are
           bit-identical to the single-threaded pass for any thread count.
           Progress redraws one "\r" line on a terminal and prints a plain
           line per quarter into a pipe (the lab server's log).

     seam  --seams <part substr,...|all|auto>: the distance in mm from the
           vertex to the nearest triangle of ANOTHER listed part (parts are node
           names; a name two nodes share -- the Accent's six "Geom3D" -- is
           split into "name@node index", see lib/shade-geom.mjs
           splitSharedPartNames), through --curve, exactly as occlusion-patch applies it to
           texels -- but NOT with the same numbers. A map is prefiltered (texel
           minimum, dilation, mipmaps), a vertex colour is not, so a line
           narrower than a pixel at page size (~12 mm of car) is hit or missed
           pixel by pixel and reads as DOTS. The curve here is therefore wider
           and lighter. `auto` picks the body shell plus the opening/bolt-on
           panels and no trim (lib/shade-geom.mjs autoSeamParts); on the Maxima
           that is every part but the two mirrors, which it shipped with `all`.
           Two guards keep the width from painting blobs: --seam-coarse mm
           fades the seam on vertices whose longest edge is longer than that,
           and --seam-behind (DEFAULT since 2026-09-30; --no-seam-behind turns
           it off) ignores a nearest neighbour lying BEHIND the surface (a
           bumper tucked under a quarter panel), signed against the outward
           side the AO pass picked. Every shipped command passed it.

     scale --mm-per-unit n, or --car-length-mm n (the car's real length over
           the paint's longest extent: 4897 on the Maxima gives 1024.9 against
           the 1025 it shipped with).

   Draco: gltf-transform decodes KHR_draco_mesh_compression on read and the
   writer re-encodes every primitive on write, at the recipe's bits through
   lib/gltf-io.mjs writeGlb (NORMAL 12 -- the old default re-quantised normals
   to 10). The old claim that "a vertex colour cannot be added under Draco"
   was about editing in place; decoding and re-encoding carries it. Measured
   on the shipped Maxima (2026-09-30): the colour is an 8-bit integer
   attribute, which Draco stores losslessly (its quantisation only touches
   float attributes -- every baked value read back exact); every decoded
   position comes back on exactly the same 14-bit grid point (they are
   already quantised, and the grid is the primitive's own bounds), normals
   within 0.05 deg; the re-encode drops only the zero-area triangles
   (1619 of the 1.18M, all invisible) and merges duplicate vertices. So a
   bake on the shipped file renders the same as one baked before `draco`, and
   no original is needed. An uncompressed input is written uncompressed.

   Run once: a primitive whose COLOR_0 is a grey 8-bit bake (R = G = B, as
   this tool writes), or a material carrying this tool's marker
   (extras.vertexShading, with the settings, written on every bake and kept
   by gltf-transform), is refused unless --force, which REPLACES the bake --
   it is computed from geometry alone, so a forced re-bake never stacks. Any
   other COLOR_0 (the Elantra's game-shader VEC4 float masks) is refused with
   the reason; --drop-foreign-color0 drops it from this material's primitives
   first (the recipe's route is export-fix --drop-color0 before this tool).
   A paint that already has an occlusion map warns (the map branch,
   occlusion-patch, is the rule for such a car), and one carrying
   occlusion-patch's marker is refused without --force: both would shade it.
   --report refuses none of these -- it writes nothing -- but lists each as a
   warning ("a write would refuse: ..."), so the page's Check says what Shade
   gaps will say before it is pressed.

   A skinned export (a skin that some primitive draws through) is refused
   outright, report included: the vertices are read through the node
   transforms, so a Sketchfab rig lies on its side here (lib/shade-cli.mjs
   isSkinned). Run export-fix --unskin first.

   Self-checks, from the data before writing (lib/shade-checks.mjs: what a
   camera straight down each seam sees, at a phone's pixel of 4.2 mm and at a
   1 mm close-up; the shade read by barycentric interpolation, as the GPU
   does). A failed check refuses the write (exit 3) unless --force. --report
   runs the same checks without writing: on a baked file, on the bake it has
   (the health check; the AO is then not recomputed unless --seams is given,
   since it would be thrown away), and on an unbaked one, on the bake these
   flags would make -- the write's verdict, ok either way, with a warning
   when a write would refuse. Limits,
   set between the Maxima's accepted settings (page: panel 188, contrast 16,
   19% of rows broken against the Camry's 185 / 18 / 21%) and its failures:
     seam-single-line  seams with two dips at a phone pixel <= 12% (accepted
                       7.2%; the first curve 0:0.55,8:0.55,16:1 28% even
                       with the signed guard; the reverted first attempt,
                       rebuilt with SHADE_REGRESS_GUARD=unsigned, 73%)
     seam-profile-v    the median seam profile at a phone pixel has ONE dip
                       (the reverted attempt's has two with a ridge between)
     seam-no-crease    seams with a dip beyond the curve's reach <= 8%
     no-hidden-flange-lines  seam-darkened vertices whose nearest neighbour
                       is under the skin <= 8% (accepted 5.7%, the fade
                       between -0.35 and -0.7; 13% with --no-seam-behind)
     seam-depth        median depth at a phone pixel 0.20-0.70 (accepted 0.52)
     seam-width        median close-up width <= 16 mm (accepted 7.5; the
                       first curve 22)
     panel-tone        interior median shade 0.70-0.88 (accepted 0.80; the
                       Corolla at a 2 m reach read 0.88, lighter than the
                       Camry on the page, and passes at 3 m with 0.83)
     specks            interior samples darker than half the panel <= 3%
                       (accepted 0.6%)
   Low-poly exports (the Sonata, the Elantra) fail seam-depth at
   --seam-coarse 20: their long edges fade the line to 0.13. A coarser fade
   (--seam-coarse 40-80) deepens it but trips the flange check (9-10%);
   those two need a look before --force.

   --seed n [--tries k]  (the lab's "Random seams"; lib/variation.mjs): draw
       the settings no flag fixed from a PRNG seeded with n -- AO reach,
       strength, hidden-below and its shade, floor, the seam curve's core,
       hold and ease, --seam-coarse -- each within a range around the
       Maxima's shipped bake (listed where they are drawn, below), and bake
       the first variant whose checks above all pass, trying up to k (default
       8, at most 20) draws. A flag given is fixed and the rest vary; under
       --seed, unset AO flags are not "off" but drawn, and --ao-ground is on
       unless --no-ao-ground. The AO reach is drawn once per run (a new reach
       is a new trace, 54 s on the Maxima); the retries vary the rest on the
       same trace. A variant whose colours equal an earlier one's is drawn
       again. None passing: exit 3 and nothing written, naming the closest
       variant and its failed checks (with --force, the closest is written).
       The same seed, input and flags give the same file, byte for byte but
       the marker's date; the marker and summary.variation carry the seed and
       the drawn values. Without --seed nothing changes: the flags above give
       exactly the bake they always gave. --report on a baked file ignores
       --seed (it measures the bake the file has).

   Usage:
     node tools/vertex-shading.mjs <in.glb> --report --material <name> (--mm-per-unit n | --car-length-mm n) [--seams parts|all|auto] [ao flags] [--seed n [--tries k]]
     node tools/vertex-shading.mjs <in.glb> <out.glb> --material <name> (--mm-per-unit n | --car-length-mm n)
       [--ao-distance mm --ao-rays n --ao-ground|--no-ao-ground --ao-strength s --ao-floor f --ao-hidden-below t --ao-hidden-shade s]
       [--seams parts|all|auto [--curve mm:f,...] [--seam-coarse mm] [--no-seam-behind]]
       [--seed n [--tries k]] [--threads n] [--drop-foreign-color0] [--force] [--json]

   The Maxima's shipped bake, now on the shipped file (see index.html step 7):
     --material body --car-length-mm 4897 --ao-distance 2050 --ao-rays 128
     --ao-ground --ao-strength 1.0 --ao-hidden-below 0.25 --seams all
     --curve 0:0.45,4:0.45,8:1 --seam-coarse 20 */
import { Accessor, Primitive } from "@gltf-transform/core";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { createIO, writeGlb, fileSize } from "./lib/gltf-io.mjs";
import { parseArgs, parseCurve, curveAt, runTool, UsageError, isSkinned, SKINNED_ERROR } from "./lib/shade-cli.mjs";
import { grow, xform, xformDir, partGrid, triArea, mmPerUnitFromLength, autoSeamParts, splitSharedPartNames } from "./lib/shade-geom.mjs";
import { aoPass, aoShade } from "./lib/shade-ao.mjs";
import { seamCheck, profileDips } from "./lib/shade-checks.mjs";
import { parseSeed, parseTries, runVariants, fingerprint, noVariantMessage } from "./lib/variation.mjs";

const TOOL = "vertex-shading";
const USAGE = "usage: vertex-shading <in.glb> --report --material name (--mm-per-unit n | --car-length-mm n) [--seams parts|all|auto] [ao flags] [--seed n [--tries k]] [--json]\n       vertex-shading <in.glb> <out.glb> --material name (--mm-per-unit n | --car-length-mm n) [--ao-distance mm --ao-rays n --ao-ground|--no-ao-ground --ao-strength s --ao-floor f --ao-hidden-below t --ao-hidden-shade s] [--seams parts|all|auto [--curve mm:f,...] [--seam-coarse mm] [--no-seam-behind]] [--seed n [--tries k]] [--threads n] [--drop-foreign-color0] [--force] [--json]";
const SPEC = {
  bool: ["report", "force", "json", "drop-foreign-color0"],
  value: ["material", "mm-per-unit", "car-length-mm", "ao-distance", "ao-rays", "ao-strength", "ao-floor", "ao-hidden-below", "ao-hidden-shade", "seams", "curve", "seam-coarse", "threads", "seed", "tries"],
  // --ao-ground reads true/false/unset: unset is off without --seed and on with it.
  negatable: ["seam-behind", "ao-ground"],
  retired: { "seam-sideways": "it was the UNSIGNED guard that lit the gap walls and doubled every Maxima seam; the signed guard, --seam-behind, is the default now" },
};
const MARKER_VERSION = 2;
const TARGETS = { doubled4: 0.12, crease4: 0.08, depth4: [0.2, 0.7], width1: 16, panel: [0.7, 0.88], specks: 0.03, fromBehind: 0.08 };

const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x);

/* What a primitive's COLOR_0 is: "bake" when it is what this tool writes (a
   normalised 8-bit VEC3 with R = G = B everywhere), "foreign" otherwise. */
function colorKind(acc) {
  if (!acc) return null;
  if (acc.getType() !== "VEC3" || acc.getComponentType() !== Accessor.ComponentType.UNSIGNED_BYTE || !acc.getNormalized()) return "foreign";
  const a = acc.getArray();
  for (let i = 0; i < a.length; i += 3) if (a[i] !== a[i + 1] || a[i] !== a[i + 2]) return "foreign";
  return "bake";
}

await runTool(TOOL, USAGE, async (run) => {
  const { flags, positional } = parseArgs(process.argv.slice(2), SPEC);
  const [inPath, outPath] = positional;
  run.input = inPath || null;
  const materialName = flags.material;
  if (!inPath || !materialName || (!flags.report && !outPath) || positional.length > 2) throw new UsageError("give <in.glb>, --material and either <out.glb> or --report");
  if (flags["mm-per-unit"] !== undefined && flags["car-length-mm"] !== undefined) throw new UsageError("give --mm-per-unit or --car-length-mm, not both");
  if (flags["mm-per-unit"] === undefined && flags["car-length-mm"] === undefined) throw new UsageError("give the scale: --mm-per-unit n or --car-length-mm n");
  run.input = inPath; run.bytesIn = fileSize(inPath);
  if (run.bytesIn === null) throw new Error("cannot read " + basename(inPath));
  const num = (k, d) => {
    if (flags[k] === undefined) return d;
    const v = Number(flags[k]);
    if (!Number.isFinite(v)) throw new UsageError("--" + k + " wants a number");
    return v;
  };
  num("mm-per-unit", 0); num("car-length-mm", 0); // a typo'd scale is a usage error before the read, not after
  const aoDistanceMm = num("ao-distance", 0);
  const aoRays = num("ao-rays", 128);
  const aoStrength = num("ao-strength", 1);
  const aoFloor = num("ao-floor", 0);
  const aoHiddenBelow = num("ao-hidden-below", 0);
  const aoHiddenShade = num("ao-hidden-shade", 0.8);
  const threads = num("threads", availableParallelism());
  const seamArg = flags.seams ? flags.seams.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const seamCoarseMm = num("seam-coarse", 0);
  const behind = flags["seam-behind"] !== false;
  /* The seam curve, piecewise linear in mm, 1 beyond the last point. The
     default is the first Maxima attempt's; the shipped one is narrower
     (0:0.45,4:0.45,8:1 -- see the header), passed explicitly. */
  const CURVE = flags.curve ? parseCurve(flags.curve, "0:0.45,4:0.45,8:1") : [[0, 0.55], [8, 0.55], [16, 1]];
  const REACH_MM = CURVE[CURVE.length - 1][0];
  /* --seed: the unset settings are drawn (see the variants below), so the
     AO is on unless --ao-distance 0 says otherwise. */
  const seeded = flags.seed !== undefined;
  const seed = seeded ? parseSeed(flags.seed, UsageError) : null;
  if (flags.tries !== undefined && !seeded) throw new UsageError("--tries goes with --seed");
  const tries = seeded ? parseTries(flags.tries, UsageError) : 1;
  const aoWanted = seeded ? flags["ao-distance"] === undefined || aoDistanceMm > 0 : aoDistanceMm > 0;
  if (!flags.report && !aoWanted && !seamArg) throw new UsageError("nothing to bake: give --ao-distance and/or --seams");

  // Recipe Draco bits on write -- see lib/gltf-io.mjs for what the default did.
  const io = await createIO();
  const doc = await io.read(inPath);
  const root = doc.getRoot();
  if (isSkinned(doc)) throw new Error(SKINNED_ERROR);
  const draco = root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression");
  run.summary.draco = draco;
  const mat = root.listMaterials().find((m) => m.getName() === materialName);
  if (!mat) throw new Error("no material named " + materialName + " (this file has: " + root.listMaterials().map((m) => m.getName()).join(", ") + ")");
  const extras = mat.getExtras() || {};
  const marker = extras.vertexShading || null;
  const mapMarker = extras.occlusionPatch || null;
  run.summary.material = materialName;
  run.summary.marker = marker;
  if (mat.getOcclusionTexture()) run.warn(materialName + " already has an occlusion map" + (mapMarker ? " patched by occlusion-patch (" + mapMarker.date + ")" : "") + ": the rule is occlusion-patch for such a car, and baking on top shades it twice");

  // ---- gather -----------------------------------------------------------------
  /* Occluders: every opaque triangle in world space. Targets: every vertex of
     the material's primitives, with its world normal and its part (node name).
     `world` also keeps the see-through ones, for the checks' outside test. */
  const occ = [], world = [];
  const targets = [];
  const modelMin = [Infinity, Infinity, Infinity], modelMax = [-Infinity, -Infinity, -Infinity];
  const paintMin = [Infinity, Infinity, Infinity], paintMax = [-Infinity, -Infinity, -Infinity];
  const seenPrim = new Set();
  const colors = { bake: 0, foreign: 0, foreignElsewhere: 0 };
  const nodes = root.listNodes();
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const pm = prim.getMaterial();
      const posAcc = prim.getAttribute("POSITION");
      if (!posAcc) continue;
      const n = posAcc.getCount();
      const P = new Float64Array(n * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const p = xform(m, posAcc.getElement(i, v));
        P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2];
        grow(modelMin, modelMax, p);
        if (pm === mat) grow(paintMin, paintMax, p);
      }
      const idx = prim.getIndices() ? prim.getIndices().getArray() : null;
      const triCount = idx ? idx.length / 3 : n / 3;
      const corner = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
      const tris = [];
      for (let t = 0; t < triCount; t++) tris.push([corner(t, 0), corner(t, 1), corner(t, 2)]);
      const opaque = !pm || pm.getAlphaMode() !== "BLEND";
      for (const [a, b, c] of tris) {
        const nine = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
        if (opaque) for (const x of nine) occ.push(x);
        for (const x of nine) world.push(x);
      }
      const kind = colorKind(prim.getAttribute("COLOR_0"));
      if (pm !== mat) { if (kind) colors.foreignElsewhere++; continue; }
      if (seenPrim.has(prim)) { run.warn("a " + materialName + " primitive is instanced twice; shaded under its first node only"); continue; }
      seenPrim.add(prim);
      if (kind) colors[kind]++;
      const nrmAcc = prim.getAttribute("NORMAL");
      const N = new Float64Array(n * 3);
      if (nrmAcc) for (let i = 0; i < n; i++) { const d = xformDir(m, nrmAcc.getElement(i, v)); N[i * 3] = d[0]; N[i * 3 + 1] = d[1]; N[i * 3 + 2] = d[2]; }
      targets.push({ prim, count: n, pos: P, nrm: N, part: node.getName() || mesh.getName() || "?", node: ni, tris, kind });
    }
  }
  if (!targets.length) throw new Error("no triangle primitive uses " + materialName);
  /* Parts are node names, split by node only where two nodes share one (the
     Accent's six "Geom3D"; lib/shade-geom.mjs splitSharedPartNames). Unique
     names are left exactly as they were, so those cars bake as before. */
  const sharedNames = splitSharedPartNames(targets);
  if (sharedNames.length) {
    run.summary.sharedPartNames = sharedNames;
    run.log("parts: " + sharedNames.map((x) => '"' + x.name + '" names ' + x.nodes + " nodes").join(", ") + " -- each node is its own part (name@node index)");
  }
  const occTris = new Float32Array(occ);
  occ.length = 0;
  const size = Math.max(...modelMax.map((h, k) => h - modelMin[k]));

  // ---- scale ------------------------------------------------------------------
  let mmPerUnit = num("mm-per-unit", 0), scaleSource = "--mm-per-unit";
  if (flags["car-length-mm"] !== undefined) {
    const L = num("car-length-mm", 0);
    if (!(L > 0)) throw new UsageError("--car-length-mm wants the car's length in mm");
    const s = mmPerUnitFromLength(paintMin, paintMax, L);
    mmPerUnit = s.mmPerUnit;
    scaleSource = "--car-length-mm " + L + " over the paint's " + s.axis + " extent " + s.units.toPrecision(5);
  }
  if (!(mmPerUnit > 0)) throw new UsageError("--mm-per-unit wants a positive number");
  const aoDistance = aoDistanceMm / mmPerUnit;     // mm -> model units
  run.log(inPath + ": " + targets.length + " " + materialName + " primitives, " + targets.reduce((s, t) => s + t.count, 0) + " vertices; " + occTris.length / 9 + " opaque occluder triangles; model " + f3(modelMin) + " -> " + f3(modelMax) + " (" + ((size * mmPerUnit) / 1000).toFixed(2) + " m long); " + mmPerUnit.toFixed(2) + " mm per unit (" + scaleSource + ")" + (draco ? "; Draco in, Draco out at the recipe's bits" : ""));

  // ---- state and the run-once guard -----------------------------------------
  run.summary.color0 = { bakePrims: colors.bake, foreignPrims: colors.foreign, otherMaterialsWithColor0: colors.foreignElsewhere };
  run.summary.state = { shaded: !!(marker || colors.bake), marker: !!marker, foreignColor0: colors.foreign > 0, mapOn: !!mat.getOcclusionTexture(), mapPatched: !!mapMarker };
  run.log("state: " + (marker ? "baked by " + TOOL + " on " + marker.date + " " + JSON.stringify(marker.settings || {}) : colors.bake ? colors.bake + " primitives carry a grey 8-bit COLOR_0 bake (no marker: baked before markers existed)" : "no vertex shading") +
    (colors.foreign ? "; " + colors.foreign + " primitives carry a FOREIGN COLOR_0" : "") + (colors.foreignElsewhere ? "; " + colors.foreignElsewhere + " primitives of other materials carry COLOR_0 (left alone)" : ""));
  /* The refusals a write would make. --report writes nothing, so it does not
     refuse -- but it must SAY them: the panel-gaps audit found Check passing
     on the Elantra (foreign COLOR_0 on its carpaint) and Shade gaps then
     refusing it, with nothing on the page in between to say why. In report
     mode each becomes a warning naming the fix. */
  const fileName = basename(inPath);
  const refusals = [];
  if (mapMarker && !flags.force) refusals.push(materialName + "'s occlusion map was patched by occlusion-patch (" + mapMarker.date + "); a vertex bake on top would shade it twice. Pass --force if that is intended.");
  if (colors.foreign && !flags["drop-foreign-color0"]) refusals.push(colors.foreign + " " + materialName + " primitives carry a COLOR_0 that is not a grey bake (e.g. the Elantra's game-shader VEC4 masks). Run Export fixes → --drop-color0 first (the recipe's route: it drops every material's COLOR_0 and its dead accessors), or pass --drop-foreign-color0 to replace it on this material only, after checking the car renders the same without it.");
  if ((marker || colors.bake) && !flags.force) refusals.push(fileName + " is shaded already (" + (marker ? "marker " + marker.date : colors.bake + " grey COLOR_0 primitives") + "). Pass --force to REPLACE the bake (it never stacks: the shade is computed from geometry alone).");
  if (!flags.report) {
    if (refusals.length) throw new Error(refusals[0]);
    if (marker || colors.bake) run.warn("replacing the existing bake (--force)");
  } else {
    for (const r of refusals) run.warn("a write would refuse: " + r);
  }

  /* --seed on a --report of a baked file: the report measures the bake the
     file HAS (the health check), which no seed changes. */
  const useSeed = seeded && !(flags.report && colors.bake > 0);
  if (seeded && !useSeed) run.warn("--seed ignored: --report on a baked file measures the bake it has, which no seed changes");
  const aoGround = useSeed ? flags["ao-ground"] !== false : !!flags["ao-ground"];

  // ---- parts --------------------------------------------------------------------
  const partNames = [...new Set(targets.map((t) => t.part))];
  const partArea = new Map(partNames.map((n) => [n, 0]));
  for (const tg of targets) {
    let a = 0;
    for (const [i, j, k] of tg.tris) a += triArea([tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]], [tg.pos[j * 3], tg.pos[j * 3 + 1], tg.pos[j * 3 + 2]], [tg.pos[k * 3], tg.pos[k * 3 + 1], tg.pos[k * 3 + 2]]);
    partArea.set(tg.part, partArea.get(tg.part) + a);
  }
  const auto = autoSeamParts(partNames.map((name) => ({ name, area: partArea.get(name) })));
  const seamParts = !seamArg ? () => false
    : seamArg.includes("auto") ? (part) => auto.listed.has(part)
    : seamArg.includes("all") ? () => true
    : (part) => seamArg.some((s) => part.includes(s));
  if (seamArg) {
    const unmatched = seamArg.filter((s) => s !== "all" && s !== "auto" && !partNames.some((p) => p.includes(s)));
    if (unmatched.length) throw new Error("--seams terms match no part of " + materialName + ": " + unmatched.join(", ") + " (parts: " + partNames.join(", ") + ")");
    const listedNames = partNames.filter(seamParts);
    if (listedNames.length < 2) run.warn("only " + listedNames.length + " listed part(s): a seam needs two, so no line will be drawn (a body in ONE node has no second part to measure against -- the Optima and the Accent)");
    run.summary.seams = { arg: seamArg.join(","), parts: listedNames, curve: CURVE, reachMm: REACH_MM, seamCoarseMm, seamBehind: behind };
  }
  run.summary.scale = { mmPerUnit: r3(mmPerUnit), source: scaleSource };

  // ---- ambient occlusion ------------------------------------------------------
  /* --report on a file that already carries a bake measures THAT bake (the
     health check below), so an AO pass would be computed and thrown away --
     36 s against 6.7 s on the Optima, minutes on the Maxima. It is skipped
     unless --seams is given too: the seam pass reads which side of each
     vertex is outward from the AO pass, and the health check of a baked file
     then lists the parts these flags name. Without it the check's outside
     test tries the stored normal before its flip instead of the AO's side
     first, which reads the same within a hair (the Optima's bake, measured
     2026-10-04: panel 0.800 both ways, specks 0.898% against 0.899%, in 2.2 s
     against 4.5 s). */
  const aoOf = new Map();
  const tty = !!process.stdout.isTTY;
  /* One trace. raw (--seed): the openness per vertex instead of the shade,
     which each variant shades with its own strength, floor and hidden-below
     (lib/shade-ao.mjs aoShade) -- the trace is the cost, the shade is not. */
  const traceAo = async (distanceMm, raw) => {
    const t0 = Date.now();
    /* Progress: a "\r" line on a terminal. Through the lab server stdout is a
       pipe, where every "\r" redraw became one ever-growing log line (about
       70 of them on the Maxima) that pushed the result out of the page's log
       tail -- so a pipe gets a plain line at each quarter instead. */
    let lastQuarter = 0;
    const onProgress = (done, total) => {
      const pct = Math.round((100 * done) / total), secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (tty) { process.stdout.write("\r  ao " + pct + "%  (" + secs + "s, " + threads + " threads)   "); return; }
      const q = Math.floor((4 * done) / total);
      if (q > lastQuarter && q < 4) { lastQuarter = q; run.log("  ao " + 25 * q + "%  (" + secs + "s, " + threads + " threads)"); }
    };
    const res = await aoPass({
      occTris, targets, rays: aoRays, distance: distanceMm / mmPerUnit, ground: aoGround, groundY: modelMin[1], size,
      strength: aoStrength, floor: aoFloor, hiddenBelow: aoHiddenBelow, hiddenShade: aoHiddenShade, threads, onProgress, raw,
    });
    if (tty) process.stdout.write("\n");
    const seconds = +((Date.now() - t0) / 1000).toFixed(1);
    run.log("ao: " + targets.reduce((s, t) => s + t.count, 0) + " vertices x " + aoRays + " rays in " + ((Date.now() - t0) / 1000).toFixed(1) + "s on " + threads + " threads" + (raw ? " (openness at " + distanceMm + " mm, shaded per variant)" : ""));
    return { res, seconds };
  };
  const skipAo = !useSeed && aoDistance > 0 && flags.report && colors.bake > 0 && !seamArg;
  if (skipAo) run.log("ao: not recomputed -- the file is baked already and --report measures the bake it has (give --seams to recompute it)");
  if (!useSeed && aoDistance > 0 && !skipAo) {
    const { res, seconds } = await traceAo(aoDistanceMm, false);
    targets.forEach((tg, i) => { const out = res[i].ao; out.sign = res[i].sign; aoOf.set(tg, out); });
    run.summary.ao = { distanceMm: aoDistanceMm, rays: aoRays, ground: aoGround, strength: aoStrength, floor: aoFloor, hiddenBelow: aoHiddenBelow, hiddenShade: aoHiddenShade, threads, seconds };
  }

  // ---- seams --------------------------------------------------------------------
  /* The distance from every listed vertex to the nearest other listed part,
     out to radiusMm, and where that neighbour lies. signOf(tg) is the AO
     pass's outward side per vertex (or null). A seeded run measures once out
     to the widest curve it can draw: the curve is applied afterwards, and a
     neighbour beyond a variant's reach shades nothing (curveAt is 1 there). */
  const seamOf = new Map(), sideOf = new Map();
  const seamPass = (radiusMm, signOf) => {
    const listed = targets.filter((t) => seamParts(t.part));
    const radius = radiusMm / mmPerUnit;
    const tris = [];
    for (const tg of listed) for (const [a, b, c] of tg.tris) {
      tris.push({ part: tg.part, corners: [a, b, c].map((i) => [tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]]) });
    }
    const nearest = partGrid(tris, radius * 2);
    for (const tg of listed) {
      const out = new Float32Array(tg.count).fill(Infinity);
      const side = new Float32Array(tg.count).fill(1);
      const sign = signOf(tg);
      for (let i = 0; i < tg.count; i++) {
        const p = [tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]];
        const { d, q } = nearest.closest(p, tg.part, radius);
        out[i] = d;
        /* Where the nearest other part lies, along the OUTWARD normal: +1 in
           front of the surface, 0 beside it, -1 directly behind. A gap's own
           walls face across the gap, so their neighbour is in front and they
           stay dark -- lighting them is what split every seam into two lines.
           Only a panel tucked BEHIND another (the rear bumper under the quarter
           panel) is suppressed. */
        if (q && d > 0) {
          const sgn = sign ? sign[i] : 1;
          const n = [tg.nrm[i * 3] * sgn, tg.nrm[i * 3 + 1] * sgn, tg.nrm[i * 3 + 2] * sgn];
          side[i] = ((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / d;
        }
      }
      seamOf.set(tg, out);
      sideOf.set(tg, side);
    }
  };
  const signFromAo = (tg) => { const ao = aoOf.get(tg); return ao && ao.sign ? ao.sign : null; };
  if (seamArg && !useSeed) seamPass(flags.report ? 40 : REACH_MM, signFromAo);
  /* --seam-behind: full weight in front of or beside the surface, fading out as
     the neighbour goes behind it (-0.35 to -0.7 of the outward normal). */
  const sidewaysWeight = process.env.SHADE_REGRESS_GUARD === "unsigned"
    ? (s) => Math.max(0, Math.min(1, (0.7 - Math.abs(s)) / 0.35)) // the reverted first attempt's guard, for testing the checks only
    : (s) => (!behind ? 1 : Math.max(0, Math.min(1, (s + 0.7) / 0.35)));
  if (process.env.SHADE_REGRESS_GUARD === "unsigned") run.warn("SHADE_REGRESS_GUARD=unsigned: rebuilding the reverted first Maxima attempt's UNSIGNED guard, to test the checks");

  // ---- report -------------------------------------------------------------------
  const byPart = new Map();
  for (const tg of targets) { if (!byPart.has(tg.part)) byPart.set(tg.part, []); byPart.get(tg.part).push(tg); }
  const partTable = (aoMap) => {
    run.log("parts of " + materialName + (seamArg ? " (distance from each vertex to the nearest other listed part, mm)" : "") + ":");
    for (const [part, list] of byPart) {
      const count = list.reduce((s, t) => s + t.count, 0);
      let line = "  " + (seamParts(part) ? "SEAMS " : "      ") + (auto.listed.has(part) ? "AUTO " : "     ") + "verts=" + String(count).padStart(6);
      if (seamArg && seamParts(part)) {
        const ds = [];
        for (const tg of list) for (const d of seamOf.get(tg)) if (d < Infinity) ds.push(d * mmPerUnit);
        ds.sort((a, b) => a - b);
        const pc = (q) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(q * ds.length))].toFixed(1) : "-");
        line += "  near=" + String(ds.length).padStart(6) + "  p5 " + pc(0.05) + "  p25 " + pc(0.25) + "  p50 " + pc(0.5);
      }
      if (aoMap.size) {
        let s = 0, n = 0;
        for (const tg of list) for (const a of aoMap.get(tg)) { s += a; n++; }
        line += "  meanAO " + (s / n).toFixed(2);
      }
      run.log(line + "  " + part);
    }
    run.log("auto seam parts (--seams auto):");
    for (const r of auto.rows) run.log("  " + (auto.listed.has(r.name) ? "AUTO  " : "      ") + (100 * r.pct).toFixed(2).padStart(6) + "%  " + r.name + "  (" + r.why + ")");
    run.summary.autoParts = [...auto.listed];
  };
  if (flags.report && !useSeed) partTable(aoOf);

  // ---- shade ----------------------------------------------------------------------
  /* shade = ao * seam per vertex, for one set of settings: the flags' (one
     pass), or each seeded variant's. P = { curve, seamCoarseMm, aoOf }. */
  const longestOf = new Map();
  /* The longest edge touching each vertex: a vertex colour spreads across its
     triangles, so on a coarse patch a seam's dark vertex paints a blob (a
     "dent" at the rear bumper corner). --seam-coarse fades it out there. */
  const longestEdges = (tg) => {
    if (longestOf.has(tg)) return longestOf.get(tg);
    const longest = new Float32Array(tg.count);
    for (const t of tg.tris) for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const l = Math.hypot(tg.pos[a * 3] - tg.pos[b * 3], tg.pos[a * 3 + 1] - tg.pos[b * 3 + 1], tg.pos[a * 3 + 2] - tg.pos[b * 3 + 2]);
      if (l > longest[a]) longest[a] = l;
      if (l > longest[b]) longest[b] = l;
    }
    longestOf.set(tg, longest);
    return longest;
  };
  const shadePass = (P) => {
    const seamCoarse = P.seamCoarseMm / mmPerUnit;
    let dark = 0, total = 0, seamDarkenedBehind = 0, seamDarkened = 0;
    const rgbOf = new Map(), shadeOf = new Map(), aoShadeOf = new Map();
    for (const tg of targets) {
      const ao = P.aoOf.get(tg), seam = seamOf.get(tg), side = sideOf.get(tg);
      const longest = seam && seamCoarse > 0 ? longestEdges(tg) : null;
      const rgb = new Uint8Array(tg.count * 3);
      const shade = new Float32Array(tg.count), aoShade = new Float32Array(tg.count);
      for (let i = 0; i < tg.count; i++) {
        let sf = seam ? curveAt(P.curve, seam[i] * mmPerUnit) : 1;
        if (side) sf = 1 - (1 - sf) * sidewaysWeight(side[i]);
        if (longest && longest[i] > seamCoarse) sf = 1 - (1 - sf) * (seamCoarse / longest[i]);
        if (sf < 0.99) { seamDarkened++; if (side && side[i] < -0.35 && 1 - sf > 0.1) seamDarkenedBehind++; }
        const s = (ao ? ao[i] : 1) * sf;
        const b = Math.max(0, Math.min(255, Math.round(s * 255)));
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = b;
        shade[i] = b / 255;
        aoShade[i] = Math.max(0, Math.min(255, Math.round((ao ? ao[i] : 1) * 255))) / 255;
        if (b < 128) dark++;
        total++;
      }
      rgbOf.set(tg, rgb);
      shadeOf.set(tg, shade);
      aoShadeOf.set(tg, aoShade);
    }
    return { rgbOf, shadeOf, aoShadeOf, vertices: { total, belowHalf: dark, seamDarkened, seamDarkenedFromBehind: seamDarkenedBehind } };
  };

  // ---- self-checks ------------------------------------------------------------
  /* The shade as the GPU interpolates it across each triangle, the ao-only
     bake as the base (to tell the seams' specks from the AO's). The triangle
     list and the outward sides are built once; each variant only changes the
     shade read through them. */
  let ctris = null, ctri = null, worldTris = null;
  const checkGeometry = (signOf) => {
    if (ctris) return;
    ctris = []; ctri = [];
    for (const tg of targets) {
      const sign = signOf(tg);
      for (const [a, b, c] of tg.tris) {
        const corners = [a, b, c].map((i) => [tg.pos[i * 3], tg.pos[i * 3 + 1], tg.pos[i * 3 + 2]]);
        const normals = [a, b, c].map((i) => { const s = sign ? sign[i] : 1; return [tg.nrm[i * 3] * s, tg.nrm[i * 3 + 1] * s, tg.nrm[i * 3 + 2] * s]; });
        ctris.push({ corners, normals: normals.some((n) => n[0] || n[1] || n[2]) ? normals : null, part: tg.part });
        ctri.push([tg, a, b, c]);
      }
    }
    worldTris = new Float32Array(world);
    world.length = 0;
  };
  const interp = (map) => (i, u, w) => { const [tg, a, b, c] = ctri[i]; const s = map.get(tg); return (1 - u - w) * s[a] + u * s[b] + w * s[c]; };
  const pctS = (x) => (100 * x).toFixed(1) + "%";
  /* Measures one shade and makes the checks. C = { shadeOf, aoShadeOf (null
     when measuring the file's own bake), vertices (the shade pass's counts),
     listed, reachMm, aoOn, measureExisting }. Returns the metrics. */
  const checkPass = (C) => {
    const t0 = Date.now();
    const m = seamCheck({ tris: ctris, world: worldTris, listed: C.listed, mmPerUnit, reachMm: C.reachMm, shade: interp(C.shadeOf), base: C.measureExisting ? null : interp(C.aoShadeOf) });
    run.log((C.measureExisting ? "the bake in the file: " : flags.report ? "a bake with these flags would read: " : "bake: ") + "seams " + m.profiles + " (of " + m.anchors + " cells): doubled " + pctS(m.doubled4) + " / creased " + pctS(m.crease4) + " / no line " + pctS(m.flat) + " at a phone pixel; depth " + r3(m.depth4) + " (close-up " + r3(m.depth1) + "), width " + r3(m.width4) + " mm (close-up " + r3(m.width1) + " mm); panel " + r3(m.panel) + ", specks " + pctS(m.specks) + (m.specksBase !== null ? " (ao alone " + pctS(m.specksBase) + ")" : "") + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    run.log("  median seam profile at a phone pixel, 1 mm apart: " + m.medianProfile4.join(" "));
    /* A report on an unbaked car used to stop here, so the page's Check came
       back with no checks at all (the Optima: checks [], 6.7 s; the Maxima the
       same after 219 s). It now runs the checks a write would run, on the bake
       these flags would make: the same verdict, nothing written. */
    const hasSeams = (seamArg || C.measureExisting) && m.profiles > 0;
    if (hasSeams) {
      const minima = profileDips(m.medianProfile4);
      run.check("seam-single-line", m.doubled4 <= TARGETS.doubled4, pctS(m.doubled4) + " of " + m.profiles + " seams show two dips at a phone pixel (limit " + pctS(TARGETS.doubled4) + ")" + (m.doubledAt.length ? "; e.g. at " + JSON.stringify(m.doubledAt.slice(0, 3)) : ""));
      run.check("seam-profile-v", minima === 1, "the median seam profile at a phone pixel has " + minima + " dip(s): " + m.medianProfile4.join(" "));
      run.check("seam-no-crease", m.crease4 <= TARGETS.crease4, pctS(m.crease4) + " show a second dip beyond " + C.reachMm + " mm (limit " + pctS(TARGETS.crease4) + ")");
      const v = C.vertices;
      const hid = v.seamDarkened ? v.seamDarkenedFromBehind / v.seamDarkened : 0;
      if (!C.measureExisting) run.check("no-hidden-flange-lines", hid <= TARGETS.fromBehind, pctS(hid) + " of the seam-darkened vertices are darkened by a part under the skin (limit " + pctS(TARGETS.fromBehind) + ")");
      run.check("seam-depth", m.depth4 >= TARGETS.depth4[0] && m.depth4 <= TARGETS.depth4[1], "median depth " + r3(m.depth4) + " at a phone pixel (range " + TARGETS.depth4.join("-") + ")");
      run.check("seam-width", m.width1 <= TARGETS.width1, "median close-up width " + r3(m.width1) + " mm (limit " + TARGETS.width1 + ")");
    }
    if (C.aoOn || C.measureExisting) run.check("panel-tone", m.panel >= TARGETS.panel[0] && m.panel <= TARGETS.panel[1], "interior median shade " + r3(m.panel) + " (range " + TARGETS.panel.join("-") + ")");
    run.check("specks", m.specks <= TARGETS.specks, "interior samples darker than half the panel " + pctS(m.specks) + " (limit " + pctS(TARGETS.specks) + (m.specksBase !== null ? "; the ao alone " + pctS(m.specksBase) : "") + ")");
    return m;
  };

  /* What gets written, and the marker's settings: the flags' values, or the
     chosen variant's. */
  let settings = { aoDistanceMm, aoStrength, aoFloor, aoHiddenBelow, aoHiddenShade, curve: CURVE, seamCoarseMm };
  let variation = null;
  let total = 0, dark = 0;

  if (!useSeed) {
    const S = shadePass({ curve: CURVE, seamCoarseMm, aoOf });
    for (const tg of targets) tg.rgb = S.rgbOf.get(tg);
    total = S.vertices.total; dark = S.vertices.belowHalf;
    run.summary.vertices = S.vertices;
    /* --report on a car that is already baked measures the bake it HAS (the
       health check); otherwise the one these flags would make, if any. */
    const measureExisting = flags.report && colors.bake > 0;
    if (measureExisting) {
      let below = 0;
      for (const tg of targets) {
        const c = tg.prim.getAttribute("COLOR_0");
        const s = new Float32Array(tg.count);
        if (c && tg.kind === "bake") { const a = c.getArray(); for (let i = 0; i < tg.count; i++) s[i] = a[i * 3] / 255; } else s.fill(1);
        for (let i = 0; i < tg.count; i++) if (s[i] < 128 / 255) below++;
        S.shadeOf.set(tg, s);
      }
      run.summary.vertices = { total, belowHalf: below, inFile: true };
    }
    /* A report with nothing to measure: no bake in the file and no flags that
       would make one. Say so rather than list checks of an all-white shade. */
    if (flags.report && !measureExisting && !(aoDistance > 0) && !seamArg) {
      run.warn("nothing to measure: " + materialName + " carries no bake, and without --ao-distance or --seams there is no bake to preview");
      return run.finish(true);
    }
    /* Health of an existing bake: its own seams and curve from the marker (or
       every part and the shipped curve's reach when it has none). */
    const ms = measureExisting && !seamArg ? (marker && marker.settings) || {} : null;
    const checkListed = ms ? (ms.seams === "auto" ? (p) => auto.listed.has(p) : !ms.seams || ms.seams === "all" ? () => true : (p) => ms.seams.split(",").some((x) => p.includes(x))) : seamParts;
    const checkReach = ms ? (ms.curve ? ms.curve[ms.curve.length - 1][0] : 8) : seamArg ? REACH_MM : 8;
    checkGeometry(signFromAo);
    run.summary.checkMetrics = checkPass({ shadeOf: S.shadeOf, aoShadeOf: S.aoShadeOf, vertices: S.vertices, listed: checkListed, reachMm: checkReach, aoOn: aoDistance > 0, measureExisting });
    // --report: the checks are the verdict here, not a refusal (nothing is written).
    if (flags.report) {
      if (run.failed.length && !measureExisting) run.warn("checks failed (" + run.failed.map((c) => c.name).join(", ") + "): a write with these flags would refuse without --force");
      return run.finish(true);
    }
  } else {
    // ---- seeded variants (--seed) -----------------------------------------------
    /* The ranges, each bounded around the Maxima's shipped bake -- the Camry
       benchmark's calibration for a vertex colour (2050 mm, strength 1.0,
       hidden-below 0.25 at 0.8, no floor, curve 0:0.45,4:0.45,8:1, coarse
       20) -- so every variant is a plausible bake and the checks pick among
       them. A flag the caller gave is fixed; every draw is consumed either
       way (lib/variation.mjs), so a seed reads the same with or without it.
         aoDistanceMm  1600-3000  the Corolla read too light at 2 m (panel
                       0.88) and passed at 3 m (0.83); under ~1.6 m the AO
                       loses the body's broad shading. Drawn ONCE per run
                       (sticky): a new reach is a new trace (54 s on the
                       Maxima), so the retries vary the rest.
         aoStrength    0.85-1.10  eases or deepens the AO around the shipped 1.0
         aoHiddenBelow 0.15-0.35  which enclosed vertices count as hidden
         aoHiddenShade 0.70-0.90  and the grey they get (0.8 shipped; black
                       shows the hairline cracks as dotted lines)
         aoFloor       0.00-0.20  lifts only the darkest crevices
         seamCore      0.30-0.60  the factor at the gap (0.45 shipped, 0.55 the
                       first attempt; much under 0.3 reads as a cut on silver)
         seamCoreMm    2.5-5.5 mm how far the core holds (4 shipped)
         seamFallMm    2-6 mm     the ease back to 1 (4 shipped): reach
                       4.5-11.5 mm around the shipped 8, inside the 16 mm
                       width check (the shipped 8 mm reach measured 7.75 mm,
                       the first curve's 16 mm reach 22 mm)
         seamCoarseMm  14-40 mm   the coarse-edge fade (20 shipped; 40-80
                       deepens a low-poly car's line but trips the flange
                       check on the Sonata and the Elantra)
       --ao-rays, --ao-ground (on unless --no-ao-ground), --seams and
       --seam-behind are not varied: cost, physics and the guard. The checks
       below are the gate, unchanged. */
    const fx = (k) => (flags[k] !== undefined ? num(k, 0) : undefined);
    const CORE_MM = [2.5, 5.5], FALL_MM = [2, 6];
    const curveFixed = !!flags.curve;
    const drawParams = (draw) => {
      const P = {};
      P.aoDistanceMm = draw.uniform("aoDistanceMm", 1600, 3000, { step: 50, sticky: true, fixed: fx("ao-distance") });
      const aoOff = !(P.aoDistanceMm > 0);
      P.aoStrength = draw.uniform("aoStrength", 0.85, 1.1, { step: 0.01, fixed: fx("ao-strength"), unused: aoOff }) ?? aoStrength;
      P.aoHiddenBelow = draw.uniform("aoHiddenBelow", 0.15, 0.35, { step: 0.01, fixed: fx("ao-hidden-below"), unused: aoOff }) ?? aoHiddenBelow;
      P.aoHiddenShade = draw.uniform("aoHiddenShade", 0.7, 0.9, { step: 0.01, fixed: fx("ao-hidden-shade"), unused: aoOff }) ?? aoHiddenShade;
      P.aoFloor = draw.uniform("aoFloor", 0, 0.2, { step: 0.01, fixed: fx("ao-floor"), unused: aoOff }) ?? aoFloor;
      const noCurve = !seamArg || curveFixed;
      const core = draw.uniform("seamCore", 0.3, 0.6, { step: 0.01, unused: noCurve });
      const coreMm = draw.uniform("seamCoreMm", CORE_MM[0], CORE_MM[1], { step: 0.5, unused: noCurve });
      const fallMm = draw.uniform("seamFallMm", FALL_MM[0], FALL_MM[1], { step: 0.5, unused: noCurve });
      P.seamCoarseMm = draw.uniform("seamCoarseMm", 14, 40, { step: 1, fixed: fx("seam-coarse"), unused: !seamArg }) ?? seamCoarseMm;
      P.curve = curveFixed || !seamArg ? CURVE : [[0, core], [coreMm, core], [+(coreMm + fallMm).toFixed(1), 1]];
      if (seamArg) {
        draw.params.curve = P.curve.map((p) => p.join(":")).join(",");
        if (curveFixed) draw.fixed.push("curve");
      }
      P.reachMm = P.curve[P.curve.length - 1][0];
      return P;
    };
    const maxReachMm = curveFixed ? REACH_MM : CORE_MM[1] + FALL_MM[1];
    let rawAo = null, rawAoMm = null, aoSeconds = null, seamsDone = false;
    const signFromRaw = (tg) => { const a = rawAo && rawAo.get(tg); return a && a.sign ? a.sign : null; };
    run.log("--seed " + seed + ": up to " + tries + " variant" + (tries === 1 ? "" : "s") + ", the first that passes every check is " + (flags.report ? "reported" : "written"));
    const res = await runVariants({
      seed, tries, label: "variant", log: (s) => run.log(s),
      attempt: async (draw, info) => {
        const P = drawParams(draw);
        const aoOn = P.aoDistanceMm > 0;
        if (aoOn && rawAoMm !== P.aoDistanceMm) {
          const { res: traced, seconds } = await traceAo(P.aoDistanceMm, true);
          rawAo = new Map();
          targets.forEach((tg, i) => { const a = traced[i].ao; a.sign = traced[i].sign; rawAo.set(tg, a); });
          rawAoMm = P.aoDistanceMm; aoSeconds = seconds;
        }
        if (seamArg && !seamsDone) { seamPass(flags.report ? 40 : maxReachMm, signFromRaw); seamsDone = true; }
        const aoMap = new Map();
        if (aoOn) for (const tg of targets) {
          const a = rawAo.get(tg), out = new Float32Array(tg.count);
          for (let i = 0; i < tg.count; i++) out[i] = aoShade(a[i], { strength: P.aoStrength, floor: P.aoFloor, hiddenBelow: P.aoHiddenBelow, hiddenShade: P.aoHiddenShade });
          out.sign = a.sign;
          aoMap.set(tg, out);
        }
        const S = shadePass({ curve: P.curve, seamCoarseMm: P.seamCoarseMm, aoOf: aoMap });
        // Same colours as an earlier variant: the same file, so draw again.
        const dup = info.duplicateOf(fingerprint(...targets.map((tg) => S.rgbOf.get(tg))));
        if (dup) return { duplicate: dup };
        checkGeometry(signFromRaw);
        const held = await run.collect(() => checkPass({ shadeOf: S.shadeOf, aoShadeOf: S.aoShadeOf, vertices: S.vertices, listed: seamParts, reachMm: seamArg ? P.reachMm : 8, aoOn, measureExisting: false }));
        return { failed: held.failed, P, S, held, aoMap };
      },
    });
    const pick = res.chosen || res.closest;
    variation = res.summary;
    run.summary.variation = variation;
    if (!pick) return run.finish(false, noVariantMessage(res, seed, tries), 3);
    const { P, S, held, aoMap } = pick.result;
    if (flags.report) partTable(aoMap);
    run.replay(held);
    run.summary.checkMetrics = held.value;
    run.summary.vertices = S.vertices;
    total = S.vertices.total; dark = S.vertices.belowHalf;
    for (const tg of targets) tg.rgb = S.rgbOf.get(tg);
    settings = { aoDistanceMm: P.aoDistanceMm, aoStrength: P.aoStrength, aoFloor: P.aoFloor, aoHiddenBelow: P.aoHiddenBelow, aoHiddenShade: P.aoHiddenShade, curve: P.curve, seamCoarseMm: P.seamCoarseMm };
    if (P.aoDistanceMm > 0) run.summary.ao = { distanceMm: P.aoDistanceMm, rays: aoRays, ground: aoGround, strength: P.aoStrength, floor: P.aoFloor, hiddenBelow: P.aoHiddenBelow, hiddenShade: P.aoHiddenShade, threads, seconds: aoSeconds };
    if (run.summary.seams) Object.assign(run.summary.seams, { curve: P.curve, reachMm: P.reachMm, seamCoarseMm: P.seamCoarseMm });
    run.log("variant " + (res.chosen ? pick.k + " of " + tries + " passed" : "none passed; the closest is " + pick.k) + " (seed " + seed + (pick.k > 1 ? ", sub-seed " + pick.subSeed : "") + ")");
    if (!res.chosen) {
      if (flags.report || !flags.force) return run.finish(false, noVariantMessage(res, seed, tries), 3);
      run.warn("no variant passed (seed " + seed + "); writing the closest, attempt " + pick.k + " (--force)");
    }
    if (flags.report) return run.finish(true);
  }

  // ---- write ----------------------------------------------------------------------
  if (run.failed.length && !flags.force) return run.finish(false, "checks failed (" + run.failed.map((c) => c.name).join(", ") + "); nothing written. Pass --force to write anyway.", 3);
  if (run.failed.length) run.warn("writing despite failed checks (--force): " + run.failed.map((c) => c.name).join(", "));
  const buffer = root.listBuffers()[0];
  for (const tg of targets) {
    const old = tg.prim.getAttribute("COLOR_0");
    const acc = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(tg.rgb).setNormalized(true).setBuffer(buffer);
    tg.prim.setAttribute("COLOR_0", acc);
    // A replaced colour (a forced re-bake, a dropped foreign one) must not ride
    // along in the buffer as dead weight.
    if (old && old.listParents().every((p) => p.propertyType === "Root")) old.dispose();
  }
  /* The marker: what this bake is, so a later run can tell it is shaded and
     what with. A seeded bake also records the seed and the variant, which
     reproduce it (--seed N, the same input and flags). */
  mat.setExtras({ ...extras, vertexShading: {
    version: MARKER_VERSION, date: new Date().toISOString().slice(0, 10),
    settings: { mmPerUnit: r3(mmPerUnit), aoDistanceMm: settings.aoDistanceMm, aoRays, aoGround, aoStrength: settings.aoStrength, aoFloor: settings.aoFloor, aoHiddenBelow: settings.aoHiddenBelow, aoHiddenShade: settings.aoHiddenShade, seams: seamArg ? seamArg.join(",") : null, curve: seamArg ? settings.curve : null, seamCoarseMm: settings.seamCoarseMm, seamBehind: behind },
    ...(variation ? { variation: { seed: variation.seed, attempt: variation.attempt, subSeed: variation.subSeed, params: variation.params } } : {}),
    ...(marker ? { previous: { date: marker.date } } : {}),
  } });
  await writeGlb(io, doc, outPath);
  run.output = outPath;
  run.log("wrote " + outPath + ": COLOR_0 on " + targets.length + " primitives, " + total + " vertices (" + dark + " below half brightness)" + (draco ? ", Draco re-encoded at the recipe's bits" : ""));
  return run.finish(true);
});
