#!/usr/bin/env node
/* cabin-black: make a car's cabin fully black except the driver's seat, by
   moving every cabin triangle into ONE new flat material, Interior_Black,
   with the page's interior recipe baked in (CAR_LOOK_PROFILE.interior in
   visual-search-standalone/index.html: base colour [0.065, 0.065, 0.069],
   metallic 0, roughness 0.8, emissive [0.0078, 0.0078, 0.0085], no
   textures). The seat, the glass, the paint, the lamps and everything
   outside the cabin keep their own materials, untouched.

   Why a file edit and not just the page's look profile: the profile paints
   whole MATERIALS black (look.interior), and Sketchfab exports do not keep
   the cabin in materials of its own. The Camry's Index_0_1 atlas holds the
   dash AND the wheels and lamps; the Elantra's black.009 the door cards'
   frames AND the bumpers and the chassis; the Maxima's black.002 the door
   panels AND the sills. Painting such a material black at runtime would
   blacken its exterior half too, and leaving it off leaves half the cabin
   in the export's tan or grey. So the cabin's triangles are cut out of
   whatever material they are in and given their own, the way seat-split
   cuts the seat.

   WHICH triangles: the ones that face the cabin's AIR (lib/cabin-find.mjs).
   The car is voxelised at L/300 (~1.6 cm), every surface solid, glass
   included; the free space a ~5 cm ball can reach from outside is outside
   air, and the enclosed space under the car's canopy (the glass and the
   roof, so not the engine bay or the boot) that holds the air over the
   driver's seat is the cabin. Each triangle then looks along its normal,
   both ways, for the nearest air. Decided per SHELL (connected pieces
   welded by position inside one primitive, lib/seat-scene.mjs, as
   seat-split does), so a door card goes whole while the door skin it is
   bolted to -- facing the street -- stays:
     a shell whose surface mostly faces cabin air goes black: of the area
       that faces any air, (cabin + half of "both") / exposed >= 0.6. A
       straddling piece -- the cowl panel under the windscreen, the door
       card's top rail, the parcel shelf against the rear screen -- goes
       when 60% of it is inside;
     a HIDDEN shell (less than a quarter of it faces any air: a bracket in
       the dash, a seat's inner layers) goes when 90% of it lies within 8
       voxels (~13 cm) of the cabin air -- inside the cabin's envelope;
     and nothing seen straight on from outside goes, whatever the above
       says (lib/cabin-view.mjs: drawn from 28 views around the car, a
       piece with more than 3% of its visible pixels -- and more than 40 --
       seen with no glass in front of it is outside). Parts seen THROUGH a
       window are cabin, and go black.
   Always excluded, whatever their position:
     the seat     --seat a,b, or every material named Driver_Seat...; none
                  in the file is a warning ("cut the seat first (Seat
                  tab)"): the run still blackens the cabin, seat and all;
     glass        alphaMode BLEND, KHR_materials_transmission, alpha below
                  0.5 (the Camry's invisible Outline_* shells, the Corolla's
                  e180_glass) or a glass/window name (the Sonata's OPAQUE
                  midsize_glass, which the page turns into glass);
     paint        --paint a,b (the lab passes look.paint), else detected:
                  every material NAMED as paint or body (Paint_Color,
                  carpaint, PAINT, B_Paint, e180body, body...), or, when
                  none is, the material seen most from around the car (the
                  Optima's Sparkling Silver, the Sportage's Wolf_Gray) --
                  summary.paintHow says which;
     lights       emissive (any channel >= 0.1, or an emissive map) or named
                  light / lamp / lens / DRL;
     --keep a,b   anything you say.
   The output material is ONE material, --name (default Interior_Black),
   doubleSided when any material it took triangles from was. Primitives are
   split as needed (the moved triangles get a new primitive on the same mesh
   sharing the vertex data; a primitive moved whole just changes material),
   materials left with no geometry are removed, and their textures with
   them when nothing else uses them. Image bytes are never re-encoded
   (gltf-transform copies them), and the file is re-saved through
   lib/gltf-io.mjs writeGlb, Draco at the recipe's bits. A re-run adds to an
   existing Interior_Black; finding nothing left to move is ok:false "nothing
   to do" and writes nothing.

   CHECKS (each failing one refuses the write unless --force):
     seat-untouched     the seat materials' triangles are exactly as before
     glass-untouched    ...the glass's
     paint-untouched    ...the paint's
     lights-untouched   ...the lights'
     inside-cabin       every moved triangle lies within 12 voxels (~20 cm)
                        of the cabin's air: the cabin plus its walls, never
                        the engine bay, a wheel or a bumper
     cabin-covered      of the cabin seen through the windows (the 28 views'
                        through-glass pixels, the seat aside), at least 80%
                        is black after the run; the biggest leftovers are
                        named, with why they stayed
     exterior-unchanged nothing seen straight on from outside moved: at most
                        0.5% of the moved surface's outside-visible pixels
                        (stray pixels through panel gaps)
   The thresholds were calibrated on the nine cabins the page shows (Camry,
   Optima, Sentra, Altima, Maxima, Corolla, Sonata, Elantra, Sportage 2021);
   the numbers each car gave are in the round-4 report.

   --seed n [--tries k]: a variant of the classification (lib/cabin-vary.mjs
   on lib/variation.mjs, the PRNG and sub-seeds the other tools share): the
   straddling threshold, the hidden-shell envelope, and whether the dash
   top, the A-pillar trims, the door-card tops and the parcel shelf count.
   Never the exclusions, never the checks. Attempt 1 draws from n, attempt
   j from a sub-seed, up to k (default 8, max 20); an attempt that moves
   the same triangles as the calibrated run or an earlier attempt is a
   duplicate and the next is drawn. The same n, input and flags give the
   same bytes. LAB_JSON summary.variation = {seed, attempt, subSeed, tries,
   params, ranges, fixed, rejected, label}. Without --seed the result is
   deterministic.

   A SKINNED export is refused (see lib/shade-cli.mjs isSkinned): run Export
   fixes --unskin first.

   Usage:
     node tools/cabin-black.mjs <in.glb> <out.glb> [--name Interior_Black] [--seat a,b] [--paint a,b] [--keep a,b] [--seed n [--tries k]] [--force] [--json]
     node tools/cabin-black.mjs <in.glb> --report [same flags]     preview: classify + checks, writes nothing
   Strict flags (an unknown one, or one missing its value, is a usage
   error: exit 2 with the LAB_JSON line). With --json the last stdout line
   is `LAB_JSON {ok, tool, input, output, bytesIn, bytesOut, summary,
   checks, warnings, error}`; summary = { material, triangles, shells,
   movedFrom: [{name, tris, ofTris, whole}], seat: [names], seatTris,
   skipped: {glass, paint, lights, keep: {materials, tris}, outside:
   {shells, tris}}, leftovers: [{name, tris, why}], cabin: {min, max},
   paintHow, removed, texturesDropped, frame, coverage, variation }.

   Order with the seat: seat first, then cabin. seat-split finds the seat by
   its material, and once the cabin is one Interior_Black the seat's own
   material is the only thing that still tells it apart. */
