#!/usr/bin/env node
/* occlusion-patch: give a car body the Camry's shading -- its baked occlusion
   map switched on, a deleted plate's pocket lifted, and a Camry-like line
   drawn along every panel gap -- editing a finished (Draco) GLB.

   The Camry is the benchmark (measured 2026-09-16, headless Chrome, car about
   400 px wide on the page). Its look is not its colour (CAR_LOOK_PROFILE gives
   every car the same silver), its lighting (one <model-viewer>) or its
   geometry (its paint is 22 separate panel pieces with real 2-3 mm gaps, like
   the Nissans', and dark specks per panel pixel are the same). It is the
   paint's occlusion map:
     - the map is ON, so the silver reads grey against the white page: panel
       luminance 185 on the Camry, 204-207 on the Altima and Sentra with their
       maps off;
     - it draws each seam as a THIN line: in a door close-up (fov 5deg) 1 px
       wide at 55 below the panel, and at page size a door-seam contrast of
       18 that breaks on about 21% of rows. The Nissans' own maps are the same
       kind of bake at the same texel size (5.3 and 4.4 mm against 5.6) with
       no line at all.
   A first fit to the Camry map's AVERAGE shade by distance (x0.55-0.65 out to
   ~1 cm, easing back by 4 cm) produced a 7 px soft band, nothing like it: the
   averages blend its thin dark line with the panel around it. The shipped
   curve was calibrated on the rendered line instead.

   --from-metal-roughness  switch the map on: the paint's metallicRoughness
       texture becomes its occlusionTexture too (Sketchfab packs AO into R).
       A no-op when the map is already on (the Altima and Sentra shipped on
       2026-09-29 with it on but unpatched).
   --pocket x0,y0,z0,x1,y1,z1  a rear plate sat in a recess pressed into the
       boot lid with its shadow baked in; with the plate deleted it reads as a
       black rectangle. Every triangle of the material centred in the box,
       except those of a dark cluster that crosses the box's edge (a seam
       passing by), is rasterised into the map (two texels of dilation) and
       raised -- never lowered -- to the median of the panel around the box.
       Raising to a level taken from outside the box is idempotent, so a
       second --pocket pass changes nothing.
   --seams <part substr,...|all|auto>  multiply the map by a curve f(d), d =
       millimetres from the texel's surface point to the nearest triangle of
       ANOTHER listed part (parts are node names, so both sides of every gap
       get it and nothing is drawn inside one panel). `auto` picks the parts
       the way the hand lists were picked -- the body shell plus doors,
       bonnet, boot lid, bumpers, wings, and no trim (black strips, mirrors,
       handles, sensors); it reproduces the Altima's and the Sentra's shipped
       lists exactly (see autoSeamParts in lib/shade-geom.mjs). Default curve:
         f = 0.45 up to 3 mm, easing to 1 at 6 mm
       -- on the Altima and Sentra a door-seam contrast of 20-22 at page size
       (4-7% of rows broken) and a 3 px line at 41-43 below the panel close
       up. Each texel takes the smallest factor of any triangle under it with
       one texel of dilation; without the dilation the edge texels stay light
       and the line fades to 9-15. A wider or deeper curve (a faint shoulder
       out to 4 cm, or 0.3 at the core) only overshoots the Camry.
       --curve "mm:factor,..." replaces it; --profile-scale s deepens (s > 1)
       or lightens (s < 1) it: f' = 1 - s * (1 - f).
   --mm-per-unit n | --car-length-mm n  the model's scale: millimetres per
       file unit, or the car's real length (the paint's longest extent is
       taken as nose to tail). 4900 on the Altima gives 26537 against the
       hand-measured 26440 it shipped with; 4641 on the Sentra 668 against 666.
   --seam-behind (DEFAULT since 2026-09-30; --no-seam-behind turns it off)
       ignore a neighbour lying BEHIND the surface, along its outward (vertex)
       normal: full weight in front of or beside it, fading out from -0.35 to
       -0.7 of the normal. Without it the band also traces any other part
       within reach UNDER the skin -- on the Altima the body's flange behind
       each front door's leading edge, which drew a second, wavy line down the
       door that hooked into a smudge at the sill (the "crease" reported
       2026-09-17). A gap's own walls face across the gap, so their neighbour
       is beside or in front and they stay dark. The band takes the strongest
       factor over every neighbour in reach, not the factor of the single
       nearest one, so a hidden flange closer than the real gap wall cannot
       hide that wall's line. It was opt-in and the notes said "always pass
       it"; the Sentra's shipped command left it out and showed a faint
       doubling on the front door edge, so that command now draws the fixed
       line. Door-seam contrast measured the same with and without (22).
   --reset-specular  drop KHR_materials_specular from the material, so it
       reflects like the Camry's paint (the Sentra's carried 0.126). On its
       own (no --pocket, --seams or --from-metal-roughness) it edits only the
       material entry and needs no map, so it also runs on the no-map cars
       (the Optima and the Accent carry the extension too).
   --report  read-only: the map's state (on/off, patched or not and how that
       was decided), dark clusters (to place a pocket box; the top 12 also go
       to summary.clusters as {tris, meanAO, min, max} for the page), the
       auto parts table, each part's gap percentiles in mm, the map's shade by
       distance from the nearest other part beside the Camry's averages, and
       -- with a scale -- the same seam checks a write runs, on the map as it
       is. A map that cannot be read (the Camry's JPEG) still gets the
       geometry half -- parts, auto table, gap widths -- and the refusal comes
       last; a map that can be read but not written (also a colour map, a
       grey PNG shared with metallicRoughness) is measured and warned about.
   --dry-run  the whole write in memory -- pocket, seams, specular, the
       run-once guard, every self-check -- and nothing written; <out.glb> is
       optional and ignored. Wins over --report (the lab adds --report to
       every Check). The verdict is the checks, ok either way, with a warning
       when a write would refuse; summary.bytesWouldBe is the size the write
       would have, summary.clusters the dark clusters as read.
   --json  the lab server's result line (lib/gltf-io.mjs printLabJson), last.
   --force  write even when a check fails or the file looks patched already.
   --seed n [--tries k]  (the lab's "Random seams"; lib/variation.mjs): draw
       the settings no flag fixed from a PRNG seeded with n -- the seam
       curve's core, hold and ease, --profile-scale, and with --pocket the
       box's padding -- each within a range around the calibrated patch
       (listed where they are drawn, below), and write (or, with --dry-run,
       preview) the first variant whose self-checks all pass, trying up to k
       (default 8, at most 20) draws. --curve or --profile-scale given is
       fixed and the rest vary; --seams, --pocket's box itself, the scale and
       --seam-behind are never varied. Every variant starts from the map as
       read, so they never stack. A variant whose map equals an earlier one's
       is drawn again. None passing: exit 3 and nothing written, naming the
       closest variant and its failed checks (with --force, the closest is
       written). The same seed, input and flags give the same file, byte for
       byte but the marker's date; the marker and summary.variation carry the
       seed and the drawn values. Needs --seams or --pocket (nothing else
       varies); --report ignores it (it measures the map as it is). Without
       --seed nothing changes: the flags above patch exactly as they always
       did.

   Parts are node names; a name two nodes share is split into "name@node
   index" (lib/shade-geom.mjs splitSharedPartNames), and only then, so a car
   with unique names patches exactly as before. A skinned export is refused
   (lib/shade-cli.mjs isSkinned: it lies on its side in this tool's space,
   so pockets and scale would be wrong); run export-fix --unskin first.

   Run once, detected two ways (either refuses --seams without --force):
     - a marker: every write records what it did in the paint material's
       extras.occlusionPatch (curve, parts, scale, pocket, date -- a run that
       does only one half keeps the earlier run's other half, so the marker
       says what the map carries; the earlier marker rides along as
       `previous`). A --pocket alone is never refused by it. model-viewer
       ignores extras and gltf-transform keeps them, so the marker survives a
       later dedup/prune/draco of the file;
     - the map itself, for files patched before the marker existed: the mean
       shade within 3 mm of another listed part against the open panel
       (>= 20 mm). A patched map reads about 0.45 there; the unpatched Altima
       and Sentra maps read 1.02 and 0.87. Under SEAMED_BAND_RATIO it is
       refused as already carrying seam lines.
   The old guard refused any material that already had an occlusion map. That
   is not evidence of a patch -- both Nissans shipped on 2026-09-29 with their
   maps on and no lines -- so it blocked exactly the files that needed the
   tool. A map being on is now only reported.

   Self-checks (computed from the data, see lib/shade-checks.mjs): what a
   camera looking straight down on each seam sees, at a phone's pixel (4.2 mm,
   dpr 3) and at the close-up (1 mm). A failed check refuses the write (exit
   3, nothing written) unless --force; --report runs the line checks too, as
   the health check of a shipped file, and --dry-run runs all of them on the
   patch it would make. The limits sit around the ACCEPTED
   results -- the Altima and Sentra with the default curve, which rendered
   at door-seam contrast 20-22 against the Camry's 18 -- and the known
   failures. (The Camry's own map, measured the same way over its 22 shell
   pieces, reads depth 0.13 and 4 mm: its line is mostly the physical gap and
   the map inside the gap walls, which a straight-down view does not see, so
   its numbers bound the failure rates, not the depth.)
     seam-single-line  seams with two dips at a phone pixel <= 8% (Camry
                       1.8%, Altima 0.3%, Sentra 0%)
     seam-profile-v    the median seam profile at a phone pixel has ONE dip
     seam-no-crease    seams with a dip beyond the curve's reach <= 8%
     seam-coverage     seams without a visible line <= 35% (unpatched maps
                       read 23% on the Altima, 64% on the Sentra)
     seam-depth        median depth at a phone pixel 0.20-0.75 (accepted
                       0.58 / 0.54; unpatched 0.10 / 0.04)
     seam-width        median close-up width <= 18 mm (accepted 13 / 12.5;
                       the map's texel is ~5 mm)
     no-hidden-flange-lines  band texels whose darkest neighbour is UNDER
                       the skin <= 10% (accepted Altima 5.1%, Sentra 2.6% --
                       the -0.35..-0.7 fade; without --seam-behind the
                       Altima reads 26.7%, which is its rendered crease, and
                       the Sentra's old command 17.4%, its faint doubling)
     panel-tone        the panel's median shade moves by <= 3%
     no-new-specks     interior samples under half the panel rise by <= 0.5
                       percentage points
     pocket-lifted     no pocket triangle left under 90% of the fill
     seam-lines-present (--report only) the map draws seam lines at all

   Known limit: switching the Sentra's own map on adds some isolated dark
   specks at page size (4.6 per 1000 panel pixels against 3.5 without it; the
   Camry has 3.1). They are fine detail inside Sentra's bake on visible
   panels -- not the seam line, the specular reset, its door-handle panels or
   inward-facing paint, each tested -- and the map is what gives the Camry's
   panel tone, so they are accepted. The checks count NEW specks only.

   Byte-level writer: the geometry is decoded (Draco included) only to
   measure, and the GLB is rewritten at the byte level -- one image swapped,
   one material entry edited -- so meshes stay byte for byte and Draco never
   runs. Only R changes in the map (glTF reads occlusion from R, roughness/
   metal from G/B); palette entries keep their G and B. The PNG is re-encoded
   losslessly, which changes its size by a few KB either way (the Altima's
   1024 px palette map: see the summary's map bytes).

   Usage:
     node tools/occlusion-patch.mjs <in.glb> --report --material <name> [--seams parts|all|auto (--mm-per-unit n | --car-length-mm n)] [--pocket box]
     node tools/occlusion-patch.mjs <in.glb> [<out.glb>] --dry-run --material <name> [the write's flags]
     node tools/occlusion-patch.mjs <in.glb> <out.glb> --material <name> [--from-metal-roughness] [--pocket box]
       [--seams parts|all|auto (--mm-per-unit n | --car-length-mm n) [--curve mm:f,...] [--profile-scale s] [--no-seam-behind]]
       [--seed n [--tries k]] [--reset-specular] [--force] [--json]
     node tools/occlusion-patch.mjs <in.glb> <out.glb> --material <name> --reset-specular   (no map needed)

   Done at build time, not at load: changing a map through model-viewer's
   material API costs a material recompile that kept the loading overlay up
   about six seconds on a software renderer. */
