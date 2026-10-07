/* seat-vary: the seeded variation behind `seat-split --seed <uint32>` -- the
   lab's "Random cut" / "Try another" on the Seat tab. Without --seed nothing
   here runs and seat-split cuts exactly what it always cut (the calibrated
   seat, byte for byte).

   Why vary at all: the calibrated rules pick ONE seat per car, and on some
   exports that is not the seat the person wants painted -- the headrest is a
   separate black part on the real car, the seat-back plastic should stay
   black, a strip of stitching or a seat-side switch came along. Each variant
   draws the numbers that decide WHICH shells join the seat from a seeded
   PRNG, within ranges around the calibrated values, so every variant is a
   plausible seat; the person clicks until one looks right, and the seed
   reproduces it exactly.

   What is NEVER varied: the gates. seat-split judges every variant with the
   same checks as a calibrated cut, at the calibrated limits (lib/seat-find.mjs
   seatChecks + driverSide, and seat-split's seat-material): one object,
   seat-sized, below the roof and the headliner, inside the walls (no door
   card or pillar), on its own side (not the other seat), clear of the
   console, a sane triangle count, the DRIVER's side, the right material. Nor
   the hard shell vetoes (shellVeto: pillars, roof band, door cards, floor
   mats, belt straps, the other seat) -- a variant only chooses among shells a
   seat may contain. Nor WHICH seat: --pick's seed shell under the tap and
   --auto's front row, front and driver's side are settled once, calibrated
   (seat-find pickPlan / autoPlan), and only the growth from there varies.
   Nor the material name rules (--name, --redo, --append) or the colour: the
   cut lands in the seat material, which the page paints.

   The PRNG (mulberry32), the sub-seeds, the attempts loop and the dedupe are
   the shared lib/variation.mjs -- the same scheme vertex-shading and
   occlusion-patch use, so one seed means one thing across the lab. Attempt 1
   draws from the seed itself; when its checks fail, attempt k draws from
   subSeed(seed, k), up to --tries (default 8, max 20); the first variant
   whose checks all pass is written (or reported). A variant whose triangle
   set equals an earlier attempt's in the same run is rejected as a
   duplicate (it would cut the same seat) and the next draw is tried. This
   file holds what is the seat's own: the parameters, their ranges, and what
   they do to the growth or the box. */

/* The ranges, around the calibrated values (lib/seat-find.mjs seatLimits and
   the growth constants), and why each stops where it does. Units are the
   calibrated ones: fractions of the car (W, H, L) or of the voxel. The draws
   themselves are in drawSeatParams, in this order. */
export const GROW_RANGES = {
  /* Neighbours within gapVox voxels of the seat so far join it (calibrated
     2). 1 keeps only pieces that nearly touch (~1.4 cm on a 4.8 m car): a
     headrest on posts or a separate side panel can drop off. 3 bridges ~4 cm:
     the backrest's separate cap, a seat-side cover. More than 3 starts
     reaching the console trims and armrest switches shellVeto lets through
     (the Optima's crept in at 2-3 cm, which is why calibrated is 2). */
  gapVox: [1, 3],
  /* The voxel the surfaces are sampled on, x 0.003 L (calibrated 1). With
     gapVox it sets the reach, gapVox x voxelScale calibrated voxels: drawn
     in 1.0-1.25 at gap 1, 0.8-1.25 at gap 2, 0.8-1.05 at gap 3, so the reach
     stays within 1.0-3.15 calibrated voxels. */
  voxelScale: [0.8, 1.25],
  /* Growth stops when the seat's box would pass envelope x a front seat's
     maximum (0.35 W, 0.75 H, 0.21 L). Measured seats are 0.29-0.31 W and
     0.55-0.69 H, so at 0.86 (0.30 W, 0.645 H, 0.18 L) the tallest and widest
     seats lose an outer bolster panel or the headrest top; 1 is calibrated
     and never more -- the seat-size check would refuse a bigger seat anyway. */
  envelope: [0.86, 1],
  /* Whether shells of OTHER materials join at all (calibrated yes). No: only
     the seat's own material(s) -- a red cushion and backrest with the back
     plastic, belt guide trim and headrest left in their own colour. p(yes)
     0.8. */
  others: [false, true],
  /* ...and when they do, the share of such a shell that must lie in the
     seat's footprint column (calibrated 0.7): the seat-back plastic, a
     headrest in its own material. 0.5 lets a back panel that wraps under the
     cushion join; 0.9 only what is wholly inside. Below 0.5 armrest switches
     creep in one by one (the Optima, before 0.7). */
  otherInside: [0.5, 0.9],
  /* growAdaptive (--pick/--auto without --source): at most adoptMax other
     materials (calibrated 2) that each cover adoptShare of the seat's area
     in its footprint column (calibrated 0.5) become part of the seat. The
     Elantra's seat is nn7.001 inserts + qeeqeeq bolsters; 0 adopted gives
     the inserts alone, 0.3 adopts a material that is only a third of the
     seat (a contrast panel). adoptShare is not drawn when adoptMax is 0. */
  adoptMax: [0, 2],
  adoptShare: [0.3, 0.8],
  /* Shells ending within consoleTol x W of the seat core's inboard edge are
     taken out as console (calibrated 0.004 W, ~7 mm -- the console-clear
     check's own tolerance, so never less: a variant must not keep what the
     check refuses). Up to 0.012 W (~2 cm) also takes out the inboard bolster
     trim, the belt buckle stalk and seat-side switches that hug the edge. */
  consoleTol: [0.004, 0.012],
  /* No: the headrest -- shells starting above 68% of the seat's height, at
     most 60% of its width and centred on it (pad, posts, collars; the rule
     and its measurements are at seat-find tuneDrops) -- is taken out and the
     seat regrown without it. A tap ON the headrest keeps it (the seed shell
     is never dropped). p(yes) 0.75 -- most people want the whole seat. */
  headrest: [false, true],
  /* Yes (p 0.5): pieces smaller than minShellShare of the seat's area are
     taken out (calibrated: keep all) -- stitching strips, buttons, a lever
     cap; 0.0005-0.004 (the Sportage 2021's stitching is ~0.001-0.003 of its
     seat). The seat is regrown without them, so what was reached only
     through a dropped piece goes too and one-object still holds. */
  dropSmall: [false, true],
  minShellShare: [0.0005, 0.004],
};
/* Not drawn: an export that names its seat meshes (the Maxima's
   maxima_seats_FL_*) gets the named meshes whole from the calibrated cut,
   and nothing else varies that -- so every variant of it GROWS the seat
   from those meshes like any other seat (growTune: named false), or it
   would only repeat the calibrated cut (which seat-split rejects as a
   duplicate). */