import { Accessor } from "@gltf-transform/core";
import { createIO, writeGlb, fileSize } from "./lib/gltf-io.mjs";
import { parseArgs, runTool, UsageError, isSkinned, SKINNED_ERROR } from "./lib/shade-cli.mjs";
import { buildScene } from "./lib/seat-scene.mjs";
import { seatFacing } from "./lib/seat-find.mjs";
import { parseSeed, parseTries, runVariants, fingerprint, noVariantMessage } from "./lib/variation.mjs";
import * as CF from "./lib/cabin-find.mjs";
import { visibility } from "./lib/cabin-view.mjs";
import { CALIBRATED, RANGES, ZONES, drawCabinParams, describeCabin } from "./lib/cabin-vary.mjs";
import { basename } from "node:path";

const TOOL = "cabin-black";
const USAGE = "usage: cabin-black <in.glb> <out.glb> [--name Interior_Black] [--seat a,b] [--paint a,b] [--keep a,b] [--seed n [--tries k]] [--force] [--json]\n" +
  "       cabin-black <in.glb> --report [--name ..] [--seat a,b] [--paint a,b] [--keep a,b] [--seed n [--tries k]] [--json]   (classify + checks, writes nothing)";
const SPEC = { bool: ["report", "force", "json"], value: ["name", "seat", "paint", "keep", "seed", "tries"] };

/* The page's interior recipe (CAR_LOOK_PROFILE.interior), baked into the
   new material so the cabin is black even before the look adds it. */
const RECIPE = { baseColorFactor: [0.065, 0.065, 0.069, 1], metallicFactor: 0, roughnessFactor: 0.8, emissiveFactor: [0.0078, 0.0078, 0.0085] };

/* Calibrated constants (see the header; measured on the nine cars). */
const AIR = { res: 300, probe: 3, gap: 6, canopy: { roofLine: 0.82, close: 6, margin: 3 } };
const SEEN_MIN = 30;              // pixels: a shell seen from around the car is judged by what is seen of it
const VIS_OFFSET = 0.15;         // ...and goes when (straddle + this) of it is seen through glass (0.75)
const VIS_ENV = 0.5;             // ...and half of it lies within the envelope
const HIDDEN_EXPOSED = 0.25;     // unseen, and below this share facing any air: "hidden"
const HIDDEN_ENV = 0.9;          // ...goes when this share lies within the envelope
const MIN_ENV = 0.85;            // unseen but facing air: goes when inside >= straddle and 85% within the envelope
const ZONE_IN_SHARE = 0.3;       // a zone forced "in" takes unseen pieces at least this inside
const INSIDE_LIMIT = 20;         // inside-cabin: voxels from the cabin air
const COVER_MIN = 0.8;           // cabin-covered
const EXTERIOR_SHELL = 0.5, EXTERIOR_PX = 40, EXTERIOR_MAX = 0.02;   // exterior-unchanged

const base = (p) => (p ? basename(String(p)) : String(p));
const list = (s, flag) => {
  if (s === undefined) return null;
  const v = String(s).split(",").map((x) => x.trim()).filter(Boolean);
  if (!v.length) throw new UsageError("--" + flag + " wants material names: a,b");
  return v;
};
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const seatLike = (n) => /^driver[ _-]?seat/i.test(n || "");
const ROLE_WORD = { glass: "glass", paint: "paint", light: "a light", keep: "--keep", seat: "the seat" };
/* A classify() reason without its numbers, for grouping leftovers. */
const whyWord = (w) => !w ? "left" : /^seen straight/.test(w) ? "seen straight on from outside" : /^hidden, faces/.test(w) ? "hidden, faces outside air" : /^hidden/.test(w) ? "hidden, outside the envelope" : /^straddles/.test(w) ? "straddles, mostly outside" : /within the envelope/.test(w) ? "outside the envelope" : w;