import fs from "node:fs";
import { basename } from "node:path";
import { Primitive } from "@gltf-transform/core";
import { createIO, fileSize } from "./lib/gltf-io.mjs";
import { parseArgs, parseCurve, runTool, UsageError, isSkinned, SKINNED_ERROR } from "./lib/shade-cli.mjs";
import { grow, xform, xformDir, partGrid, triArea, mmPerUnitFromLength, autoSeamParts, splitSharedPartNames } from "./lib/shade-geom.mjs";
import { decodePng, encodePng, readR, sampleR } from "./lib/shade-png.mjs";
import { seamCheck, profileDips } from "./lib/shade-checks.mjs";
import { parseSeed, parseTries, runVariants, fingerprint, noVariantMessage } from "./lib/variation.mjs";

const TOOL = "occlusion-patch";
const USAGE = "usage: occlusion-patch <in.glb> --report --material name [--seams parts|all|auto (--mm-per-unit n | --car-length-mm n)] [--pocket box] [--json]\n       occlusion-patch <in.glb> [<out.glb>] --dry-run --material name [the write's flags] [--json]\n       occlusion-patch <in.glb> <out.glb> --material name [--from-metal-roughness] [--pocket box] [--seams parts|all|auto (--mm-per-unit n | --car-length-mm n) [--curve mm:f,...] [--profile-scale s] [--no-seam-behind]] [--seed n [--tries k]] [--reset-specular] [--force] [--json]\n       occlusion-patch <in.glb> <out.glb> --material name --reset-specular   (specular only: needs no map)";
const SPEC = {
  bool: ["report", "dry-run", "from-metal-roughness", "reset-specular", "force", "json"],
  value: ["material", "pocket", "seams", "mm-per-unit", "car-length-mm", "curve", "profile-scale", "seed", "tries"],
  negatable: ["seam-behind"],
  retired: { "drop-occlusion": "the map carries the body's shading and seam lines; lift only a plate pocket with --pocket" },
};
const MARKER_VERSION = 2;
const DARK = 0.25;
/* Under this, the band within 3 mm of another listed part is already darker
   than the open panel by more than a native bake ever is: already seamed. */
const SEAMED_BAND_RATIO = 0.7;
const TARGETS = { doubled4: 0.08, crease4: 0.08, flat: 0.35, depth4: [0.2, 0.75], width1: 18, panelShift: 0.03, newSpecks: 0.005, fromBehind: 0.1 };

// ---- GLB container ----------------------------------------------------------
function readGlb(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(path + " is not a binary glTF");
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const bin = binStart < buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  return { json, bin };
}
const viewBytes = (glb, i) => {
  const bv = glb.json.bufferViews[i];
  return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
};
/* Rebuilds the GLB with the BIN chunk view by view in their original order,
   swapping in the replacement bytes, each view starting on a 4-byte
   boundary. Returns the bytes: --dry-run measures them without writing. */
function buildGlbBytes(glb, replacements) {
  const order = glb.json.bufferViews.map((bv, i) => i).filter((i) => (glb.json.bufferViews[i].buffer || 0) === 0)
    .sort((a, b) => (glb.json.bufferViews[a].byteOffset || 0) - (glb.json.bufferViews[b].byteOffset || 0));
  const parts = [];
  let offset = 0;
  for (const i of order) {
    const bytes = replacements.get(i) || viewBytes(glb, i);
    const padding = (4 - (offset % 4)) % 4;
    if (padding) { parts.push(Buffer.alloc(padding)); offset += padding; }
    glb.json.bufferViews[i].byteOffset = offset;
    glb.json.bufferViews[i].byteLength = bytes.byteLength;
    parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    offset += bytes.byteLength;
  }
  const tail = (4 - (offset % 4)) % 4;
  if (tail) parts.push(Buffer.alloc(tail));
  const bin = Buffer.concat(parts);
  glb.json.buffers[0].byteLength = offset;
  let json = Buffer.from(JSON.stringify(glb.json), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHead = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunkHead(json.length, 0x4e4f534a), json, chunkHead(bin.length, 0x004e4942), bin]);
}
const writeGlbBytes = (path, glb, replacements) => fs.writeFileSync(path, buildGlbBytes(glb, replacements));

// ---- map helpers ------------------------------------------------------------
const texelAt = (img, u, v) => Math.min(img.height - 1, Math.floor((v - Math.floor(v)) * img.height)) * img.width + Math.min(img.width - 1, Math.floor((u - Math.floor(u)) * img.width));
/* Sets R of texel i to (about) value, keeping G, B and alpha: palette images
   take the entry nearest the target among those with the texel's own G and B. */
function makeWriter(img) {
  const nearest = new Map();
  return (i, value) => {
    const target = Math.max(0, Math.min(255, Math.round(value)));
    if (!img.palette) { img.px[i * img.channels] = target; return; }
    const pal = img.palette, cur = img.px[i], g = pal[cur * 3 + 1], b = pal[cur * 3 + 2];
    const key = (g * 256 + b) * 256 + target;
    let best = nearest.get(key);
    if (best === undefined) {
      let bestD = Infinity;
      for (let e = 0; e < pal.length / 3; e++) {
        if (pal[e * 3 + 1] !== g || pal[e * 3 + 2] !== b) continue;
        const d = Math.abs(pal[e * 3] - target);
        if (d < bestD) { bestD = d; best = e; }
      }
      nearest.set(key, best);
    }
    if (best !== undefined) img.px[i] = best;
  };
}
const cloneImg = (img) => ({ ...img, px: img.px.slice() });