export const BOX_RANGES = {
  /* Each face of the --box moves out (positive) or in (negative) by this
     share of the box's extent on that axis (calibrated 0). A box typed or
     dragged on the page is a few centimetres off either way; shells
     straddling its faces come and go. Per car axis: width, up, length. The
     --exclude boxes are never moved. */
  padWidth: [-0.06, 0.06],
  padUp: [-0.06, 0.06],
  padLength: [-0.06, 0.06],
  /* A whole shell moves when more than minInside of its triangle centroids
     are in the box (calibrated 0.5; --min-inside fixes it). 0.3 takes a
     bolster that the box only half covers, 0.75 leaves out what a face
     crosses. Not drawn with --mode tris (no shells). */
  minInside: [0.3, 0.75],
  /* Yes (p 0.3): a shell with 20% .. minInside of its centroids inside is cut
     by triangle -- its inside part moves -- instead of staying out. --mode
     shell fixes it at no; not drawn with --mode tris. */
  borderTris: [false, true],
};

/* Draws one parameter set into `draw` (a lib/variation.mjs Draw). EVERY
   parameter is drawn, in this fixed order, on every attempt, whether it
   applies to this cut or not (`unused`: the draw is consumed and nothing is
   recorded), so a seed means the same numbers whatever the mode, the car or
   the flags, and a parameter fixed by a flag never shifts the others.
     kind      "grow" (--pick, --auto) or "box"
     adaptive  the growth adopts other materials (no --source)
     minInside --min-inside, when given: fixed
     mode      --mode, when given: shell fixes borderTris at no, tris leaves
               minInside and borderTris out
   Returns the values; a parameter not drawn is undefined, which the growth
   and boxSelect read as "calibrated". */