await runTool(TOOL, USAGE, async (run) => {
  const { flags, positional } = parseArgs(process.argv.slice(2), SPEC);
  if (positional.length > 2) throw new UsageError("too many paths (" + positional.join(" ") + ")");
  const [inPath, outPath0] = positional;
  if (!inPath || (!flags.report && !outPath0)) throw new UsageError("give <in.glb> and either <out.glb> or --report");
  const report = !!flags.report;
  const outPath = report ? null : outPath0;
  if (report && outPath0) run.warn("--report writes nothing: " + base(outPath0) + " was ignored");
  const name = flags.name !== undefined ? String(flags.name).trim() : "Interior_Black";
  if (!name) throw new UsageError("--name wants a material name");
  const seatNames = list(flags.seat, "seat"), paintNames = list(flags.paint, "paint"), keepNames = list(flags.keep, "keep");
  const seeded = flags.seed !== undefined;
  if (flags.tries !== undefined && !seeded) throw new UsageError("--tries goes with --seed");
  const seed = seeded ? parseSeed(flags.seed, UsageError) : null;
  const tries = seeded ? parseTries(flags.tries, UsageError) : 1;
  run.input = inPath;
  run.bytesIn = fileSize(inPath);
  const t0 = Date.now();

  const io = await createIO();
  let doc;
  try { doc = await io.read(inPath); } catch (e) { return run.finish(false, "cannot read " + base(inPath) + ": " + e.message); }
  if (isSkinned(doc)) return run.finish(false, SKINNED_ERROR);
  const root = doc.getRoot();
  const mats = root.listMaterials();
  const byName = new Map();
  for (const m of mats) { const n = m.getName() || ""; if (!byName.has(n)) byName.set(n, []); byName.get(n).push(m); }
  const missing = (names) => names.filter((n) => !byName.has(n));

  // ---- material roles -----------------------------------------------------------
  /* One role per material, the first that applies: the output material
     itself (a re-run), the seat, --keep, glass, lights, paint. */
  const role = new Map(); // Material -> { role, why }
  const set = (m, r, why) => { if (!role.has(m)) role.set(m, { role: r, why }); };
  const targets = byName.get(name) || [];
  if (targets.length > 1) return run.finish(false, targets.length + " materials are named " + name + ": merge them by hand first");
  let target = targets[0] || null;
  for (const m of targets) set(m, "target", "the cabin material (a re-run adds to it)");
  // The seat.
  let seatMats;
  if (seatNames) {
    const miss = missing(seatNames);
    if (miss.length) return run.finish(false, "--seat names no material in this file: " + miss.join(", ") + " (seat-like: " + (mats.filter((m) => seatLike(m.getName())).map((m) => m.getName()).join(", ") || "none") + ")");
    seatMats = seatNames.flatMap((n) => byName.get(n));
  } else seatMats = mats.filter((m) => seatLike(m.getName()));
  for (const m of seatMats) set(m, "seat", seatNames ? "--seat" : "a Driver_Seat material");
  if (!seatMats.length) run.warn("no driver's seat material in the file: cut the seat first (Seat tab) -- this run blackens the whole cabin, seat and all");
  if (keepNames) {
    const miss = missing(keepNames);
    if (miss.length) return run.finish(false, "--keep names no material in this file: " + miss.join(", "));
    for (const n of keepNames) for (const m of byName.get(n)) set(m, "keep", "--keep");
  }
  // Glass, and what the outward views do with it.
  const ext = (m, n) => m.listExtensions().find((e) => e.extensionName === n);
  const glassWhy = (m) => {
    const n = m.getName() || "", a = m.getBaseColorFactor()[3];
    if (m.getAlphaMode() === "BLEND") return "alphaMode BLEND";
    const tr = ext(m, "KHR_materials_transmission");
    if (tr && tr.getTransmissionFactor() > 0) return "transmission";
    if (a < 0.5) return a < 0.05 ? "invisible (alpha " + a.toFixed(2) + ")" : "alpha " + a.toFixed(2);
    if (/glass|window|windscreen|windshield/i.test(n)) return "named glass";
    return null;
  };
  for (const m of mats) { const w = glassWhy(m); if (w) set(m, "glass", w); }
  // Lights.
  for (const m of mats) {
    const e = m.getEmissiveFactor();
    if (Math.max(...e) >= 0.1 || m.getEmissiveTexture()) set(m, "light", "emissive");
    else if (/light|lamp|lens|drl/i.test(m.getName() || "")) set(m, "light", "named a light");
  }
  // Paint (detected after the views, when not given).
  let paintHow;
  if (paintNames) {
    const miss = missing(paintNames), found = paintNames.filter((n) => byName.has(n));
    if (miss.length) run.warn("--paint names no material in this file: " + miss.join(", ") + (found.length ? "" : " -- detecting the paint instead"));
    for (const n of found) for (const m of byName.get(n)) set(m, "paint", "--paint");
    paintHow = found.length ? "--paint " + found.join(", ") : null;
  }

  // ---- scene ------------------------------------------------------------------------
  const scene = buildScene(doc);
  const F = scene.frame, S = scene.shells, T = scene.T;
  const tScene = Date.now();
  run.summary.frame = { up: "xyz"[F.up], length: "xyz"[F.len], width: "xyz"[F.wid], L: +F.L.toPrecision(5), W: +F.W.toPrecision(5), H: +F.H.toPrecision(5) };
  const visitRole = scene.visits.map((v) => { const m = v.prim.getMaterial(); return m && role.has(m) ? role.get(m).role : null; });
  const invisible = (m) => m && m.getBaseColorFactor()[3] < 0.05 && m.getAlphaMode() !== "OPAQUE";
  /* Glass, per shell, for the views and the canopy: a WINDOW is see-through
     glass that reaches the roof line (top above 0.8 H: windscreen, side and
     rear windows, sunroof); lower glass is a lamp lens, drawn as nothing
     (what is behind it is outside); an invisible material is not drawn; a
     material named glass but OPAQUE, full alpha and named black (the
     Sentra's black_glass, the frit band) is drawn like paint. */
  const glassVisit = new Uint8Array(scene.visits.length);
  const shellKind = new Uint8Array(S.n);
  scene.visits.forEach((v, i) => { if (visitRole[i] === "glass") glassVisit[i] = 1; });
  for (let s = 0; s < S.n; s++) {
    const vi = S.visit[s], m = scene.visits[vi].prim.getMaterial();
    if (!m) continue;
    if (invisible(m)) { shellKind[s] = 2; continue; }
    if (visitRole[vi] !== "glass" || (/black/i.test(m.getName() || "") && m.getAlphaMode() === "OPAQUE" && m.getBaseColorFactor()[3] >= 0.95)) continue;
    shellKind[s] = (S.max[s * 3 + F.up] - F.ground) / F.H >= 0.8 ? 1 : 2;
  }

  /* Already near-black: a flat dark material (no base colour map, every
     channel at most 0.12 -- the interior recipe is 0.065) that is not the
     paint (the page repaints the paint: the Maxima's "body" is 0.02 in the
     file and silver on the page). cabin-covered counts what such a material
     shows through the windows as black: the Elantra's floor pan is one
     black.009 shell with the underbody, which stays where it is. */
  const darkMat = (m) => !!m && !m.getBaseColorTexture() && Math.max(...m.getBaseColorFactor().slice(0, 3)) <= 0.12;
  const darkVisit = new Uint8Array(scene.visits.length);

  // What is seen from around the car, straight on or through a window.
  const vis = visibility(scene, { shellKind });
  const tVis = Date.now();
  if (!paintHow) {
    /* The body paint is what covers the car seen from around it. By the
       views: the material with the most pixels seen straight on, when that
       is at least 15% of them and almost all of it is seen straight on (an
       atlas that also holds the cabin, like the Camry's Index_0_1, is seen
       through the windows too). Plus every material NAMED paint or body that
       covers at least 3% of the outside: a second paint (the Altima's
       black_paint roof and pillars, the Sentra's B_Paint). A name alone is
       not enough: the Sportage's "paint_glossy_tertiary_brakes" is its
       brake callipers and the Sonata's "forza_underbody" its underbody. */
    const px = new Map(), seenPx = new Map();
    let all = 0;
    for (let t = 0; t < T; t++) {
      const d = vis.direct[t], g = vis.viaGlass[t];
      if (!d && !g) continue;
      all += d;
      const m = scene.visits[scene.triVisit[t]].prim.getMaterial();
      if (!m || role.has(m)) continue;
      px.set(m, (px.get(m) || 0) + d);
      seenPx.set(m, (seenPx.get(m) || 0) + d + g);
    }
    const ranked = [...px].sort((a, b) => b[1] - a[1]);
    const found = [];
    const top = ranked[0];
    if (top && top[1] >= 0.15 * all && top[1] >= 0.9 * seenPx.get(top[0])) found.push([top[0], "seen most from outside, " + pct(top[1] / all, 0) + " of it"]);
    for (const [m, n] of ranked) {
      if (found.some((f) => f[0] === m) || !/paint|(^|[^a-z])body([^a-z]|$)|body$/i.test(m.getName() || "")) continue;
      if (n >= 0.03 * all && n >= 0.9 * seenPx.get(m)) found.push([m, "named, " + pct(n / all, 0) + " of the outside"]);
    }
    for (const [m, why] of found) set(m, "paint", why);
    if (found.length) paintHow = "detected: " + found.map(([m, why]) => m.getName() + " (" + why + ")").join(", ");
    else { paintHow = "none found (nothing named paint or body covers 3% of the outside, and nothing covers 15%)"; run.warn("no paint material found: pass --paint"); }
  }
  for (let i = 0; i < scene.visits.length; i++) { const m = scene.visits[i].prim.getMaterial(); visitRole[i] = m && role.has(m) ? role.get(m).role : null; }
  run.summary.paintHow = paintHow;
  scene.visits.forEach((v, i) => { darkVisit[i] = visitRole[i] !== "paint" && darkMat(v.prim.getMaterial()) ? 1 : 0; });
  const namesOf = (r) => [...new Set(mats.filter((m) => role.has(m) && role.get(m).role === r).map((m) => m.getName()))];
  run.log("roles: seat " + (namesOf("seat").join(", ") || "none") + "; paint " + (namesOf("paint").join(", ") || "none") + " (" + paintHow + "); glass " + namesOf("glass").length + "; lights " + namesOf("light").length + "; keep " + (namesOf("keep").join(", ") || "none") + (target ? "; already black: " + name : ""));

  // ---- the cabin's air ----------------------------------------------------------------
  let seatBox = null;
  for (let t = 0; t < T; t++) {
    if (visitRole[scene.triVisit[t]] !== "seat") continue;
    seatBox = seatBox || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let k = 0; k < 3; k++) { const c = scene.cen[t * 3 + k]; if (c < seatBox.min[k]) seatBox.min[k] = c; if (c > seatBox.max[k]) seatBox.max[k] = c; }
  }
  const air = CF.analyseAir(scene, { ...AIR, seat: seatBox, glassVisit });
  if (air.fail) return run.finish(false, air.fail);
  const faces = CF.triangleFaces(scene, air.g, air.dcab);
  const sf = CF.shellFaces(scene, faces);
  const tAir = Date.now();
  const cb = air.cabin.box;
  run.summary.cabin = { min: cb.min.map((x) => +x.toPrecision(6)), max: cb.max.map((x) => +x.toPrecision(6)) };
  const relLen = (x) => (x - F.lo[F.len]) / F.L, relUp = (x) => (x - F.ground) / F.H, relW = (x) => (x - F.mid) / F.W;
  run.log(`cabin air: ${air.cabin.voxels} voxels of ${air.g.v.toPrecision(3)} (L/${AIR.res}); length ${relLen(cb.min[F.len]).toFixed(2)}-${relLen(cb.max[F.len]).toFixed(2)} L, width ${relW(cb.min[F.wid]).toFixed(2)}..${relW(cb.max[F.wid]).toFixed(2)} W, height ${relUp(cb.min[F.up]).toFixed(2)}-${relUp(cb.max[F.up]).toFixed(2)} H; canopy over ${relLen(air.canopy.len[0]).toFixed(2)}-${relLen(air.canopy.len[1]).toFixed(2)} L from ${air.canopy.glassShells} glass shell(s)`);

  // ---- per shell: what it faces, what is seen of it, its zone --------------------------
  const shDirect = new Float64Array(S.n), shVia = new Float64Array(S.n);
  for (let t = 0; t < T; t++) { const s = scene.shellOf[t]; shDirect[s] += vis.direct[t]; shVia[s] += vis.viaGlass[t]; }
  // The car's front, for the zones: the seat faces it (backrest behind the
  // cushion); without a seat, the windscreen end is the one whose canopy
  // glass reaches lowest... not needed: zones then use both ends.
  let front = 0;
  if (seatBox) {
    const st = [];
    for (let t = 0; t < T; t++) if (visitRole[scene.triVisit[t]] === "seat") st.push(t);
    const fc = seatFacing(scene, st);
    if (fc.sign && fc.strength >= 0.12) front = fc.sign;
  }
  const zoneOf = new Int8Array(S.n).fill(-1);
  {
    const c0 = cb.min[F.len], c1 = cb.max[F.len], span = c1 - c0 || 1;
    const za = new Float64Array(ZONES.length);
    for (let s = 0; s < S.n; s++) {
      za.fill(0);
      for (let j = S.start[s]; j < S.start[s + 1]; j++) {
        const t = S.tris[j];
        const ql = (scene.cen[t * 3 + F.len] - c0) / span;
        const qs = front > 0 ? [ql] : front < 0 ? [1 - ql] : [ql, 1 - ql];
        const h = relUp(scene.cen[t * 3 + F.up]), w = Math.abs(relW(scene.cen[t * 3 + F.wid]));
        const a = scene.area[t];
        for (const q of qs) {
          if (q >= 0.75 && h >= 0.5 && w <= 0.36) { za[0] += a; break; }
        }
        for (const q of qs) if (q >= 0.6 && h >= 0.58 && w >= 0.3) { za[1] += a; break; }
        for (const q of qs) if (q >= 0.15 && q <= 0.85 && h >= 0.48 && h <= 0.72 && w >= 0.33) { za[2] += a; break; }
        for (const q of qs) if (q <= 0.25 && h >= 0.5 && h <= 0.85 && w <= 0.36) { za[3] += a; break; }
      }
      // Door tops first (a rail at the window line also sits where the
      // A-pillar zone starts), then the A-pillar, the dash, the shelf.
      for (const z of [2, 1, 0, 3]) if (za[z] >= 0.6 * sf.area[s]) { zoneOf[s] = z; break; }
    }
  }
  const eligible = new Uint8Array(S.n);
  for (let s = 0; s < S.n; s++) eligible[s] = visitRole[S.visit[s]] === null ? 1 : 0;

  /* The classification: P = the calibrated parameters or a variant's.
     Returns { moved: Uint8Array(S.n), why: Map(shell -> reason it stayed),
     zoneHits: Set(zone names that changed a decision) }. */
  const shellNumbers = (s) => {
    const exposed = sf.cab[s] + sf.out[s] + sf.both[s];
    const inside = exposed > 0 ? (sf.cab[s] + 0.5 * sf.both[s]) / exposed : 0;
    const seen = shDirect[s] + shVia[s];
    return { exposed: exposed / (sf.area[s] || 1), inside, seen, insideVis: seen ? shVia[s] / seen : 0 };
  };
  function classify(P) {
    const moved = new Uint8Array(S.n), why = new Map(), zoneHits = new Set();
    const visTau = P.straddle + VIS_OFFSET;
    for (let s = 0; s < S.n; s++) {
      if (!eligible[s]) continue;
      const n = shellNumbers(s);
      const e = CF.envShare(sf, s, P.envelope), eWide = CF.envShare(sf, s, INSIDE_LIMIT);
      let take, reason;
      if (n.seen >= SEEN_MIN) {
        // Seen from outside: through the windows (cabin) or straight on.
        take = n.insideVis >= visTau && eWide >= VIS_ENV;
        reason = take ? null : n.insideVis < visTau ? `seen straight on from outside (${pct(1 - n.insideVis, 0)} of what is seen of it)` : `${pct(eWide, 0)} within the envelope`;
      } else if (n.exposed < HIDDEN_EXPOSED) {
        take = e >= HIDDEN_ENV && (n.exposed === 0 || n.inside >= 0.5);
        reason = take ? null : e < HIDDEN_ENV ? `hidden, ${pct(e, 0)} within the envelope` : `hidden, faces outside air`;
      } else {
        take = n.inside >= P.straddle && e >= MIN_ENV;
        reason = take ? null : n.inside < P.straddle ? (n.inside < 0.05 ? "outside the cabin" : `straddles: ${pct(n.inside, 0)} inside`) : `${pct(e, 0)} within the envelope`;
      }
      const z = zoneOf[s];
      if (z >= 0 && P[ZONES[z]] !== "default") {
        const mode = P[ZONES[z]];
        const want = mode === "out" ? false
          : n.seen >= SEEN_MIN ? n.insideVis >= 0.5 && eWide >= VIS_ENV
          : n.exposed >= 0.05 && n.inside >= ZONE_IN_SHARE && eWide >= VIS_ENV;
        if (want !== take) { zoneHits.add(ZONES[z]); take = want; reason = take ? null : `${ZONES[z]} ${mode}`; }
      }
      if (take) moved[s] = 1; else why.set(s, reason);
    }
    /* The triangles: every triangle of a moved shell, except the far end of
       a shell that runs out of the cabin unseen -- the Sentra's carpet is one
       piece with the floor under its engine bay, the Camry's dash reaches
       under the cowl. What lies more than INSIDE_LIMIT voxels from the cabin's
       air and is not seen through a window stays in its material. */
    const tri = new Uint8Array(T);
    let trimmed = 0;
    for (let s = 0; s < S.n; s++) {
      if (!moved[s]) continue;
      for (let j = S.start[s]; j < S.start[s + 1]; j++) {
        const t = S.tris[j];
        if (faces.envNear[t] > INSIDE_LIMIT && !vis.viaGlass[t]) { trimmed++; continue; }
        tri[t] = 1;
      }
    }
    return { moved, tri, trimmed, why, zoneHits };
  }

  // ---- checks -------------------------------------------------------------------------
  const roleTris = (r) => { let n = 0; for (const v of scene.visits) if (v.first && v.prim.getMaterial() && role.has(v.prim.getMaterial()) && role.get(v.prim.getMaterial()).role === r) n += v.triCount; return n; };
  /* The checks every classification is held to; judged on the PLAN (the
     shells it moves). The four role checks are judged again on the written
     document (afterRoles below). */
  function judge(c) {
    const checks = [];
    const add = (n, pass, detail) => checks.push({ name: n, pass: !!pass, detail });
    let movedTris = 0, roleHit = { seat: 0, glass: 0, paint: 0, light: 0 }, beyond = 0, maxD = 0, directPx = 0, seenPx = 0;
    const beyondBy = new Map(), directBy = new Map(), exteriorShells = [];
    let darkPx = 0;
    for (let s = 0; s < S.n; s++) {
      if (!c.moved[s]) continue;
      const r = visitRole[S.visit[s]];
      let n = 0, dPx = 0, vPx = 0;
      for (let j = S.start[s]; j < S.start[s + 1]; j++) {
        const t = S.tris[j];
        if (!c.tri[t]) continue;
        n++; movedTris++;
        dPx += vis.direct[t]; vPx += vis.viaGlass[t];
        const d = faces.envNear[t];
        if (d > maxD) maxD = d;
        if (d > INSIDE_LIMIT) { beyond++; const k = scene.visits[S.visit[s]].matName; beyondBy.set(k, (beyondBy.get(k) || 0) + 1); }
      }
      if (r && roleHit[r] !== undefined) roleHit[r] += n;
      seenPx += dPx + vPx;
      /* Seen straight on, a piece that was near-black already does not change
         what the outside looks like (the Elantra's black.009 window
         surround): counted apart. */
      if (darkVisit[S.visit[s]]) { darkPx += dPx; continue; }
      directPx += dPx;
      if (dPx >= EXTERIOR_PX && dPx > EXTERIOR_SHELL * (dPx + vPx)) exteriorShells.push({ name: scene.visits[S.visit[s]].matName, tris: n, px: Math.round(dPx + vPx), share: dPx / (dPx + vPx) });
      if (dPx) { const k = scene.visits[S.visit[s]].matName; directBy.set(k, (directBy.get(k) || 0) + dPx); }
    }
    for (const [r, label] of [["seat", "seat-untouched"], ["glass", "glass-untouched"], ["paint", "paint-untouched"], ["light", "lights-untouched"]]) {
      const names = namesOf(r);
      add(label, roleHit[r] === 0, roleHit[r] ? `${roleHit[r]} triangle(s) of ${names.join(", ")} would move` : names.length ? `${names.length} material(s), ${roleTris(r)} triangles, none moved (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""})` : "none in this file");
    }
    const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${Math.round(n)}`).join(", ");
    add("inside-cabin", beyond === 0, beyond
      ? `${beyond} moved triangle(s) lie more than ${INSIDE_LIMIT} voxels (${(INSIDE_LIMIT * air.g.v / F.L * 100).toFixed(1)}% of L) from the cabin's air: ${top(beyondBy)}`
      : `all ${movedTris} moved triangles lie within ${INSIDE_LIMIT} voxels (${(INSIDE_LIMIT * air.g.v / F.L * 100).toFixed(1)}% of L) of the cabin's air, the farthest ${maxD}` + (c.trimmed ? `; ${c.trimmed} unseen triangle(s) of moved pieces lie farther and stay` : ""));
    // cabin-covered: the cabin seen through the windows.
    let total = 0, black = 0, dark = 0;
    const left = new Map();
    for (let t = 0; t < T; t++) {
      const v = vis.viaGlass[t];
      if (!v || faces.envNear[t] > INSIDE_LIMIT) continue;
      const vi = scene.triVisit[t], r = visitRole[vi];
      if (r === "seat") continue;
      total += v;
      if (r === "target" || c.tri[t]) { black += v; continue; }
      if (darkVisit[vi]) { dark += v; continue; }
      const m = scene.visits[vi].matName;
      const wk = r ? ROLE_WORD[r] || r : whyWord(c.why.get(scene.shellOf[t]));
      const e = left.get(m) || { name: m, px: 0, tris: new Set(), why: new Map() };
      e.px += v; e.tris.add(t);
      e.why.set(wk, (e.why.get(wk) || 0) + v);
      left.set(m, e);
    }
    const coverage = total ? (black + dark) / total : 1;
    const leftovers = [...left.values()].sort((a, b) => b.px - a.px).slice(0, 8).map((e) => ({ name: e.name, tris: e.tris.size, px: e.px, why: [...e.why].sort((a, b) => b[1] - a[1])[0][0] }));
    add("cabin-covered", coverage >= COVER_MIN, `${pct(coverage)} of the cabin seen through the windows is black (at least ${pct(COVER_MIN, 0)}; the seat aside): ${pct(total ? black / total : 0)} in ${name}, ${pct(total ? dark / total : 0)} already near-black` + (leftovers.length ? "; biggest leftovers: " + leftovers.slice(0, 4).map((l) => `${l.name} (${l.why}, ${pct(l.px / (total || 1))})`).join("; ") : ""));
    const share = seenPx ? directPx / seenPx : 0;
    const outer = exteriorShells.sort((a, b) => b.px - a.px);
    add("exterior-unchanged", share <= EXTERIOR_MAX && !outer.length, outer.length
      ? `${outer.length} moved piece(s) are mostly seen straight on from outside, not through the glass: ` + outer.slice(0, 4).map((o) => `${o.name} (${o.tris} triangles, ${pct(o.share, 0)} of ${o.px} px)`).join("; ")
      : directPx
        ? `${Math.round(directPx)} of the moved surface's ${Math.round(seenPx)} visible pixels are seen straight on from outside (${pct(share, 2)}, at most ${pct(EXTERIOR_MAX, 0)}: cabin seen through gaps in the export, not exterior parts -- no moved piece is mostly seen that way): ${top(directBy)}` + (darkPx ? `; ${Math.round(darkPx)} more of pieces that were near-black already` : "")
        : `none of the moved surface is seen straight on from outside (${Math.round(seenPx)} pixels of it are seen through the glass)` + (darkPx ? `, except ${Math.round(darkPx)} of pieces that were near-black already` : ""));
    return { checks, movedTris, coverage, inBlack: total ? black / total : 0, alreadyDark: total ? dark / total : 0, leftovers, failed: checks.filter((x) => !x.pass).map((x) => x.name) };
  }

  // ---- calibrated, or --seed variants ------------------------------------------------
  const idsOf = (c) => { const out = []; for (let t = 0; t < T; t++) if (c.tri[t]) out.push(t); return Int32Array.from(out); };
  let C, J, P = { ...CALIBRATED }, variation = null;
  if (!seeded) {
    C = classify(P); J = judge(C);
  } else {
    const calib = classify(CALIBRATED);
    const seen = new Map([[fingerprint(idsOf(calib)), "the calibrated run"]]);
    const tried = new Map();
    run.log(`--seed ${seed}: up to ${tries} variant${tries === 1 ? "" : "s"}; the first that passes every check is ${report ? "reported" : "written"}`);
    const res = await runVariants({
      seed, tries, label: "variant", log: (line) => run.log(line),
      attempt: (draw, info) => {
        const p = drawCabinParams(draw);
        const c = classify(p);
        const ids = idsOf(c);
        const fp = fingerprint(ids);
        tried.set(info.k, { triangles: ids.length, fingerprint: fp.slice(0, 12), label: describeCabin(p, c.zoneHits) });
        if (seen.has(fp)) { tried.get(info.k).sameAs = seen.get(fp); return { duplicate: typeof seen.get(fp) === "number" ? seen.get(fp) : true }; }
        seen.set(fp, info.k);
        const j = judge(c);
        return { failed: j.failed, c, j, p };
      },
    });
    const pk = res.chosen || res.closest;
    variation = { ...res.summary, rejected: res.summary.rejected.map((r) => ({ ...r, ...tried.get(r.attempt) })), label: pk ? tried.get(pk.k).label : null, ...(pk ? tried.get(pk.k) : {}) };
    run.summary.variation = variation;
    if (!pk) return run.finish(false, `no new variant in ${tries} tr${tries === 1 ? "y" : "ies"} (seed ${seed}): every attempt moved the same triangles as the calibrated run or an earlier attempt. Nothing ${report ? "reported" : "written"}: try another seed, or Calibrated.`);
    C = pk.result.c; J = pk.result.j; P = pk.result.p;
    run.log(res.chosen ? `variant ${pk.k} of ${tries} passed (seed ${seed}${pk.k > 1 ? ", sub-seed " + pk.subSeed : ""}): ${variation.label}` : `no variant passed in ${tries}; the closest is attempt ${pk.k}: ${variation.label}`);
    if (!res.chosen) {
      if (report || !flags.force) {
        for (const c of J.checks) run.check(c.name, c.pass, c.detail);
        return run.finish(false, noVariantMessage(res, seed, tries) + " Attempt " + pk.k + ": " + J.checks.filter((c) => !c.pass).map((c) => c.name + " (" + c.detail + ")").join("; "), 3);
      }
      run.warn(`--force: no variant passed (seed ${seed}); writing the closest, attempt ${pk.k}`);
    }
  }

  // ---- summary ------------------------------------------------------------------------
  const movedShells = [];
  for (let s = 0; s < S.n; s++) if (C.moved[s]) movedShells.push(s);
  // Per material (first instances only: what the file holds).
  const matTris = new Map(), matMoved = new Map();
  for (const v of scene.visits) if (v.first) matTris.set(v.matName, (matTris.get(v.matName) || 0) + v.triCount);
  for (let t = 0; t < T; t++) { if (!C.tri[t]) continue; const v = scene.visits[scene.triVisit[t]]; if (v.first) matMoved.set(v.matName, (matMoved.get(v.matName) || 0) + 1); }
  const movedFrom = [...matMoved].sort((a, b) => b[1] - a[1]).map(([n, k]) => ({ name: n, tris: k, ofTris: matTris.get(n), whole: k === matTris.get(n) }));
  const triangles = movedFrom.reduce((a, m) => a + m.tris, 0);
  // Skipped: what each exclusion kept that lies in the cabin's envelope.
  const skipped = { glass: { materials: namesOf("glass"), tris: 0 }, paint: { materials: namesOf("paint"), tris: 0 }, lights: { materials: namesOf("light"), tris: 0 }, keep: { materials: namesOf("keep"), tris: 0 }, outside: { shells: 0, tris: 0 } };
  for (let s = 0; s < S.n; s++) {
    const v = scene.visits[S.visit[s]];
    if (!v.first || CF.envShare(sf, s, P.envelope) < 0.5) continue;
    const r = visitRole[S.visit[s]];
    if (r === "glass" || r === "paint" || r === "keep") skipped[r].tris += S.count[s];
    else if (r === "light") skipped.lights.tris += S.count[s];
    else if (!r && !C.moved[s]) { skipped.outside.shells++; skipped.outside.tris += S.count[s]; }
  }
  const seatTris = roleTris("seat");
  Object.assign(run.summary, {
    material: name, triangles, shells: movedShells.filter((s) => scene.visits[S.visit[s]].first).length, trimmed: C.trimmed, movedFrom,
    seat: namesOf("seat"), seatTris, skipped, leftovers: J.leftovers.map((l) => ({ name: l.name, tris: l.tris, why: l.why })),
    coverage: +J.coverage.toFixed(4), coverageInBlack: +J.inBlack.toFixed(4), coverageAlreadyDark: +J.alreadyDark.toFixed(4), front: front ? (front > 0 ? "+" : "-") + "xyz"[F.len] : null,
    timings: { sceneMs: tScene - t0, viewsMs: tVis - tScene, airMs: tAir - tVis },
  });
  run.log(`would move ${triangles} triangles in ${run.summary.shells} shells from ${movedFrom.length} material(s) into ${name}` + (target ? " (already there: " + roleTris("target") + ")" : ""));
  for (const m of movedFrom.slice(0, 12)) run.log(`  ${m.name.slice(0, 44).padEnd(44)} ${String(m.tris).padStart(7)} of ${String(m.ofTris).padStart(7)}${m.whole ? "  (all of it: the material goes)" : ""}`);
  if (movedFrom.length > 12) run.log(`  ... ${movedFrom.length - 12} more`);
  if (process.env.CABIN_DEBUG) {
    // Calibration dump: every shell that faces the cabin or lies near it.
    const rows = [];
    for (let s = 0; s < S.n; s++) {
      const n = shellNumbers(s), e = CF.envShare(sf, s, P.envelope);
      if (e < 0.2 && !C.moved[s] && shVia[s] < 50) continue;
      const v = scene.visits[S.visit[s]];
      let dmax = 0;
      for (let j = S.start[s]; j < S.start[s + 1]; j++) dmax = Math.max(dmax, faces.envNear[S.tris[j]]);
      rows.push({ s, mat: v.matName, mesh: v.meshName, first: v.first, role: visitRole[S.visit[s]], tris: S.count[s], area: +(sf.area[s] / F.L / F.L).toFixed(6),
        cab: +(sf.cab[s] / sf.area[s]).toFixed(3), out: +(sf.out[s] / sf.area[s]).toFixed(3), both: +(sf.both[s] / sf.area[s]).toFixed(3), exposed: +n.exposed.toFixed(3), inside: +n.inside.toFixed(3), insideVis: +n.insideVis.toFixed(3), env: +e.toFixed(3), dmax,
        direct: shDirect[s], via: shVia[s], zone: zoneOf[s] >= 0 ? ZONES[zoneOf[s]] : null, moved: !!C.moved[s], why: C.why.get(s) || null,
        L: [relLen(S.min[s * 3 + F.len]), relLen(S.max[s * 3 + F.len])].map((x) => +x.toFixed(3)), W: [relW(S.min[s * 3 + F.wid]), relW(S.max[s * 3 + F.wid])].map((x) => +x.toFixed(3)), H: [relUp(S.min[s * 3 + F.up]), relUp(S.max[s * 3 + F.up])].map((x) => +x.toFixed(3)) });
    }
    (await import("node:fs")).writeFileSync(process.env.CABIN_DEBUG, JSON.stringify(rows));
  }
  if (!triangles) return run.finish(false, "nothing to do: no cabin triangle is left outside " + name + (target ? " (the cabin is already black)" : "") + "; nothing written");

  if (report) {
    for (const c of J.checks) run.check(c.name, c.pass, c.detail);
    run.log(J.failed.length ? `${J.failed.length} check(s) would fail: ${J.failed.join(", ")}` : "all checks pass (report: nothing written)");
    return run.finish(true);
  }

  // ---- split ----------------------------------------------------------------------------
  const before = new Map();
  const countTris = () => {
    const m = new Map();
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
      const mat = p.getMaterial(); if (!mat) continue;
      const n = p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute("POSITION").getCount() / 3;
      m.set(mat, (m.get(mat) || 0) + n);
    }
    return m;
  };
  for (const [m, n] of countTris()) before.set(m, n);
  const sources = new Set();
  // Local triangles to move, per visit.
  const perVisit = new Map();
  for (let t = 0; t < T; t++) {
    if (!C.tri[t]) continue;
    const vi = scene.triVisit[t];
    if (!perVisit.has(vi)) perVisit.set(vi, []);
    perVisit.get(vi).push(t - scene.visits[vi].triStart);
  }
  /* A primitive drawn by several nodes (an instanced mesh) moves once when
     every instance moves the same triangles; otherwise each node that moves
     anything gets its own copy of the mesh first (as seat-split does). */
  const byPrim = new Map();
  scene.visits.forEach((v, vi) => { if (!byPrim.has(v.prim)) byPrim.set(v.prim, []); byPrim.get(v.prim).push(vi); });
  const jobs = []; // { node, mesh, primIndex, locals }
  const key = (a) => (a ? a.slice().sort((x, y) => x - y).join(",") : "");
  const cloned = new Map(); // node -> own mesh
  for (const [prim, vis_] of byPrim) {
    const sets = vis_.map((vi) => perVisit.get(vi) || null);
    if (!sets.some(Boolean)) continue;
    const same = sets.every((x) => key(x) === key(sets[0]));
    if (same) { const v = scene.visits[vis_[0]]; jobs.push({ prim, locals: sets[0], v }); continue; }
    for (let i = 0; i < vis_.length; i++) {
      if (!sets[i]) continue;
      const v = scene.visits[vis_[i]];
      let own = cloned.get(v.node);
      if (!own) {
        own = doc.createMesh(v.mesh.getName());
        for (const p of v.mesh.listPrimitives()) own.addPrimitive(p.clone());
        v.node.setMesh(own);
        cloned.set(v.node, own);
        run.warn(`mesh ${v.mesh.getName() || "(unnamed)"} is drawn by several nodes that differ; node ${v.node.getName() || "(unnamed)"} got its own copy`);
      }
      jobs.push({ prim: own.listPrimitives()[v.primIndex], locals: sets[i], v });
    }
  }
  let mat = target;
  if (!mat) {
    mat = doc.createMaterial(name).setBaseColorFactor(RECIPE.baseColorFactor).setMetallicFactor(RECIPE.metallicFactor).setRoughnessFactor(RECIPE.roughnessFactor).setEmissiveFactor(RECIPE.emissiveFactor);
  }
  const buffer = root.listBuffers()[0] || doc.createBuffer();
  let doubleSided = mat.getDoubleSided();
  for (const job of jobs) {
    const prim = job.prim;
    const meshOf = prim.listParents().find((p) => p.propertyType === "Mesh");
    const src = prim.getMaterial();
    sources.add(src);
    if (src && src.getDoubleSided()) doubleSided = true;
    const idx = prim.getIndices() ? prim.getIndices().getArray() : null;
    const vc = prim.getAttribute("POSITION").getCount();
    const triCount = idx ? idx.length / 3 : vc / 3;
    const chosen = new Uint8Array(triCount);
    for (const l of job.locals) chosen[l] = 1;
    if (job.locals.length === triCount) { prim.setMaterial(mat); continue; }
    const inside = [], outside = [];
    for (let l = 0; l < triCount; l++) {
      const a = idx ? idx[l * 3] : l * 3, b = idx ? idx[l * 3 + 1] : l * 3 + 1, c = idx ? idx[l * 3 + 2] : l * 3 + 2;
      (chosen[l] ? inside : outside).push(a, b, c);
    }
    const Typed = vc < 65536 ? Uint16Array : Uint32Array;
    const mk = (arr) => doc.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer).setArray(new Typed(arr));
    const oldIdx = prim.getIndices();
    prim.setIndices(mk(outside));
    const np = doc.createPrimitive().setMode(prim.getMode()).setMaterial(mat).setIndices(mk(inside));
    for (const sem of prim.listSemantics()) np.setAttribute(sem, prim.getAttribute(sem));
    meshOf.addPrimitive(np);
    if (oldIdx && oldIdx.listParents().every((p) => p.propertyType === "Root")) oldIdx.dispose();
  }
  mat.setDoubleSided(doubleSided);
  // Materials left with no geometry go, and their textures with them when
  // nothing else uses those (found through the property graph, so a
  // texture held by an extension -- clearcoat, specular -- counts too).
  const graph = doc.getGraph();
  const texturesOf = (prop, out = new Set(), seen = new Set()) => {
    if (seen.has(prop)) return out;
    seen.add(prop);
    for (const e of graph.listChildEdges(prop)) { const ch = e.getChild(); if (ch.propertyType === "Texture") out.add(ch); else texturesOf(ch, out, seen); }
    return out;
  };
  const removed = [], texturesDropped = [];
  for (const m of sources) {
    if (!m || m === mat) continue;
    if (m.listParents().some((p) => p.propertyType !== "Root")) continue;
    const texs = texturesOf(m);
    removed.push(m.getName());
    m.dispose();
    for (const tx of texs) if (tx.listParents().every((p) => p.propertyType === "Root")) { texturesDropped.push(tx.getName() || tx.getURI() || "(texture)"); tx.dispose(); }
  }
  run.summary.removed = removed;
  run.summary.texturesDropped = texturesDropped;
  /* The four role checks once more, on the document as it will be written:
     every excluded material holds exactly the triangles it had. */
  const after = countTris();
  const label = { seat: "seat-untouched", glass: "glass-untouched", paint: "paint-untouched", light: "lights-untouched" };
  for (const [r, n] of Object.entries(label)) {
    const ch = J.checks.find((c) => c.name === n);
    const bad = [];
    for (const [m, k] of before) if (role.has(m) && role.get(m).role === r && (after.get(m) || 0) !== k) bad.push(`${m.getName()} ${k} -> ${after.get(m) || 0}`);
    if (bad.length) { ch.pass = false; ch.detail += "; but the written file differs: " + bad.join(", "); }
    else if (ch.pass) ch.detail += "; the written file agrees";
  }
  for (const c of J.checks) run.check(c.name, c.pass, c.detail);
  const failed = J.checks.filter((c) => !c.pass).map((c) => c.name);
  if (failed.length && !flags.force) return run.finish(false, `not writing ${base(outPath)}: check(s) failed: ${failed.join(", ")}. Pass --force to write anyway.`, 3);
  if (failed.length) run.warn("--force: wrote despite failed checks: " + failed.join(", "));
  run.log(`moved ${triangles} triangles into ${name}` + (removed.length ? `; removed ${removed.length} emptied material(s): ${removed.join(", ")}` : "") + (texturesDropped.length ? `; dropped ${texturesDropped.length} texture(s) only they used` : ""));
  await writeGlb(io, doc, outPath);
  run.output = outPath;
  run.summary.timings.totalMs = Date.now() - t0;
  return run.finish(true);
});