/* Visits every texel whose centre lies within `dilate` texels of the UV
   triangle, passing the (clamped) barycentric weights of that centre. */
function rasterize(uvs, W, H, dilate, visit) {
  const su = Math.floor(Math.min(uvs[0][0], uvs[1][0], uvs[2][0]));
  const sv = Math.floor(Math.min(uvs[0][1], uvs[1][1], uvs[2][1]));
  const P = uvs.map(([u, v]) => [(u - su) * W, (v - sv) * H]);
  const det = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
  const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]) - dilate)), x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0]) + dilate));
  const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]) - dilate)), y1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1]) + dilate));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const qx = x + 0.5, qy = y + 0.5;
    if (distToTriangle(qx, qy, P) > dilate) continue;
    let w = [1 / 3, 1 / 3, 1 / 3];
    if (Math.abs(det) > 1e-12) {
      const b1 = ((qx - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (qy - P[0][1])) / det;
      const b2 = ((P[1][0] - P[0][0]) * (qy - P[0][1]) - (qx - P[0][0]) * (P[1][1] - P[0][1])) / det;
      const c = [Math.max(0, 1 - b1 - b2), Math.max(0, b1), Math.max(0, b2)];
      const s = c[0] + c[1] + c[2] || 1;
      w = [c[0] / s, c[1] / s, c[2] / s];
    }
    visit(y * W + x, w);
  }
}
function distToTriangle(qx, qy, [a, b, c]) {
  const side = (p, r) => (r[0] - p[0]) * (qy - p[1]) - (r[1] - p[1]) * (qx - p[0]);
  const d1 = side(a, b), d2 = side(b, c), d3 = side(c, a);
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
  const seg = (p, r) => {
    const dx = r[0] - p[0], dy = r[1] - p[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((qx - p[0]) * dx + (qy - p[1]) * dy) / len)) : 0;
    return Math.hypot(qx - p[0] - t * dx, qy - p[1] - t * dy);
  };
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}
// Joins triangles that share a corner (welded at quantum q) into clusters.
function clusterByCorners(list, q) {
  q = q || 1e-9;
  const parent = new Int32Array(list.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byCorner = new Map();
  list.forEach((t, i) => {
    for (const p of t.corners) {
      const k = Math.round(p[0] / q) + "," + Math.round(p[1] / q) + "," + Math.round(p[2] / q);
      const j = byCorner.get(k);
      if (j === undefined) byCorner.set(k, i); else { const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb; }
    }
  });
  const out = new Map();
  list.forEach((t, i) => {
    const r = find(i);
    let cl = out.get(r);
    if (!cl) out.set(r, (cl = { n: 0, ao: 0, members: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    cl.n++; cl.ao += t.ao; cl.members.push(t);
    for (const p of t.corners) grow(cl.min, cl.max, p);
  });
  return [...out.values()];
}
const clusterInside = (cl, box) => cl.min.every((m, k) => m >= box.min[k]) && cl.max.every((m, k) => m <= box.max[k]);
const clusterTouches = (cl, box) => cl.min.every((m, k) => m <= box.max[k]) && cl.max.every((m, k) => m >= box.min[k]);
const within = (b, p) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
function parseBox(s) {
  const v = s.split(",").map(Number);
  if (v.length !== 6 || v.some((n) => Number.isNaN(n))) throw new UsageError("--pocket wants six numbers: x0,y0,z0,x1,y1,z1");
  return { min: [Math.min(v[0], v[3]), Math.min(v[1], v[4]), Math.min(v[2], v[5])], max: [Math.max(v[0], v[3]), Math.max(v[1], v[4]), Math.max(v[2], v[5])] };
}
const f5 = (v) => "[" + v.map((n) => n.toFixed(5)).join(", ") + "]";
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x);
/* summary.clusters: the largest dark clusters, so the page can offer one as a
   --pocket box instead of the user copying six numbers out of the log (they
   printed ~20 lines up, past the page's log tail). Coordinates in file units
   to 6 significant digits: the Altima is 0.18 units long, the Sentra 7. */
const CLUSTERS_IN_SUMMARY = 12;
const sig6 = (n) => +n.toPrecision(6);
const clusterRow = (cl, box) => ({ tris: cl.n, meanAO: r3(cl.ao / cl.n), min: cl.min.map(sig6), max: cl.max.map(sig6),
  ...(box ? { pocket: clusterInside(cl, box) ? "inside" : clusterTouches(cl, box) ? "touching" : null } : {}) });

/* --report: the map's profile by distance from the nearest other part, in
   the buckets the Camry was sampled with. Only a diagnostic: the Camry's
   averages (below) blend its thin dark line with the panel around it, and
   fitting them gave a 7 px soft band instead of its 1 px line. */
const PROFILE_REACH_MM = 40;
const PROFILE_EDGES = [1, 2, 3, 4, 6, 8, 12, 20, 40];
const PROFILE_LABELS = ["<1 mm", "1-2", "2-3", "3-4", "4-6", "6-8", "8-12", "12-20", "20-40", ">=40 (open)"];
const CAMRY_RATIOS = [0.46, 0.62, 0.54, 0.51, 0.58, 0.59, 0.68, 0.76, 0.94, 1];

await runTool(TOOL, USAGE, async (run) => {
  const { flags, positional } = parseArgs(process.argv.slice(2), SPEC);
  const [inPath, outPath] = positional;
  run.input = inPath || null;
  const materialName = flags.material;
  /* --dry-run: the whole write -- pocket, seams, specular, the run-once guard
     and every self-check -- in memory, and nothing written. It wins over
     --report (the lab server adds --report to every Check, so a Check that
     sends --dry-run previews the patch instead of measuring the map as it
     is: on an unpatched map that measurement is only a red
     seam-lines-present). */
  const dryRun = !!flags["dry-run"];
  const report = !!flags.report && !dryRun;
  if (!inPath || !materialName || (!report && !dryRun && !outPath) || positional.length > 2) throw new UsageError("give <in.glb>, --material and either <out.glb>, --report or --dry-run");
  run.input = inPath; run.bytesIn = fileSize(inPath);
  if (run.bytesIn === null) throw new Error("cannot read " + basename(inPath));
  const fileName = basename(inPath);
  if (dryRun) {
    run.summary.dryRun = true;
    if (flags.report) run.log("--dry-run wins over --report: previewing the write");
    if (outPath) run.log("dry run: " + basename(outPath) + " is not written");
  }
  const pocket = flags.pocket ? parseBox(flags.pocket) : null;
  const seamArg = flags.seams ? flags.seams.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const profileScale = flags["profile-scale"] !== undefined ? Number(flags["profile-scale"]) : 1;
  if (!(profileScale > 0)) throw new UsageError("--profile-scale wants a positive number");
  if (flags["mm-per-unit"] !== undefined && flags["car-length-mm"] !== undefined) throw new UsageError("give --mm-per-unit or --car-length-mm, not both");
  const behind = flags["seam-behind"] !== false;
  const CURVE = flags.curve ? parseCurve(flags.curve, "0:0.45,3:0.45,6:1") : [[0, 0.45], [3, 0.45], [6, 1]];
  const REACH_MM = CURVE[CURVE.length - 1][0];
  /* The seam factor at d mm for a curve and a profile scale: the flags' one
     (factorAt), or a seeded variant's. */
  const makeFactor = (curve, scale) => {
    const reachMm = curve[curve.length - 1][0];
    return (dmm) => {
      if (!(dmm < reachMm)) return 1;
      let f = 1;
      for (let i = 1; i < curve.length; i++) {
        const [d0, f0] = curve[i - 1], [d1, f1] = curve[i];
        if (dmm <= d1) { f = f0 + ((f1 - f0) * (dmm - d0)) / (d1 - d0); break; }
      }
      return Math.max(0, 1 - scale * (1 - f));
    };
  };
  const factorAt = makeFactor(CURVE, profileScale);
  /* --seed: the variants below draw what no flag fixed. --report measures the
     map as it is, which no seed changes (--dry-run is the seeded preview). */
  const seeded = flags.seed !== undefined;
  const seed = seeded ? parseSeed(flags.seed, UsageError) : null;
  if (flags.tries !== undefined && !seeded) throw new UsageError("--tries goes with --seed");
  const tries = seeded ? parseTries(flags.tries, UsageError) : 1;
  const useSeed = seeded && !report;
  if (useSeed && !seamArg && !pocket) throw new UsageError("--seed varies the seam curve and the pocket's padding: give --seams and/or --pocket");
  if (seeded && !useSeed) run.warn("--seed ignored: --report measures the map as it is, which no seed changes (--dry-run previews a seeded patch)");

  // ---- material and map -----------------------------------------------------
  const glb = readGlb(inPath);
  if (isSkinned(glb.json)) throw new Error(SKINNED_ERROR);
  const matIndex = (glb.json.materials || []).findIndex((m) => m.name === materialName);
  if (matIndex < 0) throw new Error("no material named " + materialName + " (this file has: " + (glb.json.materials || []).map((m) => m.name).join(", ") + ")");
  const matJson = glb.json.materials[matIndex];
  const mrInfo = matJson.pbrMetallicRoughness && matJson.pbrMetallicRoughness.metallicRoughnessTexture;
  const marker = matJson.extras && matJson.extras.occlusionPatch ? matJson.extras.occlusionPatch : null;
  let occInfo = matJson.occlusionTexture;
  const mapWasOn = !!occInfo;
  run.summary.material = materialName;
  run.summary.mapWasOn = mapWasOn;
  run.summary.marker = marker;
  const spec0 = matJson.extensions && matJson.extensions.KHR_materials_specular;
  run.summary.specular = spec0 ? { ...spec0 } : null;
  let reenabled = false;
  /* --reset-specular alone (no --pocket, --seams or --from-metal-roughness)
     touches only the material entry, so it needs no map: the Optima and the
     Accent carry KHR_materials_specular and have none. It failed there only
     because the page always sent --seams; it runs (and dry-runs) here on any
     material. A --report with it on a material with no map at all says what
     the reset would do instead of refusing over the missing map. */
  const specularOnly = !pocket && !seamArg && !flags["from-metal-roughness"] && !!flags["reset-specular"] && (!report || (!occInfo && !mrInfo));
  if (flags["from-metal-roughness"] && occInfo && mrInfo && occInfo.index !== mrInfo.index) run.warn("the map is already on and is not the metallicRoughness texture; --from-metal-roughness ignored, patching the existing map");
  if (!occInfo && !specularOnly) {
    if (!mrInfo) throw new Error("material " + materialName + " has no occlusion map and no metallicRoughness texture to take one from: this car takes vertex-shading (the no-map branch)" + (spec0 ? "; --reset-specular on its own still works here" : ""));
    if (!flags["from-metal-roughness"] && !report) throw new Error("material " + materialName + " has no occlusion map; pass --from-metal-roughness to use its metallicRoughness texture's R");
    occInfo = { index: mrInfo.index, ...(mrInfo.texCoord ? { texCoord: mrInfo.texCoord } : {}) };
    reenabled = !report;
  }
  /* Drops KHR_materials_specular from the material; the extension stays listed
     while any other material still uses it. Returns whether anything changed. */
  const resetSpecular = () => {
    if (!(matJson.extensions && matJson.extensions.KHR_materials_specular)) { run.log("material " + materialName + " has no KHR_materials_specular to reset"); return false; }
    delete matJson.extensions.KHR_materials_specular;
    if (!Object.keys(matJson.extensions).length) delete matJson.extensions;
    const stillUsed = glb.json.materials.some((m) => m.extensions && m.extensions.KHR_materials_specular);
    if (!stillUsed) for (const list of ["extensionsUsed", "extensionsRequired"]) {
      if (glb.json[list]) { glb.json[list] = glb.json[list].filter((e) => e !== "KHR_materials_specular"); if (!glb.json[list].length) delete glb.json[list]; }
    }
    run.log("material " + materialName + ": KHR_materials_specular removed (reflects like the Camry's paint)" + (stillUsed ? "; other materials still use the extension" : ""));
    return true;
  };
  if (specularOnly) {
    if (report) {
      run.log("material " + materialName + (spec0 ? " carries KHR_materials_specular " + JSON.stringify(spec0) + ": --reset-specular would drop it" : " has no KHR_materials_specular: --reset-specular has nothing to do") + "; no occlusion map to report on (this car takes vertex-shading)");
      return run.finish(true);
    }
    if (!resetSpecular()) throw new Error("nothing to do: " + materialName + " has no KHR_materials_specular");
    run.summary.specularReset = true;
    const bytes = buildGlbBytes(glb, new Map());
    if (dryRun) {
      run.summary.bytesWouldBe = bytes.length;
      run.log("dry run: the reset would write " + bytes.length + " bytes (" + (bytes.length - run.bytesIn >= 0 ? "+" : "") + (bytes.length - run.bytesIn) + ")");
      return run.finish(true);
    }
    fs.writeFileSync(outPath, bytes);
    run.output = outPath;
    run.log("wrote " + outPath + " (" + bytes.length + " bytes)");
    return run.finish(true);
  }
  /* The map's image. Two kinds of problem: one that stops it being READ (a
     JPEG -- the Camry's -- or an external file: only an embedded PNG is
     decoded here) and one that only stops it being WRITTEN (the image is
     also a colour map, or a grey PNG shared with metallicRoughness, where R
     cannot change alone). A write or a dry run refuses either up front, as
     before. --report refuses neither until it has said what it can: it used
     to fail on the Camry's JPEG before a single line about the car, though
     the parts, the --seams auto table and the gap widths need geometry
     only. A write problem is a warning there (the map is still measured); an
     unreadable map skips the map's own numbers and ends the report with the
     refusal. */
  const imageIndex = glb.json.textures[occInfo.index].source;
  const imageJson = glb.json.images[imageIndex];
  const unreadable = imageJson.mimeType !== "image/png" || imageJson.bufferView === undefined
    ? "the occlusion map is " + (imageJson.mimeType || imageJson.uri) + "; only an embedded PNG can be patched losslessly" : null;
  if (unreadable && !report) throw new Error(unreadable);
  const usesImage = (info) => info && glb.json.textures[info.index].source === imageIndex;
  const colourUsers = glb.json.materials.filter((m) => usesImage(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture) || usesImage(m.emissiveTexture));
  const writeProblems = [];
  if (colourUsers.length) writeProblems.push("the map is also a colour map on " + colourUsers.map((m) => m.name).join(", ") + "; patching R would change its colour");
  const img = unreadable ? null : decodePng(viewBytes(glb, imageJson.bufferView));
  if (img && img.channels < 3 && !img.palette && glb.json.materials.some((m) => usesImage(m.pbrMetallicRoughness && m.pbrMetallicRoughness.metallicRoughnessTexture))) {
    writeProblems.push("the map is a grey PNG shared with metallicRoughness; R cannot change alone");
  }
  if (writeProblems.length && !report) throw new Error(writeProblems[0]);
  for (const w of writeProblems) run.warn("a write would refuse: " + w);
  const before = img ? cloneImg(img) : null;
  run.summary.map = img ? { width: img.width, height: img.height, colorType: img.colorType, bytesBefore: viewBytes(glb, imageJson.bufferView).byteLength } : { mimeType: imageJson.mimeType || null, uri: imageJson.uri || null };
  run.log(fileName + ": material " + materialName + ", occlusion map " + (img ? img.width + "x" + img.height + " PNG colour type " + img.colorType : imageJson.mimeType || imageJson.uri) + (mapWasOn ? " (on)" : report ? " (OFF: metallicRoughness R would be used)" : " (re-enabled from metallicRoughness)"));
  if (marker) run.log("marker: patched by " + TOOL + " v" + marker.version + " on " + marker.date + " -- " + JSON.stringify(marker));

  // ---- gather triangles -----------------------------------------------------
  /* Decoded only to measure; nothing read here is written back. Nearest texel at
     the centroid UV, repeat wrap, glTF's top-left UV origin. */
  const tris = [];
  const world = [];
  const io = await createIO({ encoder: false });
  const doc = await io.read(inPath);
  {
    const mat = doc.getRoot().listMaterials()[matIndex];
    const uvSet = occInfo.texCoord || 0;
    const v = [0, 0, 0], w = [0, 0];
    const nodes = doc.getRoot().listNodes();
    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      const mesh = node.getMesh();
      if (!mesh) continue;
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
        const pos = prim.getAttribute("POSITION");
        if (!pos) continue;
        const idx = prim.getIndices();
        const arr = idx ? idx.getArray() : null;
        const n = arr ? arr.length : pos.getCount();
        for (let i = 0; i < n; i++) { const p = xform(m, pos.getElement(arr ? arr[i] : i, v)); world.push(p[0], p[1], p[2]); }
        if (prim.getMaterial() !== mat) continue;
        const uv = prim.getAttribute("TEXCOORD_" + uvSet), nrm = prim.getAttribute("NORMAL");
        if (!uv) continue;
        if (behind && !nrm && seamArg) throw new Error("--seam-behind (the default) needs vertex normals, and a " + materialName + " primitive on " + (node.getName() || mesh.getName()) + " has none; pass --no-seam-behind");
        for (let i = 0; i < n; i += 3) {
          const corners = [], uvs = [], c = [0, 0, 0];
          let cu = 0, cv = 0;
          const normals = nrm ? [] : null;
          for (let k = 0; k < 3; k++) {
            const vi = arr ? arr[i + k] : i + k;
            const p = xform(m, pos.getElement(vi, v));
            corners.push(p);
            c[0] += p[0] / 3; c[1] += p[1] / 3; c[2] += p[2] / 3;
            const t = uv.getElement(vi, w);
            uvs.push([t[0], t[1]]);
            cu += t[0] / 3; cv += t[1] / 3;
            if (nrm) normals.push(xformDir(m, nrm.getElement(vi, [0, 0, 0])));
          }
          tris.push({ corners, uvs, normals, c, ao: img ? readR(img, texelAt(img, cu, cv)) / 255 : NaN, part: node.getName() || mesh.getName() || "?", node: ni });
        }
      }
    }
    run.log(tris.length + " triangles use " + materialName + " (TEXCOORD_" + uvSet + ")");
  }
  if (!tris.length) throw new Error("no triangle uses " + materialName);
  /* Parts are node names, split by node only where two nodes share one
     (lib/shade-geom.mjs splitSharedPartNames); unique names stay as they were,
     so the Altima and the Sentra patch byte for byte as before. */
  const sharedNames = splitSharedPartNames(tris);
  if (sharedNames.length) {
    run.summary.sharedPartNames = sharedNames;
    run.log("parts: " + sharedNames.map((x) => '"' + x.name + '" names ' + x.nodes + " nodes").join(", ") + " -- each node is its own part (name@node index)");
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t.corners) grow(lo, hi, p);
  const modelSize = Math.max(...hi.map((h, k) => h - lo[k]));
  // No map read (a JPEG under --report): ao is NaN and nothing is dark.
  const clusters = clusterByCorners(tris.filter((t) => t.ao < DARK), modelSize / 20000);
  const topClusters = () => [...clusters].sort((a, b) => b.n - a.n).slice(0, CLUSTERS_IN_SUMMARY).map((cl) => clusterRow(cl, pocket));

  // ---- scale and parts --------------------------------------------------------
  let mmPerUnit = flags["mm-per-unit"] !== undefined ? Number(flags["mm-per-unit"]) : null;
  let scaleSource = mmPerUnit ? "--mm-per-unit" : null;
  if (flags["car-length-mm"] !== undefined) {
    const L = Number(flags["car-length-mm"]);
    if (!(L > 0)) throw new UsageError("--car-length-mm wants the car's length in mm");
    const s = mmPerUnitFromLength(lo, hi, L);
    mmPerUnit = s.mmPerUnit;
    scaleSource = "--car-length-mm " + L + " over the paint's " + s.axis + " extent " + s.units.toPrecision(5);
  }
  if (mmPerUnit !== null && !(mmPerUnit > 0)) throw new UsageError("--mm-per-unit wants a positive number");
  if (seamArg && !mmPerUnit) throw new UsageError("--seams needs the scale: --mm-per-unit n or --car-length-mm n");
  if (mmPerUnit) run.log("scale: " + mmPerUnit.toFixed(2) + " mm per unit (" + scaleSource + "), paint " + (Math.max(...hi.map((h, k) => h - lo[k])) * mmPerUnit / 1000).toFixed(3) + " m long");
  const partNames = [...new Set(tris.map((t) => t.part))];
  const partArea = new Map(partNames.map((n) => [n, 0]));
  for (const t of tris) partArea.set(t.part, partArea.get(t.part) + triArea(t.corners[0], t.corners[1], t.corners[2]));
  const auto = autoSeamParts(partNames.map((name) => ({ name, area: partArea.get(name) })));
  const seamParts = !seamArg ? () => false
    : seamArg.includes("auto") ? (part) => auto.listed.has(part)
    : seamArg.includes("all") ? () => true
    : (part) => seamArg.some((s) => part.includes(s));
  if (seamArg) {
    const listedNames = partNames.filter(seamParts);
    const unmatched = seamArg.filter((s) => s !== "all" && s !== "auto" && !partNames.some((p) => p.includes(s)));
    if (unmatched.length) throw new Error("--seams terms match no part of " + materialName + ": " + unmatched.join(", ") + " (parts: " + partNames.join(", ") + ")");
    if (listedNames.length < 2) run.warn("only " + listedNames.length + " listed part(s): a seam needs two, so no line will be drawn (a body in ONE node has no second part to measure against)");
    run.summary.seams = { arg: seamArg.join(","), parts: listedNames, curve: CURVE, reachMm: REACH_MM, profileScale, seamBehind: behind, mmPerUnit: r3(mmPerUnit), scaleSource };
  }

  // ---- pocket, seams, profile -----------------------------------------------
  /* The pocket: triangles centred in the box, minus dark clusters crossing its
     edge; the fill is the median AO of the material's triangles in the box grown
     by its largest side, outside the box itself. The texels to lift are
     those under `image`'s fill (the map as read: the pocket goes first). */
  const planPocket = (box, image) => {
    const passing = new Set(clusters.filter((cl) => clusterTouches(cl, box) && !clusterInside(cl, box)).flatMap((cl) => cl.members));
    const inside = tris.filter((t) => within(box, t.c) && !passing.has(t));
    const g = Math.max(...box.max.map((m, k) => m - box.min[k]));
    const grown = { min: box.min.map((m) => m - g), max: box.max.map((m) => m + g) };
    const ring = tris.filter((t) => !within(box, t.c) && within(grown, t.c)).map((t) => t.ao).sort((a, b) => a - b);
    const fill = ring.length ? ring[ring.length >> 1] : 1;
    const texels = new Set();
    for (const t of inside) rasterize(t.uvs, image.width, image.height, 2, (i) => { if (readR(image, i) < fill * 255) texels.add(i); });
    return { inside, ringCount: ring.length, fill, texels };
  };
  /* --seam-behind: full weight in front of or beside the surface, fading out as
     the neighbour goes behind it (-0.35 to -0.7 of the outward normal). */
  const sidewaysWeight = (s) => Math.max(0, Math.min(1, (s + 0.7) / 0.35));
  /* The seam band: for every texel under a listed part's triangle near another
     listed part, the curve's factor at its surface point; the smallest wins.
     V = { reachMm, factorAt }: the flags' curve, or a seeded variant's. */
  const planSeams = (V) => {
    const { factorAt } = V;
    const listed = tris.filter((t) => seamParts(t.part));
    const reach = V.reachMm / mmPerUnit;
    const nearest = partGrid(listed, reach * 2);
    const factor = new Map(), fromBehind = new Set();
    let near = 0;
    for (const t of listed) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const p of t.corners) grow(mn, mx, p);
      const centre = mn.map((m, k) => (m + mx[k]) / 2);
      const span = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 + reach;
      if (nearest(centre, t.part, span) >= span) continue;
      near++;
      rasterize(t.uvs, img.width, img.height, 1, (i, w) => {
        const p = [0, 1, 2].map((k) => w[0] * t.corners[0][k] + w[1] * t.corners[1][k] + w[2] * t.corners[2][k]);
        let f, winnerSide = 0;
        const n = t.normals ? [0, 1, 2].map((k) => w[0] * t.normals[0][k] + w[1] * t.normals[1][k] + w[2] * t.normals[2][k]) : null;
        const len = n ? Math.hypot(n[0], n[1], n[2]) || 1 : 1;
        const sideOf = (q, d) => (n && d > 0 ? ((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / (d * len) : 0);
        if (behind) {
          // Outward normal at the texel; every neighbour in reach is weighed by
          // where it lies along it, and the strongest (darkest) factor wins.
          f = 1;
          nearest.each(p, t.part, reach, (q, d) => {
            if (!(d < reach)) return;
            const side = sideOf(q, d);
            const weight = sidewaysWeight(side);
            if (weight <= 0) return;
            const g = 1 - weight * (1 - factorAt(d * mmPerUnit));
            if (g < f) { f = g; winnerSide = side; }
          });
          if (f >= 1) return;
        } else {
          const { d, q } = nearest.closest(p, t.part, reach);
          if (!(d < reach)) return;
          f = factorAt(d * mmPerUnit);
          winnerSide = sideOf(q, d);
        }
        const prev = factor.get(i);
        if (prev === undefined || f < prev) {
          factor.set(i, f);
          // Darkened by a part UNDER the skin: the Altima's crease.
          if (winnerSide < -0.35 && 1 - f > 0.1) fromBehind.add(i); else fromBehind.delete(i);
        }
      });
    }
    return { factor, near, listed: listed.length, fromBehind: fromBehind.size };
  };
  /* The map's profile by distance from the nearest other part, as ratios to its
     open panel -- the same buckets the Camry was measured with. */
  const profile = (image) => {
    const nearest = partGrid(tris, (PROFILE_REACH_MM / mmPerUnit) * 2);
    const sum = new Array(10).fill(0), cnt = new Array(10).fill(0);
    tris.forEach((t, ti) => {
      for (let s = 0; s < 6; s++) {
        let r1 = ((ti * 7 + s * 13) % 97) / 97, r2 = ((ti * 11 + s * 29) % 89) / 89;
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const r0 = 1 - r1 - r2;
        const p = [0, 1, 2].map((k) => r0 * t.corners[0][k] + r1 * t.corners[1][k] + r2 * t.corners[2][k]);
        const u = r0 * t.uvs[0][0] + r1 * t.uvs[1][0] + r2 * t.uvs[2][0], v = r0 * t.uvs[0][1] + r1 * t.uvs[1][1] + r2 * t.uvs[2][1];
        const dmm = nearest(p, t.part, PROFILE_REACH_MM / mmPerUnit) * mmPerUnit;
        let b = 9;
        for (let i = 0; i < 9; i++) if (dmm < PROFILE_EDGES[i]) { b = i; break; }
        sum[b] += readR(image, texelAt(image, u, v)) / 255;
        cnt[b]++;
      }
    });
    const open = sum[9] / cnt[9];
    return PROFILE_LABELS.map((label, i) => ({ label, n: cnt[i], mean: cnt[i] ? sum[i] / cnt[i] : NaN, ratio: cnt[i] ? sum[i] / cnt[i] / open : NaN, camry: CAMRY_RATIOS[i] }));
  };
  /* Run-once signature: the listed parts' mean shade within 3 mm of another
     listed part against their open panel (>= 20 mm), on the given image. */
  const bandRatio = (image) => {
    const listed = tris.filter((t) => seamParts(t.part));
    const nearest = partGrid(listed, (20 / mmPerUnit) * 2);
    let bs = 0, bn = 0, os = 0, on = 0;
    listed.forEach((t, ti) => {
      for (let s = 0; s < 6; s++) {
        let r1 = ((ti * 7 + s * 13) % 97) / 97, r2 = ((ti * 11 + s * 29) % 89) / 89;
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const r0 = 1 - r1 - r2;
        const p = [0, 1, 2].map((k) => r0 * t.corners[0][k] + r1 * t.corners[1][k] + r2 * t.corners[2][k]);
        const u = r0 * t.uvs[0][0] + r1 * t.uvs[1][0] + r2 * t.uvs[2][0], v = r0 * t.uvs[0][1] + r1 * t.uvs[1][1] + r2 * t.uvs[2][1];
        const dmm = nearest(p, t.part, 20 / mmPerUnit) * mmPerUnit;
        const val = readR(image, texelAt(image, u, v)) / 255;
        if (dmm < 3) { bs += val; bn++; } else if (!(dmm < 20)) { os += val; on++; }
      }
    });
    return bn && on ? bs / bn / (os / on) : NaN;
  };
  /* The data checks on an image: what a camera looking straight down each
     seam sees (lib/shade-checks.mjs). */
  const shadeFrom = (image) => (i, u, w) => {
    const t = tris[i], a = 1 - u - w;
    return sampleR(image, a * t.uvs[0][0] + u * t.uvs[1][0] + w * t.uvs[2][0], a * t.uvs[0][1] + u * t.uvs[1][1] + w * t.uvs[2][1]);
  };
  const worldTris = new Float32Array(world);
  const measure = (image, baseImage, reachMm = REACH_MM) => seamCheck({ tris, world: worldTris, listed: seamParts, mmPerUnit, reachMm, shade: shadeFrom(image), base: baseImage ? shadeFrom(baseImage) : null });
  const metricLine = (m) => "seams " + m.profiles + " (of " + m.anchors + " cells): doubled " + (100 * m.doubled4).toFixed(1) + "% / creased " + (100 * m.crease4).toFixed(1) + "% / no line " + (100 * m.flat).toFixed(1) + "% at a phone pixel; depth " + r3(m.depth4) + " (close-up " + r3(m.depth1) + "), width " + r3(m.width4) + " mm (close-up " + r3(m.width1) + " mm); panel " + r3(m.panel) + ", specks " + (100 * m.specks).toFixed(2) + "%";

  const pctS = (x) => (100 * x).toFixed(1) + "%";
  /* The shape of the line, on a map that has one: the same limits a write
     must pass, so --report is also the health check of a shipped file. */
  const lineChecks = (m, reachMm = REACH_MM) => {
    run.check("seam-single-line", m.doubled4 <= TARGETS.doubled4, pctS(m.doubled4) + " of " + m.profiles + " seams show two dips at a phone pixel (limit " + pctS(TARGETS.doubled4) + "; Camry 1.8%)" + (m.doubledAt.length ? "; e.g. at " + JSON.stringify(m.doubledAt.slice(0, 3)) : ""));
    const dipsN = profileDips(m.medianProfile4);
    run.check("seam-profile-v", dipsN === 1, "the median seam profile at a phone pixel has " + dipsN + " dip(s): " + m.medianProfile4.join(" "));
    run.check("seam-no-crease", m.crease4 <= TARGETS.crease4, pctS(m.crease4) + " show a second dip beyond " + reachMm + " mm (limit " + pctS(TARGETS.crease4) + "; Camry 2.9%)");
    run.check("seam-coverage", m.flat <= TARGETS.flat, pctS(m.flat) + " of seams have no visible line (limit " + pctS(TARGETS.flat) + "; Camry 17%, unpatched Altima 23%, Sentra 64%)");
    run.check("seam-depth", m.depth4 >= TARGETS.depth4[0] && m.depth4 <= TARGETS.depth4[1], "median depth " + r3(m.depth4) + " at a phone pixel (range " + TARGETS.depth4.join("-") + "; accepted Altima/Sentra 0.58/0.54)");
    run.check("seam-width", m.width1 <= TARGETS.width1, "median close-up width " + r3(m.width1) + " mm (limit " + TARGETS.width1 + "; accepted Altima/Sentra 13/12.5)");
  };

  // ---- report ---------------------------------------------------------------
  if (report) {
    run.log("material bounds " + f5(lo) + " -> " + f5(hi));
    if (img) {
      const listedCl = clusters.filter((cl) => !pocket || clusterTouches(cl, pocket)).sort((a, b) => b.n - a.n);
      run.log("dark clusters (centroid AO < " + DARK + "): " + clusters.length + (pocket ? ", " + listedCl.length + " touching the pocket" : ", largest first"));
      for (const cl of listedCl.slice(0, pocket ? 30 : 12)) {
        run.log("  " + (pocket ? (clusterInside(cl, pocket) ? "POCKET " : "   -   ") : "") + "tris=" + String(cl.n).padStart(5) + "  meanAO=" + (cl.ao / cl.n).toFixed(2) + "  bounds " + f5(cl.min) + " -> " + f5(cl.max));
      }
      run.summary.clusters = topClusters();
    }
    if (pocket && img) {
      const plan = planPocket(pocket, img);
      run.log("pocket " + f5(pocket.min) + " -> " + f5(pocket.max) + ": " + plan.inside.length + " triangles, fill " + plan.fill.toFixed(3) + " (median of " + plan.ringCount + " around it), would lift " + plan.texels.size + " texels" + (plan.texels.size ? "" : " (already lifted)"));
      run.summary.pocket = { triangles: plan.inside.length, fill: r3(plan.fill), wouldLift: plan.texels.size };
    }
    run.log("auto seam parts (--seams auto):");
    for (const r of auto.rows) run.log("  " + (auto.listed.has(r.name) ? "AUTO  " : "      ") + (100 * r.pct).toFixed(2).padStart(6) + "%  " + r.name + "  (" + r.why + ")");
    run.summary.autoParts = [...auto.listed];
    if (mmPerUnit) {
      const nearest = partGrid(tris, (PROFILE_REACH_MM / mmPerUnit) * 2);
      run.log("parts (distance from each part's corners to the nearest other part, mm):");
      for (const part of partNames) {
        const own = tris.filter((t) => t.part === part);
        const ds = [];
        for (const t of own) for (const p of t.corners) { const d = nearest(p, part, PROFILE_REACH_MM / mmPerUnit); if (d < Infinity) ds.push(d * mmPerUnit); }
        ds.sort((a, b) => a - b);
        const pc = (q) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(q * ds.length))].toFixed(1) : "-");
        run.log("  " + (seamParts(part) ? "SEAMS " : "      ") + "tris=" + String(own.length).padStart(6) + "  corners within 40 mm=" + String(ds.length).padStart(6) + "  p5 " + pc(0.05) + "  p25 " + pc(0.25) + "  p50 " + pc(0.5) + "  " + part);
      }
    }
    if (mmPerUnit && img) {
      run.log("map profile by distance from the nearest other part (ratio to the open panel), Camry averages beside it (diagnostic only):");
      for (const r of profile(img)) run.log("  " + r.label.padEnd(12) + " samples " + String(r.n).padStart(6) + "  mean " + (isNaN(r.mean) ? "  - " : r.mean.toFixed(2)) + "  ratio " + (isNaN(r.ratio) ? "  - " : r.ratio.toFixed(2)) + "  | Camry " + r.camry.toFixed(2));
      if (seamArg) {
        const br = bandRatio(img);
        run.summary.bandRatio = r3(br);
        run.log("seam band (listed parts, < 3 mm) against the open panel: " + r3(br) + (br < SEAMED_BAND_RATIO ? " -- ALREADY SEAMED (a write would refuse without --force)" : " -- no seam lines yet"));
        const m = measure(img, null);
        run.summary.current = m;
        run.log("current map: " + metricLine(m));
        run.log("  median seam profile at a phone pixel, 1 mm apart: " + m.medianProfile4.join(" "));
        // Health: a map with lines is judged as a write would be; one without says so.
        const seamed = br < SEAMED_BAND_RATIO || !!marker;
        run.check("seam-lines-present", seamed, seamed ? "the map carries seam lines" + (marker ? " (marker " + marker.date + ")" : " (band/open " + r3(br) + ")") : "no seam lines drawn yet (band/open " + r3(br) + "): the Camry look needs --seams (--dry-run previews the patch and its checks)");
        if (seamed) lineChecks(m);
      }
    }
    run.summary.state = { mapOn: mapWasOn, marker: !!marker, seamed: run.summary.bandRatio !== undefined ? run.summary.bandRatio < SEAMED_BAND_RATIO : null };
    if (unreadable) {
      run.log("the map itself was not read (the parts, the auto table and the gap widths above need geometry only)");
      return run.finish(false, unreadable);
    }
    return run.finish(true);
  }

  // ---- run-once guard -------------------------------------------------------
  if (seamArg) {
    const br = bandRatio(img);
    run.summary.seams.bandRatioBefore = r3(br);
    const why = marker ? "its material carries this tool's marker (" + marker.date + ")" : br < SEAMED_BAND_RATIO ? "its map is already darker along these seams than a native bake (band/open " + r3(br) + " < " + SEAMED_BAND_RATIO + "; unpatched maps read 0.85-1.05)" : null;
    if (why) {
      if (!flags.force) throw new Error(fileName + " looks patched already: " + why + ". A second pass darkens the band again; start from the unpatched file or pass --force" + (pocket ? "; a --pocket alone (without --seams) is not refused" : "") + (dryRun ? " (--report without --dry-run is the health check of the lines it has)" : "") + ".");
      run.warn("patching again (--force) although " + why);
    }
  }

  // ---- patch ----------------------------------------------------------------
  /* One patch, in two halves: applyPatch lifts the pocket and draws the seams
     on `image` in place, checkPatch makes the self-checks on the result.
     P = { box, curve, profileScale, reachMm, factorAt }: the flags' (a plain
     run, on the map itself) or a seeded variant's (on a fresh copy of the map
     as read, so variants never stack). Their summary goes to `sum`:
     run.summary on a plain run, the variant's own until it is chosen. */
  const applyPatch = (P, image, sum) => {
    let mapChanged = false;
    let pocketPlan = null, seamFromBehind = null;
    if (P.box) {
      pocketPlan = planPocket(P.box, image);
      if (!pocketPlan.inside.length) throw new Error("no " + materialName + " triangle is inside the pocket -- writing nothing (run --report)");
      const write = makeWriter(image);
      let lifted = 0;
      for (const i of pocketPlan.texels) { const b = readR(image, i); write(i, pocketPlan.fill * 255); if (readR(image, i) > b) lifted++; }
      mapChanged = mapChanged || lifted > 0;
      sum.pocket = { triangles: pocketPlan.inside.length, fill: r3(pocketPlan.fill), texelsLifted: lifted };
      run.log("pocket: " + pocketPlan.inside.length + " triangles, " + lifted + " texels lifted to AO " + pocketPlan.fill.toFixed(3) + " (median of " + pocketPlan.ringCount + " triangles around it)");
    }
    if (seamArg) {
      const t0 = Date.now();
      const { factor, near, listed, fromBehind } = planSeams(P);
      seamFromBehind = { texels: fromBehind, of: factor.size };
      const write = makeWriter(image);
      let darkened = 0;
      for (const [i, f] of factor) { const b = readR(image, i); write(i, b * f); if (readR(image, i) < b) darkened++; }
      mapChanged = mapChanged || darkened > 0;
      Object.assign(sum.seams, { listedTriangles: listed, nearTriangles: near, bandTexels: factor.size, texelsDarkened: darkened });
      run.log("seams: " + listed + " listed triangles, " + near + " within " + P.reachMm + " mm of another part, " + factor.size + " texels in the band, " + darkened + " darkened by the seam curve" + (P.profileScale !== 1 ? " x" + P.profileScale : "") + (behind ? "" : " (--no-seam-behind)") + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    }
    return { mapChanged, pocketPlan, seamFromBehind };
  };

  // ---- self-checks ----------------------------------------------------------
  const checkPatch = (P, image, sum, { pocketPlan, seamFromBehind }) => {
    if (pocketPlan) {
      let dark = 0;
      for (const t of pocketPlan.inside) {
        let s = 0, n = 0;
        rasterize(t.uvs, image.width, image.height, 0, (i) => { s += readR(image, i) / 255; n++; });
        if (n && s / n < pocketPlan.fill * 0.9) dark++;
      }
      run.check("pocket-lifted", dark === 0, dark + " of " + pocketPlan.inside.length + " pocket triangles still under 90% of the fill " + pocketPlan.fill.toFixed(3));
    }
    if (seamArg) {
      const t0 = Date.now();
      const m = measure(image, before, P.reachMm);
      sum.seams.bandRatioAfter = r3(bandRatio(image));
      sum.checkMetrics = m;
      run.log("after: " + metricLine(m) + " (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
      run.log("  median seam profile at a phone pixel, 1 mm apart: " + m.medianProfile4.join(" "));
      lineChecks(m, P.reachMm);
      const shift = Math.abs(m.panel / m.panelBase - 1);
      const hid = seamFromBehind.of ? seamFromBehind.texels / seamFromBehind.of : 0;
      run.check("no-hidden-flange-lines", hid <= TARGETS.fromBehind, pctS(hid) + " of the band's texels are darkened by a part under the skin (limit " + pctS(TARGETS.fromBehind) + "; the accepted Altima 5.1%, its crease without --seam-behind 26.7%)");
      run.check("panel-tone", shift <= TARGETS.panelShift, "panel median " + r3(m.panelBase) + " -> " + r3(m.panel) + " (" + (100 * shift).toFixed(1) + "%, limit " + 100 * TARGETS.panelShift + "%)");
      const newSpecks = m.specks - m.specksBase;
      run.check("no-new-specks", newSpecks <= TARGETS.newSpecks, "interior samples under half the panel " + pctS(m.specksBase) + " -> " + pctS(m.specks) + " (limit +" + 100 * TARGETS.newSpecks + " points)");
    }
  };

  /* What gets written, and the marker's settings: the flags' patch on the map
     itself, or the chosen variant's on its copy. */
  const replacements = new Map();
  let patch = { box: pocket, curve: CURVE, profileScale, reachMm: REACH_MM, factorAt };
  let outImg = img, mapChanged = false, variation = null;
  if (!useSeed) {
    const done = applyPatch(patch, img, run.summary);
    mapChanged = done.mapChanged;
    checkPatch(patch, img, run.summary, done);
  } else {
    // ---- seeded variants (--seed) -------------------------------------------
    /* The ranges, each bounded around the calibrated patch -- the curve
       0:0.45,3:0.45,6:1 at --profile-scale 1, which drew the Altima's and
       the Sentra's accepted lines (door-seam contrast 20-22 at page size
       against the Camry's 18; depth 0.58 / 0.54, close-up width 13 / 12.5
       mm) -- so every variant is a plausible line and the checks pick among
       them. A flag the caller gave is fixed; every draw is consumed either
       way (lib/variation.mjs), so a seed reads the same with or without it.
         seamCore      0.35-0.55  the factor at the gap (0.45 shipped; 0.3 at
                       the core only overshoots the Camry, and towards 0.6
                       the line sinks into the map's own shading)
         seamCoreMm    2-4 mm     how far the core holds (3 shipped)
         seamFallMm    2-4 mm     the ease back to 1 (3 shipped): a reach of
                       4-8 mm. The map's texel is 4.4-5.3 mm, so a shorter
                       reach leaves holes in the line, and a longer one widens
                       it towards the 18 mm close-up limit (a faint shoulder
                       out to 4 cm overshot the Camry)
         profileScale  0.85-1.15  deepens or lightens the whole curve; with the
                       core, the darkest factor runs 0.25-0.62 around the
                       shipped 0.45 (the dark end is the depth check's to
                       refuse: its limit, 0.75, sits about there)
         pocketPad     0-0.15     (--pocket only) each side of the box moved out
                       by this share of the box's own length along that axis
                       (at 0.15 the Sentra's shipped box grows 120 mm wider,
                       32 mm taller, 8 mm deeper): more takes in the recess's
                       rim, where its baked shadow fades out. Per axis, not by
                       the largest side as the page pads a cluster's box: that
                       grows a plate recess's thin depth as much as its width,
                       and 8% of it already doubled the Sentra's pocket (382
                       triangles to 814), lifting the boot lid around it.
                       Never smaller than the box given, which would leave
                       the recess's edge dark.
       --seams, the scale and --seam-behind are not varied: which gaps, the
       car's size and the guard. The checks above are the gate, unchanged. */
    const curveFixed = !!flags.curve;
    const drawPatch = (draw) => {
      const noCurve = !seamArg || curveFixed;
      const core = draw.uniform("seamCore", 0.35, 0.55, { step: 0.01, unused: noCurve });
      const coreMm = draw.uniform("seamCoreMm", 2, 4, { step: 0.5, unused: noCurve });
      const fallMm = draw.uniform("seamFallMm", 2, 4, { step: 0.5, unused: noCurve });
      const scale = draw.uniform("profileScale", 0.85, 1.15, { step: 0.01, fixed: flags["profile-scale"] !== undefined ? profileScale : undefined, unused: !seamArg }) ?? profileScale;
      const pad = draw.uniform("pocketPad", 0, 0.15, { step: 0.01, unused: !pocket });
      const curve = noCurve ? CURVE : [[0, core], [coreMm, core], [+(coreMm + fallMm).toFixed(1), 1]];
      let box = null;
      if (pocket) {
        const g = pocket.max.map((m, k) => pad * (m - pocket.min[k]));
        box = { min: pocket.min.map((m, k) => m - g[k]), max: pocket.max.map((m, k) => m + g[k]) };
        draw.params.pocket = [...box.min, ...box.max].map(sig6).join(",");
      }
      if (seamArg) {
        draw.params.curve = curve.map((p) => p.join(":")).join(",");
        if (curveFixed) draw.fixed.push("curve");
      }
      return { box, curve, profileScale: scale, reachMm: curve[curve.length - 1][0], factorAt: makeFactor(curve, scale) };
    };
    /* A padded box only takes in more triangles than the box given, so a box
       that holds none is the plain run's error, before any variant. */
    if (pocket && !planPocket(pocket, img).inside.length) throw new Error("no " + materialName + " triangle is inside the pocket -- writing nothing (run --report)");
    run.log("--seed " + seed + ": up to " + tries + " variant" + (tries === 1 ? "" : "s") + ", the first that passes every check is " + (dryRun ? "previewed" : "written"));
    const res = await runVariants({
      seed, tries, label: "variant", log: (s) => run.log(s),
      attempt: async (draw, info) => {
        const P = drawPatch(draw);
        const image = cloneImg(img);
        const sum = seamArg ? { seams: { ...run.summary.seams } } : {};
        let dup = 0, done = null;
        const held = await run.collect(() => {
          done = applyPatch(P, image, sum);
          // The same map as an earlier variant: the same file, so draw again.
          dup = info.duplicateOf(fingerprint(image.px));
          if (!dup) checkPatch(P, image, sum, done);
        });
        if (dup) return { duplicate: dup };
        return { failed: held.failed, P, image, sum, held, done };
      },
    });
    const pick = res.chosen || res.closest;
    variation = res.summary;
    run.summary.variation = variation;
    if (!pick) return run.finish(false, noVariantMessage(res, seed, tries), 3);
    const { P, image, sum, held, done } = pick.result;
    run.replay(held);
    if (sum.pocket) run.summary.pocket = sum.pocket;
    if (seamArg) {
      run.summary.seams = Object.assign(sum.seams, { curve: P.curve, reachMm: P.reachMm, profileScale: P.profileScale });
      run.summary.checkMetrics = sum.checkMetrics;
    }
    patch = P; outImg = image; mapChanged = done.mapChanged;
    run.log("variant " + (res.chosen ? pick.k + " of " + tries + " passed" : "none passed; the closest is " + pick.k) + " (seed " + seed + (pick.k > 1 ? ", sub-seed " + pick.subSeed : "") + ")");
    if (!res.chosen) {
      if (dryRun || !flags.force) return run.finish(false, noVariantMessage(res, seed, tries), 3);
      run.warn("no variant passed (seed " + seed + "); writing the closest, attempt " + pick.k + " (--force)");
    }
  }

  // ---- write ----------------------------------------------------------------
  if (dryRun) run.summary.clusters = topClusters(); // as the map was read, before this run's patch
  if (mapChanged) {
    const png = encodePng(outImg);
    replacements.set(imageJson.bufferView, png);
    run.summary.map.bytesAfter = png.length;
    run.log("map PNG " + run.summary.map.bytesBefore + " -> " + png.length + " bytes");
  }
  if (reenabled) {
    matJson.occlusionTexture = occInfo;
    run.log("material " + materialName + " now uses texture " + occInfo.index + " as its occlusion map");
  }
  run.summary.reenabled = reenabled;
  const specularReset = flags["reset-specular"] ? resetSpecular() : false;
  run.summary.specularReset = specularReset;
  if (!mapChanged && !reenabled && !specularReset) throw new Error("nothing to do" + (pocket && !seamArg ? " (the pocket is already lifted)" : ""));
  if (run.failed.length && !flags.force && !dryRun) {
    return run.finish(false, "checks failed (" + run.failed.map((c) => c.name).join(", ") + "); nothing written. Pass --force to write anyway.", 3);
  }
  if (run.failed.length) run.warn((dryRun ? (flags.force ? "a write would go ahead despite failed checks (--force): " : "a write would refuse without --force; failed checks: ") : "writing despite failed checks (--force): ") + run.failed.map((c) => c.name).join(", "));
  if (seamArg || pocket) {
    /* What the file now carries: a run that only lifts a pocket on a seamed
       map (or only re-seams) keeps the earlier run's other half at the top
       level too, not only under `previous`, so the marker always says what
       the map has. Before, a pocket after the seams left a marker with no
       `seams` in it. A seeded patch records the curve, scale and box it
       drew, and the seed and variant, which reproduce it (--seed N, the
       same input and flags). */
    const carried = {};
    if (marker && !seamArg && marker.seams) for (const k of ["seams", "curve", "profileScale", "seamBehind", "mmPerUnit"]) if (marker[k] !== undefined) carried[k] = marker[k];
    if (marker && !pocket && marker.pocket) carried.pocket = marker.pocket;
    matJson.extras = { ...(matJson.extras || {}), occlusionPatch: {
      version: MARKER_VERSION, date: new Date().toISOString().slice(0, 10),
      ...carried,
      ...(seamArg ? { seams: run.summary.seams.parts, curve: patch.curve, profileScale: patch.profileScale, seamBehind: behind, mmPerUnit: r3(mmPerUnit) } : {}),
      ...(pocket ? { pocket: [...patch.box.min, ...patch.box.max] } : {}),
      ...(variation ? { variation: { seed: variation.seed, attempt: variation.attempt, subSeed: variation.subSeed, params: variation.params } } : {}),
      ...(marker ? { previous: marker } : {}),
    } };
  }
  if (dryRun) {
    const bytes = buildGlbBytes(glb, replacements);
    run.summary.bytesWouldBe = bytes.length;
    run.log("dry run: a write would be " + bytes.length + " bytes (" + (bytes.length - run.bytesIn >= 0 ? "+" : "") + (bytes.length - run.bytesIn) + "); nothing written");
    return run.finish(true);
  }
  writeGlbBytes(outPath, glb, replacements);
  run.output = outPath;
  run.log("wrote " + outPath + " (" + fs.statSync(outPath).size + " bytes)");
  return run.finish(true);
});