export function drawSeatParams(draw, { kind, adaptive = true, minInside, mode }) {
  const grow = kind === "grow", box = kind === "box";
  const R = GROW_RANGES, B = BOX_RANGES;
  const P = {};
  // grow (--pick / --auto)
  P.gapVox = draw.int("gapVox", R.gapVox[0], R.gapVox[1], { unused: !grow });
  const vs = P.gapVox === 1 ? [1.0, 1.25] : P.gapVox === 3 ? [0.8, 1.05] : [0.8, 1.25];
  P.voxelScale = draw.uniform("voxelScale", vs[0], vs[1], { step: 0.01, unused: !grow });
  P.envelope = draw.uniform("envelope", R.envelope[0], R.envelope[1], { step: 0.01, unused: !grow });
  P.others = draw.chance("others", 0.8, { unused: !grow });
  P.otherInside = draw.uniform("otherInside", R.otherInside[0], R.otherInside[1], { step: 0.05, unused: !grow || !P.others });
  P.adoptMax = draw.int("adoptMax", R.adoptMax[0], R.adoptMax[1], { unused: !grow || !adaptive });
  P.adoptShare = draw.uniform("adoptShare", R.adoptShare[0], R.adoptShare[1], { step: 0.05, unused: !grow || !adaptive || !P.adoptMax });
  P.consoleTol = draw.uniform("consoleTol", R.consoleTol[0], R.consoleTol[1], { step: 0.001, unused: !grow });
  P.headrest = draw.chance("headrest", 0.75, { unused: !grow });
  P.dropSmall = draw.chance("dropSmall", 0.5, { unused: !grow });
  P.minShellShare = draw.uniform("minShellShare", R.minShellShare[0], R.minShellShare[1], { step: 0.0005, unused: !grow || !P.dropSmall });
  // box
  P.padWidth = draw.uniform("padWidth", B.padWidth[0], B.padWidth[1], { step: 0.005, unused: !box });
  P.padUp = draw.uniform("padUp", B.padUp[0], B.padUp[1], { step: 0.005, unused: !box });
  P.padLength = draw.uniform("padLength", B.padLength[0], B.padLength[1], { step: 0.005, unused: !box });
  P.minInside = draw.uniform("minInside", B.minInside[0], B.minInside[1], { step: 0.05, fixed: minInside, unused: !box || mode === "tris" });
  P.borderTris = draw.chance("borderTris", 0.3, { fixed: mode === "shell" ? false : undefined, unused: !box || mode === "tris" });
  return P;
}

/* The growth tuning a parameter set gives seat-find (growFrom/growAdaptive/
   growClear `tune`), and the growth limits `glim`: the calibrated ones with
   the voxel and gap replaced -- the vetoes, the region and the checks keep
   the calibrated `lim` (seatLimits: roof band, walls, centre plane, seat
   envelope). */
export function growTune(P, lim) {
  const glim = { ...lim, voxel: lim.voxel * P.voxelScale, gapVox: P.gapVox };
  const tune = { envelope: P.envelope, otherInside: P.otherInside, others: P.others, adoptShare: P.adoptShare, adoptMax: P.adoptMax,
    consoleTol: P.consoleTol, headrest: P.headrest, minShellShare: P.dropSmall ? P.minShellShare : 0, named: false };
  return { glim, tune };
}

/* The --box a parameter set gives: each face moved by pad x the box's extent
   on that car axis (F: seat-scene's frame). A box padded inward past its own
   middle collapses to the middle (and selects nothing; one-object refuses). */
export function padBox(box, P, F) {
  const pad = [0, 0, 0];
  pad[F.wid] = P.padWidth; pad[F.up] = P.padUp; pad[F.len] = P.padLength;
  const min = box.min.slice(), max = box.max.slice();
  for (let k = 0; k < 3; k++) {
    const e = (box.max[k] - box.min[k]) * pad[k];
    min[k] = box.min[k] - e; max[k] = box.max[k] + e;
    if (min[k] > max[k]) { const c = (box.min[k] + box.max[k]) / 2; min[k] = max[k] = c; }
  }
  return { min, max };
}

/* A few words for the page's "Tried" list (summary.variation.label): what
   makes this variant differ from the calibrated cut, most visible first.
   named: the calibrated cut took a named seat mesh whole (this one grew it). */
export function describe(params, kind, { named = false } = {}) {
  const w = [];
  if (kind === "box") {
    const pads = ["padWidth", "padUp", "padLength"].filter((n) => n in params && params[n] !== 0);
    if (pads.length) w.push("box " + pads.map((n) => `${n.slice(3).toLowerCase()} ${params[n] > 0 ? "+" : ""}${Math.round(params[n] * 100)}%`).join(" "));
    if ("minInside" in params && params.minInside !== 0.5) w.push(`shells ${Math.round(params.minInside * 100)}% in`);
    if (params.borderTris) w.push("edge shells by triangle");
    return w.join(", ") || "calibrated box";
  }
  if (named) w.push("grown, not the named mesh whole");
  if (params.headrest === false) w.push("no headrest");
  if (params.others === false) w.push("own material only");
  if ("gapVox" in params) {
    const reach = params.gapVox * params.voxelScale;
    if (reach < 1.6) w.push("tight"); else if (reach > 2.5) w.push("loose");
  }
  if (params.envelope !== undefined && params.envelope < 0.93) w.push("trimmed to " + Math.round(params.envelope * 100) + "%");
  if (params.consoleTol !== undefined && params.consoleTol >= 0.008) w.push("inner edge cut back");
  if (params.dropSmall) w.push("small bits dropped");
  if (params.adoptMax === 0) w.push("one material");
  return w.join(", ") || "close to calibrated";
}
