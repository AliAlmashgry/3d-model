#!/usr/bin/env node
/* seat-split: give a car's driver's seat its own material, the way the Camry's
   Driver_Seat_Red was made, so the page's look profile can paint it red.

   Sketchfab exports keep the whole cabin in one material and usually one mesh,
   so the seat has to be carved out geometrically. The cabin primitive is
   still many disconnected SHELLS (seat, headrest, each pillar's trim, the
   headliner, door cards...), so the unit of selection is a shell: triangles
   sharing a vertex (or an identical position) within one primitive. The
   selected triangles go to a new primitive on the same mesh with a new flat
   material named Driver_Seat (the profile's red, no textures -- distinct
   values, so a later `dedup` cannot fold it back into the cabin material).

   Three ways to say which shells, newest first:
     --pick x,y,z  a point on the seat in model space -- what model-viewer's
                   positionAndNormalFromPoint returns when the seat is tapped.
                   It must lie ON a surface: a point more than 1% of the car's
                   length from every surface (mid-air, another model, other
                   units) is refused. The shell under the point seeds a GROWN
                   seat: neighbouring shells join while their surface comes
                   within ~2 voxels (0.3% of the car's length each, ~1.4 cm on
                   a 4.8 m car) of the seat so far and the whole stays the
                   size of one front seat. Shells no seat can contain are
                   refused whatever touches them (lib/seat-find.mjs
                   shellVeto): longer, wider or taller than a seat (door
                   cards, carpet, the console, the headliner), reaching the
                   roof band above 0.93 H (pillars, headliner strips),
                   crossing the centre plane (console, bench, the other seat),
                   reaching past 0.375 W or centred past 0.34 W from the
                   centre plane (door and pillar parts, belt guides), flat on
                   the floor (mats), shaped like a hanging belt strap, or flat
                   and centred within 0.06 W of the centre line (switch panels
                   and buttons on the console). Other materials join only when
                   70% of a shell lies in the seat's footprint column (a back
                   shell or headrest in its own material) -- never just by
                   touching, which is how the Optima's armrest switches crept
                   in one by one. Then whatever lies WHOLLY inboard of the
                   seat's own inboard edge is taken out and the seat grown
                   again without it (seat-find consoleParts): the Sportage
                   2017's seat had grown into the handbrake lever, the
                   gear-lever buttons and the armrest-lid stitching, all
                   within 2 voxels of its inboard bolster (86,782 -> 66,378
                   triangles). An export that names its seat meshes (the
                   Maxima's maxima_seats_FL_*) gets the whole named seat.
     --auto        no point. Every seat-like object either side of the centre
                   plane is grown from the largest shells where a front seat
                   sits; the front row is the best mirror-image pair; the car
                   faces the way the seats do (backrest behind the cushion)
                   and, where the export names one, toward its steering wheel;
                   the driver is on the car's LEFT (left-hand drive: left =
                   up x front). --front +z|-z|+x|-x and --driver left|right
                   override -- but a --front that CONTRADICTS the seats' shape
                   or the wheel fails the driver-side check (it used to be a
                   note, and `--front -z` on the Sentra and the Altima wrote
                   the passenger seat with every check green). When the pair,
                   the front or the side cannot be decided -- no cabin (the
                   Accent), seat shape and wheel disagree, a wheel on the
                   right -- it fails and says which hint or --pick point would
                   settle it; it never guesses.
     --box x0,y0,z0,x1,y1,z1 (+ --exclude, --min-inside, --mode) or --mesh:
                   the original modes, unchanged in meaning: a shell moves
                   when more than --min-inside (0.5) of its triangle centroids
                   are in the box minus the --exclude boxes; --mode tris cuts
                   triangle by triangle; --mesh takes whole meshes/nodes whose
                   name contains the text. One deliberate fix: shells are now
                   welded per primitive by exact position, not across
                   primitives on a size/20000 grid. On a shipped Draco file
                   that grid is coarser than one quantisation step in places
                   and welds neighbouring pieces: on the Sentra it fused a
                   16-triangle piece below the cushion into the 638-triangle
                   seat shell, so the memory note's box + exclude took 850
                   triangles instead of 834 (the Altima's box gives 832
                   either way). See lib/seat-box.mjs.

   Why shells and not a box alone: the headrest tip sits at ~0.9 H and the
   B-pillar trim and headliner (same material) overlap it in height and in
   width, so any box tall enough for the headrest also caught strips of pillar
   and roof -- the Camry's first split painted "a red dot in the mid pillar",
   both Nissans painted the B-pillar and a headliner strip, exclusion boxes
   chased one strip at a time, and the Elantra shipped with its belt strap red
   up the B-pillar. --pick and --auto need no box at all.

   Every selection, whichever mode made it, is held to CHECKS before anything
   is written (lib/seat-find.mjs seatChecks and driverSide, limits measured on
   the five cars split by hand: seat width 0.29-0.31 W, height 0.55-0.69 H,
   top 0.83-0.91 H, door trim from 0.34-0.37 W):
     one-object      the selection is ONE proximity piece; a belt guide on the
                     pillar or a headliner strip caught with it is a second
                     one (the Sentra box without its --exclude, a box whose
                     top was too high)
     seat-size       bounds within a front seat's range for this car
     below-roof      top below the roof band and clear of the headliner above
     inside-walls    nothing past 0.375 W, in the door or pillar
     own-side        nothing past the centre plane, in the other seat's half
     console-clear   nothing wholly between the seat's inboard edge (its
                     largest shells, 85% of its area) and the centre line,
                     above the seat's bottom: the console. Fails the
                     Sportage 2017's first cut (20,404 triangles in 13 shells)
                     and the Elantra's shipped hand cut (a 32-triangle strip
                     of the console side under the armrest)
     triangle-count  30 .. max(20000, 8% of the car), <= 60% of --source
     driver-side     the seat is where the driver sits: the car's left (LHD)
                     by the front row's shape and a named steering wheel, or
                     --driver right. Fails a tap on the passenger seat, a
                     --front that contradicts the model, a wheel on the right
                     without --driver, and (--pick/--auto) a car whose front
                     cannot be told. An old --box/--mesh cut fails only when
                     it is plainly on the other side; when the side cannot be
                     told it is "not judged" (pass, with a warning), so the
                     memory notes' box commands behave as before
     seat-material   the seat lands in the material the page will look for:
                     Driver_Seat, or the name given with --name / kept by
                     --redo / appended to with --append (below); the file had
                     no other seat material left; and that material's textures
                     find the texture coordinates they sample on every
                     primitive the seat is cut from
   If any check fails nothing is written and the exit code is 1, unless
   --force (which writes and says so in warnings[]; a contradicting --front
   is in warnings[] too).

   A file that already has a Driver_Seat-like material is refused unless
   one of these says what to do with it:
     --append  ADD the selection to the existing seat material. Exactly one
               seat material: that one; several: --name says which, or it
               is refused as ambiguous. Triangles already in it stay where
               they are (an --auto on the Camry finds its own red seat again:
               nothing to add, so nothing is written), and the checks judge
               the seat AFTER the append -- old and new triangles together,
               since that is what the page will paint. Until 2026-10 this
               created a second material, Driver_Seat, moved the triangles
               there and left Driver_Seat_Red empty: the Camry lost its red
               seat on the page.
     --redo    hand the old seat's triangles back to the cabin material next
               to them in the same mesh, in memory, then cut again -- for a
               seat cut wrong, like the Elantra's. The seat keeps its NAME:
               --name if given (the lab passes the car's look.seat[0] when it
               is not Driver_Seat), else a lone old seat's own name unless
               that is a near-miss of Driver_Seat (Driver_Seat.001 comes back
               as Driver_Seat, what its registry expects). And when the new
               name is the old one, the old MATERIAL is reused, not rebuilt:
               the Camry's Driver_Seat_Red carries a normal map and an
               occlusion map on TEXCOORD_2/3 that a fresh flat red material
               would drop. A redo that went through Driver_Seat used to ship
               a Camry whose registry still said Driver_Seat_Red -- no red
               seat on the page.
   --name works with every mode (a new cut, --append, --redo); the page's
   registry entry must list the same name in its look.seat.

   --rename-seat renames a lone near-miss (the Corolla's Driver_Seat.001, or
   a case/separator variant) to Driver_Seat by rewriting only the GLB's JSON
   chunk: the BIN chunk is copied byte for byte and nothing is decoded or
   re-encoded (lib/seat-rename.mjs; the Corolla goes 3,634,020 -> 3,634,016
   bytes, the four of ".001"). A name that adds a word, like the Camry's
   Driver_Seat_Red, is not a near-miss and is refused: the Camry's registry
   entry expects exactly that name. --append and --redo mean nothing to a
   rename and are a usage error with it.

   --seed n [--tries k] cuts a VARIANT of the --pick, --auto or --box seat:
   the lab's "Random cut" sends a fresh n per click and "Try another" a new
   one, until the seat looks right (lib/seat-vary.mjs on lib/variation.mjs,
   the PRNG and sub-seeds the gap tools share). WHICH seat is never varied:
   the shell under the tap, and --auto's front row, front and driver's side,
   are settled first exactly as without a seed (seat-find pickPlan /
   autoPlan). What is drawn, within ranges around the calibrated values
   (each range and its reason is in seat-vary), is what decides which
   shells join that seat: the growth's reach (gap and voxel) and size
   envelope, whether and how other materials join (the back plastic, a
   headrest in its own material, the materials growAdaptive adopts), how
   far the console cut reaches in, whether the headrest and small pieces
   (stitching, buttons) stay (a named seat mesh, which the calibrated cut
   takes whole, is grown from like any other seat); for
   --box, the box's faces (+-6% of its size per axis), --min-inside, and
   whether borderline shells are cut by triangle. A flag given (--min-inside,
   --mode, --source) is fixed and the rest vary. The CHECKS below are the
   gate and are never varied: every variant is judged by them at the
   calibrated limits, and the shells shellVeto refuses (pillars, roof band,
   door cards, floor, the other seat) stay refused. A variant also gets one
   check of its own, keeps-seat: it keeps at least 60% of the calibrated
   seat's area (a reshaped seat, not a fragment -- the Maxima's "own
   material only" kept just its plastic back shell, 50%).
     Attempt 1 draws from n, attempt j from a sub-seed of (n, j), up to k
   attempts (default 8, at most 20); the first whose checks all pass is
   written (or reported). An attempt that cuts the same seat as the
   calibrated cut or an earlier attempt -- the same triangles, or at most
   0.25% of the area different -- is a duplicate and the next is drawn, so
   a variant is always a seat "Calibrated" does not give, and one that only
   drops two slivers is not shown as new. None passing: ok:false, exit 1,
   nothing written (--force writes the closest), the error naming the
   closest attempt and its failed checks; every attempt a duplicate: the
   same, saying the seat has few variants (the Camry's is two shells, so
   its only variant is the seat without the headrest). The same n, input
   and flags give the same file, byte for byte.
     The log has one line per attempt. LAB_JSON summary.variation = {seed,
   attempt, subSeed, tries, params, ranges, fixed, rejected: [{attempt,
   subSeed, failed, params, triangles, shells, fingerprint, sameAs,
   areaDiff}], kind: grow|box, label (a few words on how it differs),
   triangles, shells, fingerprint}; on failure attempt is null and
   `closest` says which; a duplicate fails "duplicate" and its sameAs names
   the calibrated cut or the attempt it repeats. The name rules (--name,
   --redo, --append) and the seat's colour are the same for a variant.
   Without --seed nothing changes. --rename-seat, a --mesh cut without
   --box and a report with no selection have nothing to vary: --seed with
   them is a usage error, as is --tries without --seed; a file that already
   has a seat with neither --append nor --redo is refused before any
   variant is drawn (none could pass seat-material).

   A SKINNED export (skins plus JOINTS_0 on its primitives -- what some
   Sketchfab exports are before export-fix) is refused in every mode,
   reports included: the tools read node transforms only, so a skinned car
   can lie on its side in this tool's coordinates while the page shows it
   upright, and a seat cut there is cut in the wrong place. Run Export fixes
   (export-fix --unskin) first, as the recipe orders.

   Usage:
     node tools/seat-split.mjs <in.glb> --report [--box x0,y0,z0,x1,y1,z1] [--mesh <substr>] [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris]
     node tools/seat-split.mjs <in.glb> <out.glb> (--box x0,y0,z0,x1,y1,z1 | --mesh <substr>) [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris] [--name Driver_Seat]
     node tools/seat-split.mjs <in.glb> [<out.glb> | --report] --pick x,y,z [--source a,b]
     node tools/seat-split.mjs <in.glb> [<out.glb> | --report] --auto [--source a,b]
     node tools/seat-split.mjs <in.glb> [<out.glb> | --report] --rename-seat
       any selection: [--front +z] [--driver left|right] [--name <seat material>]
       --pick, --auto, --box: [--seed <uint32> [--tries 1-20]]
       any write: [--append | --redo] [--force] [--json]
   Arguments are strict, because the dial page passes free-typed extra flags
   through: an unknown flag, a flag with no value or with the next flag as
   its value (`--pick --json`), a number list with an empty or non-numeric
   component (`--pick 1,,3` used to read as 1,0,3), a third path, or
   --append/--redo with --rename-seat is a usage error, exit 2.

   Messages name files by their BASE name ("not writing 1-seat-split.glb:
   ..."): the lab runs this on draft files deep in a temp folder, and the
   page shows the message as is. LAB_JSON's input/output keep the full
   paths. Every exit -- usage errors, an unreadable file, a crash in the
   middle -- ends with the LAB_JSON line when --json is given.

   --report prints the model's world bounds and every material's world bounds,
   mesh names and triangle count; with a selection it also prints what would
   move -- the box's touching shells with their inside fraction, or the grown
   seat's shells, the neighbours it refused and why, and the console shells
   it left out -- and the checks, and writes nothing. A report exits 0 with
   ok:true even when checks would fail (the report itself worked; read
   checks[]); a selection that cannot be made at all (--auto finds no seat
   pair, a tap on the door card or in mid-air), an --append with no clear
   target and a skinned file exit 1. A report with no selection (the page's
   "Inspect") also returns the material table as summary.materialTable
   [{name, tris, meshes, moreMeshes, min, max}] -- the first thing to read
   on a car like the Accent. --source limits the split to primitives using
   those materials (with --pick/--auto they are also the seat's own
   materials).

   How the lab calls this (tools/lab-server.mjs, argument arrays, no shell):
   the dial page taps the seat, model-viewer's positionAndNormalFromPoint
   gives the point, and the server runs
     seat-split <in> --report --pick x,y,z --json     preview: summary + checks
     seat-split <in> <out> --pick x,y,z --json        write, only if all pass
   (or --auto for the "find it" button, --rename-seat for "fix name"; "Random
   cut" / "Try another" add --seed <a fresh uint32>, "Calibrated" does not),
   plus --redo / --append when the car already has a seat and --name
   <look.seat[0]> when its registry names the seat something other than
   Driver_Seat (the Camry's Driver_Seat_Red). With --json the LAST stdout
   line is `LAB_JSON {ok, tool, input, output, bytesIn, bytesOut, summary,
   checks, warnings, error}` (lib/gltf-io.mjs printLabJson), usage errors
   and crashes included; summary carries the method, triangle and shell
   counts (of the seat as it will be: after an --append, old + new), the
   materials the selection came from, the seat's bounds in model units and
   as fractions of the car, its side, the driver's side (driverSide), the
   front, the console triangles the regrow left out (consoleLeftOut), the
   notes, the seat materials found (seatMaterialsBefore), where the cut
   goes (seatTarget {name, from: default|--name|--redo|--append, how:
   new|append|redo-reuse}), for --append, {into, before, added,
   alreadyIn}, and with --seed the variation (above). A tap on the passenger seat comes back ok:false with
   driver-side failed, so the page shows why instead of writing a red
   passenger seat. The page keeps its own copy of the file and the server
   writes <out>; nothing here touches visual-search-standalone/assets/.

   Output goes through lib/gltf-io.mjs writeGlb, which re-saves Draco at the
   recipe's bits (NORMAL 12) -- the old io.write re-quantised normals to 10
   bits and made every shipped car ~3% "smaller" and worse. Run it on the
   ORIGINAL export when there is one (root assets/, before compression, as
   the recipe says). On a shipped Draco file the re-save drops exactly the
   input's zero-area triangles (two identical corners: 1,619 on the Maxima,
   514 on the Sportage 2017, 18 on the Sentra) and Draco merges vertices that
   decode identically, so the file can come out up to ~4% smaller with the
   same visible surface and byte-identical textures; --rename-seat re-saves
   nothing. */
import { Accessor } from "@gltf-transform/core";
import { createIO, writeGlb, fileSize, printLabJson } from "./lib/gltf-io.mjs";
import { buildScene } from "./lib/seat-scene.mjs";
import * as SF from "./lib/seat-find.mjs";
import { boxSelect } from "./lib/seat-box.mjs";
import { isNearMiss, readGlbJson, renameMaterialInGlb } from "./lib/seat-rename.mjs";
import { parseSeed, parseTries, runVariants, fingerprint, noVariantMessage } from "./lib/variation.mjs";
import { drawSeatParams, growTune, padBox, describe } from "./lib/seat-vary.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const REGISTRY_SEAT = "Driver_Seat";
const BOOL = new Set(["report", "auto", "append", "redo", "rename-seat", "force", "json"]);
const VALUE = new Set(["box", "exclude", "mesh", "source", "min-inside", "mode", "name", "pick", "front", "driver", "seed", "tries"]);
const argv = process.argv.slice(2);
// Known before parsing, so a parse error is still reported as LAB_JSON.
const json = argv.includes("--json");
const t0 = Date.now();
const lab = { ok: false, tool: "seat-split", input: null, output: null, bytesIn: null, bytesOut: null, summary: {}, checks: [], warnings: [], error: null };
const log = (...a) => console.log(...a);
let exiting = false;
/* The input and output paths once parsed: fail() swaps them for their base
   names wherever they turn up in a message, including the full paths inside
   a system error ("ENOENT: ... open 'C:\Users\...\drafts\...\1-seat-split.glb'"). */
let msgPaths = [];
function shorten(msg) {
  let s = String(msg);
  for (const p of msgPaths) {
    const b = basename(p);
    for (const form of new Set([resolve(p), p, resolve(p).replace(/\\/g, "/"), p.replace(/\\/g, "/"), p.replace(/\//g, "\\")])) if (form && form !== b) s = s.split(form).join(b);
  }
  return s;
}
function fail(msg, code = 1) {
  exiting = true;
  msg = shorten(msg);
  lab.ok = false; lab.error = msg;
  console.error(msg);
  if (json) printLabJson(lab);
  process.exit(code);
}
/* A throw nobody expected (a corrupt Draco buffer, a full disk in writeGlb)
   would otherwise end the run with a stack trace and no LAB_JSON line, and
   the lab would report "no result" instead of the reason. Top-level await
   rejections land here too (checked on Node 24). */
process.on("uncaughtException", (e) => {
  if (exiting) throw e;
  if (process.env.SEAT_DEBUG) console.error(e && e.stack);
  fail("seat-split crashed: " + (e && e.message ? e.message : String(e)));
});
/* File names in messages: the base name only (see the header). */
const base = (p) => (p ? basename(String(p)) : String(p));
const USAGE = "usage: seat-split <in.glb> --report [--box ...|--mesh substr|--pick x,y,z|--auto|--rename-seat] [--source a,b] [--exclude ...] [--min-inside 0.5] [--mode shell|tris] [--name <seat>] [--append|--redo] [--seed n [--tries k]] [--json]\n" +
  "       seat-split <in.glb> <out.glb> (--box x0,y0,z0,x1,y1,z1 | --mesh substr | --pick x,y,z | --auto [--front +z]) [--driver left|right] [--source a,b] [--exclude ...] [--name Driver_Seat] [--append|--redo] [--seed n [--tries k]] [--force] [--json]\n" +
  "       seat-split <in.glb> <out.glb> --rename-seat [--name Driver_Seat] [--force] [--json]\n" +
  "  --append adds to the existing seat material (--name picks one when there are several); --redo cuts it again and keeps its name\n" +
  "  --seed n cuts a variant of a --pick/--auto/--box seat (n: 0-4294967295), trying up to --tries k (1-20, default 8) until one passes the checks";
/* Strict, because the dial page passes free-typed "extra flags" through: an
   unknown flag, a flag given no value, or one whose value is the next flag
   (`--pick --json` used to swallow --json and print no LAB_JSON) is a usage
   error, never a silent default. */
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (BOOL.has(key)) { flags[key] = true; continue; }
    if (!VALUE.has(key)) fail(`unknown flag ${a}\n${USAGE}`, 2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value` + (v ? ` (got the flag ${v})` : ""), 2);
    i++;
    if (key === "exclude") { (flags.exclude = flags.exclude || []).push(v); continue; }
    if (flags[key] !== undefined) fail(`${a} given twice`, 2);
    flags[key] = v;
  } else positional.push(a);
}
if (positional.length > 2) fail(`too many paths (${positional.join(" ")})\n${USAGE}`, 2);
const [inPath, outPath] = positional;
msgPaths = positional.slice().sort((a, b) => b.length - a.length);
lab.input = inPath || null;
lab.bytesIn = inPath ? fileSize(inPath) : null;
if (!inPath || (!flags.report && !outPath)) fail(USAGE, 2);
const report = !!flags.report;
if (report && outPath) lab.warnings.push(`--report writes nothing: ${base(outPath)} was ignored`);
if (flags.name !== undefined && !flags.name.trim()) fail("--name wants a material name", 2);
/* Where the seat goes is settled once the file is read (--append and --redo
   look at the seat materials already there); this is the starting point. */
let seatName = flags.name || REGISTRY_SEAT;
let seatNameFrom = flags.name !== undefined ? "--name" : "default";
const mode = flags.mode || "shell";
if (mode !== "shell" && mode !== "tris") fail("--mode wants shell or tris", 2);
const minInside = flags["min-inside"] !== undefined ? Number(flags["min-inside"]) : 0.5;
if (flags["min-inside"] !== undefined && !flags["min-inside"].trim() || Number.isNaN(minInside) || minInside <= 0 || minInside > 1) fail("--min-inside wants a fraction in (0, 1]", 2);
/* "x,y,z" -> numbers; every component must be a written, finite number:
   "1,,3" used to read as 1,0,3. */
function numbers(s, n) {
  const parts = String(s).split(",");
  if (parts.length !== n || parts.some((p) => !p.trim() || !Number.isFinite(Number(p)))) return null;
  return parts.map(Number);
}
function parseBox(s) {
  const v = numbers(s, 6);
  if (!v) fail(`--box/--exclude want six numbers: x0,y0,z0,x1,y1,z1 (got "${s}")`, 2);
  return { min: [Math.min(v[0], v[3]), Math.min(v[1], v[4]), Math.min(v[2], v[5])], max: [Math.max(v[0], v[3]), Math.max(v[1], v[4]), Math.max(v[2], v[5])] };
}
const box = flags.box ? parseBox(flags.box) : null;
const excludes = (flags.exclude || []).map(parseBox);
const sources = flags.source !== undefined ? flags.source.split(",").map((s) => s.trim()).filter(Boolean) : null;
if (sources && !sources.length) fail("--source wants material names: a,b", 2);
const meshFilter = flags.mesh || null;
let pick = null;
if (flags.pick !== undefined) {
  pick = numbers(flags.pick, 3);
  if (!pick) fail(`--pick wants three numbers: x,y,z (model space; got "${flags.pick}")`, 2);
}
const front = flags.front !== undefined ? SF.parseAxisHint(flags.front) : null;
if (flags.front !== undefined && !front) fail("--front wants +x, -x, +z or -z", 2);
const driver = flags.driver || null;
if (driver && driver !== "left" && driver !== "right") fail("--driver wants left or right", 2);
const modes = [pick && "pick", flags.auto && "auto", (box || meshFilter) && "box", flags["rename-seat"] && "rename"].filter(Boolean);
if (modes.length > 1) fail("give one of --pick, --auto, --box/--mesh or --rename-seat, not " + modes.join(" + "), 2);
const selMode = modes[0] || null;
if (!report && !selMode) fail("give --pick x,y,z, --auto, --box, --mesh (a seat that is its own mesh) or --rename-seat", 2);
if (flags.append && flags.redo) fail("--append adds to the existing seat, --redo cuts it again: not both", 2);
if (selMode === "rename" && (flags.append || flags.redo)) fail(`--rename-seat only renames: --${flags.append ? "append" : "redo"} means nothing with it`, 2);
/* --seed / --tries: a variant cut (see the header). Only a cut that grows
   (--pick, --auto) or takes a box has anything to vary. */
const seeded = flags.seed !== undefined;
let seed = null, tries = 0;
if (flags.tries !== undefined && !seeded) fail("--tries goes with --seed", 2);
if (seeded) {
  if (selMode === "rename") fail("--rename-seat only renames: --seed has nothing to vary", 2);
  if (!selMode) fail("--seed varies a cut: give --pick x,y,z, --auto or --box with it", 2);
  if (selMode === "box" && !box) fail("--seed varies a --box cut's box; --mesh alone takes whole meshes and has nothing to vary: add --box, or leave out --seed", 2);
  try { seed = parseSeed(flags.seed); tries = parseTries(flags.tries); } catch (e) { fail(e.message, 2); }
}

/* A skinned export (see the header): skins in the file AND a primitive that
   carries JOINTS_0, which is what makes the skin move the vertices. `skins`
   alone (an unused leftover) moves nothing and is let through. */
const SKINNED = (n, prims) => `skinned export (${n} skin(s), ${prims} primitive(s) with JOINTS_0): its node transforms are not where the page draws it, so a seat cut here lands in the wrong place. Run Export fixes -> --unskin first (export-fix --unskin), then cut the seat`;

const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const pad = (n, w) => String(n).padStart(w);
const round = (v) => v.map((n) => +n.toPrecision(6));

// ---- existing seat materials ---------------------------------------------------
const seatLike = (n) => /^driver[ _-]?seat/i.test(n || "");

/* --rename-seat works on the GLB's bytes (lib/seat-rename.mjs): only the JSON
   chunk changes, the BIN chunk is copied byte for byte, so nothing is
   decoded or re-encoded. Renamed: a lone NEAR-MISS (Driver_Seat.001, a case
   or separator variant). Refused: Driver_Seat_Red and other names that add
   a word -- the Camry's registry expects exactly that name. */
if (selMode === "rename") {
  /* The target is Driver_Seat, or --name's material: the lab passes the
     car's look.seat[0] to every seat button, so on the Camry "fix name"
     looks for near-misses of Driver_Seat_Red (Driver_Seat_Red.001) and
     finds the name already right, instead of refusing it as not a
     near-miss of Driver_Seat. */
  const target = seatName;
  lab.summary.mode = "rename-seat";
  lab.summary.seatName = target;
  let bytes, parsed;
  try { bytes = new Uint8Array(readFileSync(inPath)); parsed = readGlbJson(bytes); } catch (e) { fail("--rename-seat: cannot read " + base(inPath) + ": " + e.message); }
  const skins = (parsed.json.skins || []).length;
  const jointPrims = (parsed.json.meshes || []).reduce((a, me) => a + (me.primitives || []).filter((p) => p.attributes && p.attributes.JOINTS_0 !== undefined).length, 0);
  if (skins && jointPrims) fail(SKINNED(skins, jointPrims));
  const mats = (parsed.json.materials || []).map((m, i) => ({ i, name: m.name || "" }));
  const existing = mats.filter((m) => seatLike(m.name) || m.name === target).map((m) => m.name);
  lab.summary.seatMaterialsBefore = existing;
  const exact = existing.includes(target);
  const near = mats.filter((m) => isNearMiss(m.name, target));
  const own = existing.filter((n) => n !== target && !isNearMiss(n, target));
  if (exact && !near.length) {
    lab.checks.push({ name: "seat-material", pass: true, detail: "already named " + target + "; nothing to rename" });
    lab.ok = true; lab.warnings.push("nothing written: the file already has " + target);
    log("already named " + target + ": nothing to do, nothing written");
    if (json) printLabJson(lab);
    process.exit(0);
  }
  if (exact) fail(`the file has ${target} and also ${near.map((m) => m.name).join(", ")}: merge or rename them by hand`);
  if (near.length > 1) fail(`more than one near-miss of ${target} (${near.map((m) => m.name).join(", ")}): rename by hand`);
  if (!near.length) fail(own.length
    ? `${own.join(", ")} is not a near-miss of ${target} but a name of its own` + (target === REGISTRY_SEAT ? " (the Camry's registry entry expects Driver_Seat_Red)" : "") + `: nothing renamed. If the page should use it, point the car's registry entry (look.seat) at it instead` + (target === REGISTRY_SEAT ? `, or pass --name ${own[0]}` : "")
    : `no ${target}-like material to rename (materials: ${mats.map((m) => m.name).join(", ")})`);
  const m = near[0];
  lab.summary.renamed = { from: m.name, to: target, material: m.i };
  if (report) {
    lab.checks.push({ name: "seat-material", pass: true, detail: `would rename ${m.name} -> ${target}` });
    lab.ok = true;
    log(`would rename material ${m.name} -> ${target} (report: nothing written)`);
    if (json) printLabJson(lab);
    process.exit(0);
  }
  let r;
  try { r = renameMaterialInGlb(bytes, m.i, m.name, target); } catch (e) { fail("--rename-seat: " + e.message); }
  // Prove it before writing: same bytes after the JSON, the intended names,
  // and a file gltf-transform still reads (Draco decodes).
  const back = readGlbJson(r.bytes);
  const binSame = Buffer.compare(Buffer.from(back.rest), Buffer.from(parsed.rest)) === 0;
  const namesOk = (back.json.materials || []).every((x, i) => (x.name || "") === (i === m.i ? target : mats[i].name));
  let loads = "";
  try {
    const d = await (await createIO({ encoder: false })).readBinary(r.bytes);
    if (!d.getRoot().listMaterials().some((x) => x.getName() === target)) loads = "read back without a " + target + " material";
  } catch (e) { loads = "does not read back: " + e.message; }
  lab.checks.push({ name: "seat-material", pass: namesOk, detail: namesOk ? `renamed ${m.name} -> ${target}, every other material name unchanged` : "the material names did not come out as intended" });
  lab.checks.push({ name: "json-only", pass: binSame && !loads, detail: binSame
    ? `only the JSON chunk changed (${r.jsonBytes[0]} -> ${r.jsonBytes[1]} bytes, ${r.method}); the ${parsed.rest.byteLength}-byte BIN chunk is byte-identical` + (loads ? "; but the result " + loads : "; the result reads back")
    : "the bytes after the JSON chunk changed" });
  const bad = lab.checks.filter((c) => !c.pass);
  for (const c of lab.checks) log("  " + (c.pass ? "pass" : "FAIL") + "  " + c.name.padEnd(15) + c.detail);
  if (bad.length && !flags.force) fail(`not writing ${base(outPath)}: check(s) failed: ${bad.map((c) => c.name + " (" + c.detail + ")").join("; ")}. Pass --force to write anyway.`);
  if (bad.length) lab.warnings.push("--force: wrote despite failed checks: " + bad.map((c) => c.name).join(", "));
  writeFileSync(outPath, r.bytes);
  lab.ok = true; lab.output = outPath; lab.bytesOut = fileSize(outPath);
  log(`renamed material ${m.name} -> ${target}; wrote ${base(outPath)} (${lab.bytesIn} -> ${lab.bytesOut} bytes, JSON chunk only)`);
  if (json) printLabJson(lab);
  process.exit(0);
}

// Recipe Draco bits on write -- see lib/gltf-io.mjs for what the default did.
const io = await createIO();
let doc;
try { doc = await io.read(inPath); } catch (e) { fail("cannot read " + base(inPath) + ": " + e.message); }
const root = doc.getRoot();
const tRead = Date.now();
{
  const skins = root.listSkins().length;
  const jointPrims = root.listMeshes().reduce((a, me) => a + me.listPrimitives().filter((p) => p.getAttribute("JOINTS_0")).length, 0);
  if (skins && jointPrims) fail(SKINNED(skins, jointPrims));
}

/* The seat materials already in the file: Driver_Seat-like names, and the
   exact --name (a car whose registry names its seat something else). */
const isSeat = (n) => seatLike(n) || (flags.name !== undefined && n === flags.name);
const seatMats = root.listMaterials().filter((m) => isSeat(m.getName()));
const existing = seatMats.map((m) => m.getName());
lab.summary.seatMaterialsBefore = existing;
const notes = [];

/* --append: the seat material to add to (see the header). One seat material:
   that one. Several: --name picks, else it is ambiguous and refused -- a
   guess would paint the wrong one or, as before 2026-10, a new third. */
let target = null;
if (flags.append) {
  if (!seatMats.length) lab.warnings.push(`--append: the file has no seat material yet, so this is a new cut into ${seatName}`);
  else {
    if (flags.name !== undefined) {
      if (!existing.includes(flags.name)) fail(`--append --name ${flags.name}: the file has no material ${flags.name} to add to (its seat material(s): ${existing.join(", ")})`);
    } else if (seatMats.length > 1) fail(`--append is ambiguous: the file has ${seatMats.length} seat materials (${existing.join(", ")}); pass --name <one of them> to say which to add to`);
    else { seatName = existing[0]; seatNameFrom = "--append"; }
    const same = seatMats.filter((m) => m.getName() === seatName);
    if (same.length > 1) fail(`--append: ${same.length} materials are named ${seatName}; merge them by hand first`);
    target = same[0];
  }
}

/* --redo: hand an existing seat's primitives back to the cabin material they
   were cut from, so the seat can be cut again. seat-split always put the
   seat primitive on its source's mesh, so the candidates are that mesh's
   other materials (every material in the file when the seat is alone in its
   mesh, as the Sonata's Object_146 is), and the one with the most triangles
   around the old seat wins (the Camry's Object_0 holds cabin, dash and
   wheel). World space throughout.
   The name the new cut gets, and the material it reuses, are settled first
   (see the header): the Camry's --redo used to come back as a flat
   Driver_Seat while its registry still asked for Driver_Seat_Red. */
function worldCentroids(node, prim) {
  const m = node.getWorldMatrix();
  const pos = prim.getAttribute("POSITION").getArray(), idx = prim.getIndices() ? prim.getIndices().getArray() : null;
  const n = idx ? idx.length / 3 : pos.length / 9, out = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 3; j++) { const i = (idx ? idx[t * 3 + j] : t * 3 + j) * 3; x += pos[i]; y += pos[i + 1]; z += pos[i + 2]; }
    x /= 3; y /= 3; z /= 3;
    out[t * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[t * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[t * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
let reuse = null;
if (flags.redo && !seatMats.length) lab.warnings.push(`--redo: the file has no seat material, so this is a plain new cut into ${seatName}`);
if (flags.redo && seatMats.length) {
  const names = [...new Set(existing)];
  if (flags.name === undefined && names.length === 1) {
    if (names[0] !== REGISTRY_SEAT && !isNearMiss(names[0], REGISTRY_SEAT)) {
      seatName = names[0]; seatNameFrom = "--redo";
      notes.push(`--redo keeps the old seat's name ${seatName} (pass --name to choose another)`);
    } else if (names[0] !== REGISTRY_SEAT) notes.push(`--redo: the old seat's name ${names[0]} is a near-miss of ${REGISTRY_SEAT}; the new cut is named ${REGISTRY_SEAT}`);
  } else if (flags.name === undefined && names.length > 1) lab.warnings.push(`--redo: the file had ${names.length} seat materials (${names.join(", ")}); the new cut is named ${seatName} -- pass --name to keep one of the old names`);
  const same = seatMats.filter((m) => m.getName() === seatName);
  if (same.length === 1) reuse = same[0];
  else if (same.length > 1) lab.warnings.push(`--redo: ${same.length} materials were named ${seatName}; the new cut gets a fresh one`);
  const back = [];
  const placed = root.listNodes().filter((n) => n.getMesh()).flatMap((node) => node.getMesh().listPrimitives().map((prim) => ({ node, mesh: node.getMesh(), prim })));
  for (const seat of placed) {
    const p = seat.prim;
    if (!p.getMaterial() || !isSeat(p.getMaterial().getName()) || !p.getAttribute("POSITION")) continue;
    let others = placed.filter((q) => q.mesh === seat.mesh && q.prim.getMaterial() && !isSeat(q.prim.getMaterial().getName()));
    const where = others.length ? "its mesh" : "the file";
    if (!others.length) others = placed.filter((q) => q.prim.getMaterial() && !isSeat(q.prim.getMaterial().getName()) && q.prim.getAttribute("POSITION"));
    if (!others.length) fail("--redo: no other material to return the seat to");
    const c = worldCentroids(seat.node, p), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < c.length; i++) { const k = i % 3; if (c[i] < lo[k]) lo[k] = c[i]; if (c[i] > hi[k]) hi[k] = c[i]; }
    const g = lo.map((v, k) => 0.1 * (hi[k] - v));
    const score = new Map();
    for (const q of others) {
      const qc = worldCentroids(q.node, q.prim);
      let n = 0;
      for (let t = 0; t < qc.length; t += 3) if (qc[t] >= lo[0] - g[0] && qc[t] <= hi[0] + g[0] && qc[t + 1] >= lo[1] - g[1] && qc[t + 1] <= hi[1] + g[1] && qc[t + 2] >= lo[2] - g[2] && qc[t + 2] <= hi[2] + g[2]) n++;
      score.set(q.prim.getMaterial(), (score.get(q.prim.getMaterial()) || 0) + n);
    }
    const into = [...score].sort((a, b) => b[1] - a[1])[0][0];
    back.push(`${seat.mesh.getName() || seat.node.getName()}: ${p.getMaterial().getName()} -> ${into.getName()} (from ${where})`);
    p.setMaterial(into);
  }
  // The material the new cut reuses stays (its maps, its exact values); the
  // other emptied seat materials go.
  for (const m of root.listMaterials()) if (m !== reuse && isSeat(m.getName()) && m.listParents().every((q) => q.propertyType === "Root")) m.dispose();
  lab.summary.redo = back;
  log("--redo: returned " + back.length + " seat primitive(s) to their cabin material: " + back.join("; ") + (reuse ? `; the new cut reuses the material ${seatName}` : ""));
}
/* Seat materials still holding triangles that the new cut does not go into:
   a clash (a second seat material) unless it is --append's own target. */
const stillSeat = root.listMaterials().filter((m) => m !== target && m !== reuse && isSeat(m.getName())).map((m) => m.getName());
lab.summary.seatTarget = { name: seatName, from: seatNameFrom, how: target ? "append" : reuse ? "redo-reuse" : "new" };

// ---- scene -----------------------------------------------------------------------
const scene = buildScene(doc);
const F = scene.frame;
const lim = SF.seatLimits(F);
const tScene = Date.now();
lab.summary.frame = { up: "xyz"[F.up], length: "xyz"[F.len], width: "xyz"[F.wid], L: +F.L.toPrecision(5), W: +F.W.toPrecision(5), H: +F.H.toPrecision(5), centre: +F.mid.toPrecision(5), ground: +F.ground.toPrecision(5) };
if (F.upFallback) lab.warnings.push("the model's Y is not its smallest extent; took " + "xyz"[F.up] + " as up");

// Material table, as before.
const raw = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
const stats = new Map();
for (const v of scene.visits) {
  if (!stats.has(v.matName)) stats.set(v.matName, { tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], meshes: new Set(), group: v.group });
  const s = stats.get(v.matName);
  s.meshes.add(v.meshName || v.nodeName || "?");
  if (v.first) s.tris += v.triCount;
  for (let i = 0; i < v.vc * 3; i += 3) for (let k = 0; k < 3; k++) { const x = v.pos[i + k]; if (x < s.min[k]) s.min[k] = x; if (x > s.max[k]) s.max[k] = x; if (x < raw.min[k]) raw.min[k] = x; if (x > raw.max[k]) raw.max[k] = x; }
}
if (sources) {
  const missing = sources.filter((n) => !stats.has(n));
  if (missing.length) fail("--source names no material in this file: " + missing.join(", "));
}
const sourceGroups = sources ? new Set(sources.map((n) => scene.groupOf(n))) : null;
if (front && front.axis !== F.len) fail(`--front ${flags.front} is not the car's length axis (${"xyz"[F.len]}): give +${"xyz"[F.len]} or -${"xyz"[F.len]}`);

// ---- select ----------------------------------------------------------------------
/* WHICH seat is settled first, and a --seed never varies it: the shell under
   --pick's point, --auto's front row, front and driver's side (seat-find
   pickPlan / autoPlan). A cut then grows the seat from there -- the
   calibrated growth or a variant's -- or takes the box. */
const guard = (fn) => {
  try { return fn(); } catch (e) { if (!(e instanceof SF.SeatError)) throw e; fail(e.message); }
};
const plan = guard(() => selMode === "pick" ? SF.pickPlan(scene, pick, { lim, sources: sourceGroups })
  : selMode === "auto" ? SF.autoPlan(scene, { lim, sources: sourceGroups, front, driver }) : null);

/* One cut. P: null for the calibrated cut, else a --seed variant's
   parameters (lib/seat-vary.mjs drawSeatParams; the growth gets them as
   seat-find's `tune` and `glim`, the box as its padding, --min-inside and
   borderTris). Nothing is logged or added to the run here -- a variant may
   be thrown away; everything comes back: { tris, side, sel, box and
   minInside as used, borderTris, notes, warnings }. A split can only edit
   a mesh's first instance (see instancing below), so triangles of later
   instances are dropped from what gets written. */
function cut(P) {
  const c = { tris: null, side: 0, sel: null, box, minInside, borderTris: false, notes: [], warnings: [] };
  const grow = P && selMode !== "box" ? growTune(P, lim) : {};
  if (selMode === "pick") {
    const sel = c.sel = SF.pickGrow(scene, plan, { lim, sources: sourceGroups, ...grow });
    c.tris = Array.from(SF.trisOfShells(scene, sel.shells));
    c.side = sel.side;
    c.warnings.push(...sel.warnings);
    c.notes.push(`seed: ${scene.groupNames[scene.shells.group[sel.seed]]} shell of ${scene.shells.count[sel.seed]} triangles, ${(sel.near.dist / F.L * 1000).toFixed(2)} permille of the length from the point`);
    if (sel.method === "named-mesh") c.notes.push(`the point is on meshes *${sel.mesh}*: took them whole`);
  } else if (selMode === "auto") {
    const sel = c.sel = SF.autoGrow(scene, plan, { lim, sources: sourceGroups, driver, ...grow });
    c.tris = Array.from(SF.trisOfShells(scene, sel.shells));
    c.side = sel.side;
    c.notes.push(...sel.notes);
  } else if (selMode === "box") {
    if (P) {
      if (box) c.box = padBox(box, P, F);
      if (P.minInside !== undefined) c.minInside = P.minInside;
      c.borderTris = !!P.borderTris;
    }
    const sel = c.sel = boxSelect(scene, { box: c.box, excludes, minInside: c.minInside, mode, sources: sources ? new Set(sources) : null, meshFilter, borderTris: c.borderTris });
    c.tris = sel.tris;
    if (c.tris.length) { const b = SF.boxOfTris(scene, c.tris); c.side = Math.sign((b.min[F.wid] + b.max[F.wid]) / 2 - F.mid) || 1; }
  }
  if (c.sel && c.sel.namedSkipped) c.notes.push(`this variant grew the seat instead of taking meshes *${c.sel.namedSkipped}* whole`);
  return c;
}

// ---- the seat a cut makes, and its checks ---------------------------------------
/* The seat material's textures sample TEXCOORD_n; every primitive a
   triangle moves out of must carry those, or the new seat primitive points
   at an attribute it does not have. A fresh Driver_Seat has no textures; the
   Camry's Driver_Seat_Red has a normal map on TEXCOORD_2 and an occlusion map
   on TEXCOORD_3, which its own cabin primitive (Object_0) carries. */
function texCoordsOf(mat) {
  const need = new Set();
  const pairs = [[mat.getBaseColorTexture(), mat.getBaseColorTextureInfo()], [mat.getNormalTexture(), mat.getNormalTextureInfo()],
    [mat.getOcclusionTexture(), mat.getOcclusionTextureInfo()], [mat.getEmissiveTexture(), mat.getEmissiveTextureInfo()],
    [mat.getMetallicRoughnessTexture(), mat.getMetallicRoughnessTextureInfo()]];
  for (const [tex, info] of pairs) if (tex && info) need.add(info.getTexCoord());
  return need;
}
const lacking = (mat, moveTris) => {
  const need = [...texCoordsOf(mat)], out = [];
  if (!need.length || !moveTris) return out;
  for (const vi of new Set(moveTris.map((t) => scene.triVisit[t]))) {
    const v = scene.visits[vi], miss = need.filter((k) => !v.prim.getAttribute("TEXCOORD_" + k));
    if (miss.length) out.push(`${v.meshName || v.nodeName || "a mesh"} (${v.matName}) has no ${miss.map((k) => "TEXCOORD_" + k).join(", ")}`);
  }
  return out;
};
const sourceTris = sources ? sources.reduce((a, n) => a + (stats.get(n)?.tris || 0), 0) : null;
/* The front row's shape, for driver-side on a --pick/--box/--mesh cut: the
   same mirror-pair search --auto runs (~0.1-0.6 s), and the same answer for
   every cut of this file, so it runs once. */
let pairShape = null;
function frontRow() {
  if (!pairShape) {
    pairShape = { facing: 0, centre: null };
    try { const sp = SF.seatPairs(scene, { lim, sources: sourceGroups }); if (sp.top) pairShape = { facing: sp.facing, centre: sp.top.centre }; }
    catch (e) { if (!(e instanceof SF.SeatError)) throw e; }
  }
  return pairShape;
}

/* The seat a cut makes and the CHECKS it is held to -- the same gates for
   every cut, calibrated or a --seed variant, always at the calibrated limits
   `lim` (a variant's own voxel and gap only steer its growth). Pure as well:
   the warnings come back, in the order the run reports them. */
function judge(c) {
  const { tris, side, sel } = c;
  const j = { moveTris: tris, seatTris: tris, already: 0, targetTris: 0, targetLacks: [], reuseNote: "", checks: [], ds: null, warnings: [] };
  /* --append: the seat after the append is the target's own triangles plus the
     new ones, and that is what the checks judge -- a headrest appended on its
     own is no seat-sized object, but the seat it completes must still be one.
     Triangles of the selection already in the target stay where they are. */
  if (tris && target) {
    j.moveTris = tris.filter((t) => scene.visits[scene.triVisit[t]].prim.getMaterial() !== target);
    j.already = tris.length - j.moveTris.length;
    const own = [];
    for (const v of scene.visits) if (v.first && v.prim.getMaterial() === target) for (let t = 0; t < v.triCount; t++) own.push(v.triStart + t);
    j.targetTris = own.length;
    j.seatTris = own.concat(j.moveTris);
  }
  const { moveTris, seatTris, checks } = j;
  if (target) j.targetLacks = lacking(target, moveTris);
  /* A --redo cut that takes triangles from a primitive the old material's
     maps cannot be drawn on: the seat gets a fresh flat material of the same
     name instead (the page still finds it; the maps are lost, and said so --
     the run drops the old material once this cut is the one written). */
  if (reuse) {
    const l = lacking(reuse, moveTris);
    if (l.length) j.reuseNote = `the old ${seatName}'s maps cannot be drawn on the new cut (${l.join("; ")}), so it is a fresh flat ${seatName}`;
  }
  const kept = reuse && !j.reuseNote ? reuse : null;
  if (seatTris && seatTris.length) checks.push(...SF.seatChecks(scene, seatTris, { lim, side, sourceTris }));
  else if (tris) checks.push({ name: "one-object", pass: false, detail: "nothing selected" });
  /* driver-side: the seat must be where the driver sits (lib/seat-find.mjs
     driverSide). The front row's shape comes from the same mirror-pair search
     --auto runs (a pick runs it too, ~0.1-0.6 s); --pick and --auto FAIL on
     the other side, on a contradicting --front, and when the side cannot be
     told; an old --box/--mesh cut fails only when it is plainly on the other
     side, and is otherwise "not judged" with a warning, so the memory notes'
     box commands behave as before. */
  if (seatTris && seatTris.length) {
    const row = selMode === "auto" ? { facing: sel.pairFacing, centre: sel.pairCentre } : frontRow();
    const ds = j.ds = SF.driverSide(scene, { front, driver, pairFacing: row.facing, pairCentre: row.centre, tris: seatTris, wheel: selMode === "auto" ? sel.wheel : undefined });
    const sideName = (side > 0 ? "+" : "-") + "xyz"[F.wid];
    const strict = selMode === "pick" || selMode === "auto";
    const unsure = !ds.expected || ds.conflicts.length;
    let pass, detail;
    if (unsure && !strict) { pass = true; detail = `not judged for a ${meshFilter && !box ? "--mesh" : "--box"} cut: ` + (ds.conflicts.length ? ds.conflicts.join("; ") : ds.why); j.warnings.push("driver-side " + detail); }
    else if (ds.conflicts.length) { pass = false; detail = ds.conflicts.join("; ") + `; the seat taken is on the ${sideName} side` + (flags.force ? "" : " (--force writes it anyway)"); }
    else if (!ds.expected) { pass = false; detail = ds.why; }
    else if (ds.expected !== side) { pass = false; detail = `the seat is on the ${sideName} side, but ${ds.why}: that is the passenger seat -- ${selMode === "pick" ? "tap the driver's seat" : "check the hints"}, or pass --driver right for a right-hand-drive car`; }
    else { pass = true; detail = `on the ${sideName} side: ${ds.why}`; }
    checks.push({ name: "driver-side", pass, detail });
    for (const x of ds.conflicts) if (strict) j.warnings.push("driver-side: " + x);
    j.warnings.push(...ds.warnings);
  }
  /* seat-material: where the triangles go, said plainly -- "appending to" only
     when they really go into the existing material (until 2026-10 the detail
     said "appending to Driver_Seat_Red" while the cut went into a new
     Driver_Seat). */
  if (tris) {
    const why = seatNameFrom === "--name" && seatName !== REGISTRY_SEAT ? ` (--name: the car's registry look.seat must list ${seatName})`
      : seatNameFrom === "--redo" ? " (the old seat's name, kept by --redo)" : "";
    let pass = true, detail;
    if (stillSeat.length && !target) {
      pass = false;
      const inOld = tris.filter((t) => isSeat(scene.visits[scene.triVisit[t]].matName)).length;
      detail = (inOld === tris.length ? `the selection IS the existing seat (all ${tris.length} triangles are in ${stillSeat.join(", ")}): nothing new to cut; ` : "")
        + `the file already has ${stillSeat.join(", ")}: pass --append to add to it, --redo to cut it again` + (!stillSeat.includes(REGISTRY_SEAT) && stillSeat.filter((n) => isNearMiss(n, REGISTRY_SEAT)).length === 1 ? ", or --rename-seat to rename it" : "");
    } else if (target && !moveTris.length) {
      pass = false;
      detail = tris.length ? `all ${tris.length} selected triangles are in ${seatName} already: nothing to append` : "nothing selected: nothing to append";
    } else if (target && j.targetLacks.length) {
      pass = false;
      detail = `${seatName}'s maps sample texture coordinates the new triangles lack: ${j.targetLacks.join("; ")} -- append from a primitive that has them, or --redo`;
    } else if (target) {
      detail = `appending ${moveTris.length} triangle(s) to the existing ${seatName} (${j.targetTris} before, ${j.targetTris + moveTris.length} after` + (j.already ? `; ${j.already} of the selection already in it stay put` : "") + ")" + why;
      if (stillSeat.length) j.warnings.push(`--append: the file also has ${stillSeat.join(", ")}, left as it is`);
    } else if (kept) {
      detail = `cutting into the old ${seatName} material again, its values` + (texCoordsOf(kept).size ? " and maps" : "") + " kept" + why;
    } else {
      detail = `new material ${seatName}` + why + (j.reuseNote ? "; " + j.reuseNote : "");
    }
    checks.push({ name: "seat-material", pass, detail });
  }
  return j;
}

// ---- the cut: calibrated, or --seed variants until one passes -------------------
let C, J, tSelect, vres = null, variation = null;
if (!seeded) {
  C = guard(() => cut(null));
  tSelect = Date.now();
  J = judge(C);
} else {
  /* A file that already has a seat, with neither --append nor --redo to say
     what to do with it, fails seat-material whatever is drawn: refused before
     any variant is (--force still runs them and writes the closest). */
  if (stillSeat.length && !target && !flags.force) fail(`--seed: the file already has ${stillSeat.join(", ")}: pass --append to add to it or --redo to cut it again -- no variant can pass seat-material without one; nothing ${report ? "reported" : "written"}`);
  const kind = selMode === "box" ? "box" : "grow";
  const drawOpts = { kind, adaptive: !sourceGroups, minInside: flags["min-inside"] !== undefined ? minInside : undefined, mode: flags.mode };
  const named = !!(plan && plan.named && plan.named.shells);
  /* Dedupe: a variant is only worth showing when it is a DIFFERENT seat --
     from the calibrated cut ("Calibrated" gives that one) and from every
     earlier attempt of this run. "The same seat" is the same triangles, or so
     nearly that at most SAME_AREA of the two seats' area differs: on the
     Sportage 2021 a tight reach drops 2 of 13,874 triangles (0.00% of the
     area). 0.25% is roughly 50 cm2 of a seat's ~2 m2 of surface, a 7 cm
     patch; the smallest differences measured between variants that leave
     out a real part were above 0.3% (the Optima's inboard trim strip, 248
     triangles, 0.34%). Such an attempt is rejected as a duplicate and the
     next is drawn; it uses up one of the tries. */
  const SAME_AREA = 0.0025;
  const areaDiff = (x, y) => {
    let i = 0, k = 0, d = 0, u = 0;
    while (i < x.length || k < y.length) {
      if (k >= y.length || (i < x.length && x[i] < y[k])) { const a = scene.area[x[i++]]; d += a; u += a; }
      else if (i >= x.length || y[k] < x[i]) { const a = scene.area[y[k++]]; d += a; u += a; }
      else { u += scene.area[x[i]]; i++; k++; }
    }
    return u ? d / u : 0;
  };
  const calib = Int32Array.from(guard(() => cut(null)).tris || []).sort();
  const seen = [{ of: "the calibrated cut", ids: calib }];
  /* keeps-seat, the one check only a variant gets: it must keep at least
     KEEP of the calibrated seat's area -- a variant reshapes THE seat (its
     headrest, back plastic, trims, stitching, edges), it does not shrink to
     a fragment of it. Measured: the variants that keep only the seat's own
     material keep 67-76% on the Optima and the Sportage 2021 (their
     upholstery), one without the headrest 85% on the Camry, 92% on the
     Sportage; on the Maxima, whose largest seat shell is the plastic back,
     "own material only" kept the back shell alone -- 50% of the seat, all
     eight checks passing, nobody's driver's seat. Judged on the cut's own
     triangles (an --append's old seat aside). */
  const KEEP = 0.6;
  let calibArea = 0;
  for (const t of calib) calibArea += scene.area[t];
  const keptShare = (ids) => { let a = 0, i = 0, k = 0; while (i < ids.length && k < calib.length) { if (ids[i] < calib[k]) i++; else if (calib[k] < ids[i]) k++; else { a += scene.area[ids[i]]; i++; k++; } } return calibArea ? a / calibArea : 1; };
  /* Per attempt: its triangle and shell counts, a short fingerprint of its
     triangle set (equal fingerprints = the same triangles) and, for a
     duplicate, which seat it repeats -- rejected[] carries them. */
  const tried = new Map();
  let tail = "";
  log(`--seed ${seed}: up to ${tries} variant${tries === 1 ? "" : "s"} of the ${selMode} cut; the first that passes every check is ${report ? "reported" : "written"}`);
  vres = await runVariants({
    seed, tries, label: "variant", log: (line) => { log(line + tail); tail = ""; },
    attempt: (draw, info) => {
      const P = drawSeatParams(draw, drawOpts);
      const c = guard(() => cut(P));
      const ids = Int32Array.from(c.tris).sort();
      const shells = new Set(c.tris.map((t) => scene.shellOf[t])).size;
      const rec = { triangles: ids.length, shells, fingerprint: fingerprint(ids).slice(0, 12) };
      tried.set(info.k, rec);
      tail = `  [${ids.length} triangles, ${shells} shells]`;
      for (const e of seen) {
        const d = areaDiff(ids, e.ids);
        if (d > SAME_AREA) continue;
        Object.assign(rec, { sameAs: e.of, areaDiff: +d.toFixed(4) });
        tail = `  [${ids.length} triangles, ${shells} shells: the same seat as ${typeof e.of === "number" ? "attempt " + e.of : e.of}, ${(d * 100).toFixed(2)}% of the area differs]`;
        return { duplicate: typeof e.of === "number" ? e.of : true };
      }
      seen.push({ of: info.k, ids });
      const j = judge(c);
      const kept = keptShare(ids);
      j.checks.push({ name: "keeps-seat", pass: kept >= KEEP, detail: `keeps ${(kept * 100).toFixed(1)}% of the calibrated seat's area (a variant keeps at least ${KEEP * 100}%)` });
      return { failed: j.checks.filter((x) => !x.pass).map((x) => x.name), c, j };
    },
  });
  tSelect = Date.now();
  const sv = vres.summary;
  const pk = vres.chosen || vres.closest;
  variation = { ...sv, rejected: sv.rejected.map((r) => ({ ...r, ...tried.get(r.attempt) })), kind, label: pk ? describe(sv.params, kind, { named }) : null, ...(pk ? tried.get(pk.k) : {}) };
  if (!pk) {
    lab.summary.variation = variation;
    fail(`no new variant in ${tries} tr${tries === 1 ? "y" : "ies"} (seed ${seed}): every attempt cut the same seat as the calibrated cut or an earlier attempt -- this car's seat has few variants. Nothing ${report ? "reported" : "written"}: try another seed, or Calibrated.`);
  }
  C = pk.result.c; J = pk.result.j;
  log(vres.chosen
    ? `variant ${pk.k} of ${tries} passed (seed ${seed}${pk.k > 1 ? ", sub-seed " + pk.subSeed : ""}): ${variation.label}`
    : `no variant passed in ${tries}; the closest is attempt ${pk.k} (sub-seed ${pk.subSeed}): ${variation.label}`);
}
const { tris, side, sel } = C;
const { moveTris, seatTris, already, targetTris, ds } = J;
lab.warnings.push(...C.warnings);
notes.push(...C.notes);

// ---- report ----------------------------------------------------------------------
log("model world bounds: " + f3(raw.min) + " -> " + f3(raw.max) + "  size " + f3(raw.max.map((v, k) => v - raw.min[k])));
log(`car frame: up ${"xyz"[F.up]}, length ${"xyz"[F.len]} (L ${F.L.toPrecision(4)}), width ${"xyz"[F.wid]} (W ${F.W.toPrecision(4)}, centre ${F.mid.toPrecision(4)}), H ${F.H.toPrecision(4)} from ${F.ground.toPrecision(4)}`);
if (box) log("box: " + f3(box.min) + " -> " + f3(box.max));
if (C.box && C.box !== box) log("this variant's box: " + f3(C.box.min) + " -> " + f3(C.box.max));
for (const b of excludes) log("exclude: " + f3(b.min) + " -> " + f3(b.max));
if (meshFilter) log("mesh filter: *" + meshFilter + "*");
if (pick) log("pick: " + f3(pick));
if (selMode === "box") log("mode: " + mode + (mode === "shell" ? " (a whole shell moves when more than " + Math.round(C.minInside * 100) + "% of its triangles are inside" + (C.borderTris ? "; one 20% or more inside is cut by triangle" : "") + ")" : " (each triangle on its own centroid)"));
const selectedByMat = new Map();
if (tris) for (const t of tris) { const n = scene.visits[scene.triVisit[t]].matName; selectedByMat.set(n, (selectedByMat.get(n) || 0) + 1); }
for (const [name, s] of [...stats.entries()].sort((a, b) => b[1].tris - a[1].tris)) {
  log("  " + name.padEnd(22) + " tris=" + pad(s.tris, 7) + (tris ? "  selected=" + pad(selectedByMat.get(name) || 0, 6) : "") + "  bounds " + f3(s.min) + " -> " + f3(s.max) + "  meshes: " + [...s.meshes].slice(0, 4).join(", ") + (s.meshes.size > 4 ? " +" + (s.meshes.size - 4) : ""));
}
const S = scene.shells;
const relBox = (b) => {
  const r = (k, v) => k === F.wid ? (v - F.mid) / F.W : k === F.up ? (v - F.ground) / F.H : (v - F.lo[F.len]) / F.L;
  return { width: [r(F.wid, b.min[F.wid]), r(F.wid, b.max[F.wid])].map((x) => +x.toFixed(3)), up: [r(F.up, b.min[F.up]), r(F.up, b.max[F.up])].map((x) => +x.toFixed(3)), length: [r(F.len, b.min[F.len]), r(F.len, b.max[F.len])].map((x) => +x.toFixed(3)) };
};
const shellLine = (s) => { const b = { min: [S.min[s * 3], S.min[s * 3 + 1], S.min[s * 3 + 2]], max: [S.max[s * 3], S.max[s * 3 + 1], S.max[s * 3 + 2]] }; return `${scene.groupNames[S.group[s]].slice(0, 22).padEnd(22)} tris=${pad(S.count[s], 6)}  bounds ${f3(b.min)} -> ${f3(b.max)}`; };
if (selMode === "box" && mode === "shell") {
  log("shells touching the box: " + sel.touching.length + " of " + S.n);
  for (const sh of sel.touching.slice(0, 40)) log("  " + (sh.selected ? "SELECTED" : sh.part ? "PART    " : "   -    ") + " tris=" + pad(sh.n, 6) + " inside=" + pad(sh.inside, 6) + " " + pad(Math.round(100 * sh.inside / sh.n), 3) + "%  " + shellLine(sh.shell).replace(/^.*?bounds/, "bounds") + "  " + scene.groupNames[S.group[sh.shell]]);
  if (sel.touching.length > 40) log("  ... " + (sel.touching.length - 40) + " more");
}
if (selMode === "pick" || selMode === "auto") {
  log(`${selMode}: ${sel.method}, ${sel.shells.length} shells, ${tris.length} triangles`);
  for (const n of notes) log("  " + n);
  for (const s of sel.shells.slice(0, 30)) log("  SELECTED " + shellLine(s));
  if (sel.shells.length > 30) log("  ... " + (sel.shells.length - 30) + " more");
  for (const r of (sel.refused || []).slice(0, 15)) log("  refused  " + shellLine(r.shell) + "  (" + r.why + ", " + r.d + " voxel(s) away)");
  if (sel.consoleShells && sel.consoleShells.length) {
    const n = sel.consoleShells.reduce((a, s) => a + S.count[s], 0);
    notes.push(`left out ${sel.consoleShells.length} shell(s), ${n} triangles, lying wholly inboard of the seat (the console)`);
    log("  " + notes[notes.length - 1] + ":");
    for (const s of sel.consoleShells.slice(0, 15)) log("  console  " + shellLine(s));
  }
  // What a --seed variant left out on purpose (the headrest, small pieces).
  if (sel.dropped && sel.dropped.length) {
    const n = sel.dropped.reduce((a, d) => a + S.count[d.shell], 0);
    notes.push(`this variant left out ${sel.dropped.length} shell(s), ${n} triangles: ` + [...new Set(sel.dropped.map((d) => d.why.replace(/ \(this variant.*$/, "")))].join("; "));
    log("  " + notes[notes.length - 1] + ":");
    for (const d of sel.dropped.slice(0, 15)) log("  dropped  " + shellLine(d.shell));
  }
}

// ---- what moves, and the seat it makes -----------------------------------------
/* judge() worked it out for the cut taken; what it only said is done now: a
   --redo material whose maps the cut cannot carry is dropped for a fresh
   flat one. */
const reuseNote = J.reuseNote;
if (reuseNote) {
  lab.warnings.push("--redo: " + reuseNote);
  reuse.dispose(); reuse = null;
  lab.summary.seatTarget.how = "new";
}

// ---- checks ----------------------------------------------------------------------
const checks = J.checks;
lab.warnings.push(...J.warnings);
lab.checks = checks;
const failed = checks.filter((c) => !c.pass);
if (checks.length) {
  log("checks" + (target ? ` (of the seat after the append: ${targetTris} + ${moveTris.length} triangles)` : "") + ":");
  for (const c of checks) log("  " + (c.pass ? "pass" : "FAIL") + "  " + c.name.padEnd(15) + c.detail);
}
if (seatTris && seatTris.length) {
  const b = SF.boxOfTris(scene, seatTris);
  lab.summary = { ...lab.summary, mode: selMode, method: sel.method || (meshFilter && !box ? "mesh" : mode === "tris" ? "box-tris" : "box-shell"),
    triangles: seatTris.length, shells: new Set(seatTris.map((t) => scene.shellOf[t])).size,
    pieces: +(checks.find((c) => c.name === "one-object")?.detail.match(/^\d+/)?.[0] || 0),
    materials: Object.fromEntries(selectedByMat), bounds: { min: round(b.min), max: round(b.max) }, relBounds: relBox(b),
    side: `${side > 0 ? "+" : "-"}${"xyz"[F.wid]}`, front: (sel.front || ds?.front) ? `${(sel.front || ds.front) > 0 ? "+" : "-"}${"xyz"[F.len]}` : null,
    driverSide: ds ? (ds.expected ? `${ds.expected > 0 ? "+" : "-"}${"xyz"[F.wid]}` : null) : null,
    consoleLeftOut: sel.consoleShells ? sel.consoleShells.reduce((a, s) => a + S.count[s], 0) : null,
    pick: pick || null, seatName, notes, timings: { readMs: tRead - t0, sceneMs: tScene - tRead, selectMs: tSelect - tScene } };
  if (target) lab.summary.append = { into: seatName, before: targetTris, added: moveTris.length, alreadyIn: already };
} else if (notes.length) lab.summary.notes = notes;
if (variation) lab.summary.variation = variation;
/* No variant passed: the run fails naming the closest attempt and what it
   failed (its checks are the ones reported above and in checks[]). */
const variantFailure = () => noVariantMessage(vres, seed, tries) + " Attempt " + vres.closest.k + ": " + failed.map((c) => c.name + " (" + c.detail + ")").join("; ");
for (const w of lab.warnings) log("warning: " + w);
if (report) {
  lab.ok = true;
  /* Inspect (a report with no selection): the material table above, as data,
     so the page can show it -- the first thing to look at on a car like the
     Accent, before any tap. */
  if (!tris) lab.summary.materialTable = [...stats.entries()].sort((a, b) => b[1].tris - a[1].tris)
    .map(([name, s]) => ({ name, tris: s.tris, meshes: [...s.meshes].slice(0, 6), moreMeshes: Math.max(0, s.meshes.size - 6), min: round(s.min), max: round(s.max) }));
  if (tris) log(failed.length ? `${failed.length} check(s) would fail: ${failed.map((c) => c.name).join(", ")}` : "all checks pass");
  // A --seed report is the variant that passed; none passing is a failure.
  if (vres && !vres.chosen) fail(variantFailure());
  if (json) printLabJson(lab);
  process.exit(0);
}
if (vres && !vres.chosen) {
  if (!flags.force) fail(variantFailure());
  lab.warnings.push(`--force: no variant passed (seed ${seed}); writing the closest, attempt ${vres.closest.k}`);
}
if (!tris.length) fail("nothing selected: not writing " + base(outPath));
// Nothing to add is not something --force can write: the file would come out
// re-encoded and otherwise unchanged.
if (target && !moveTris.length) fail(`nothing to append: all ${tris.length} selected triangles are in ${seatName} already; not writing ${base(outPath)}`);
if (failed.length && !flags.force) fail(`not writing ${base(outPath)}: check(s) failed: ${failed.map((c) => c.name + " (" + c.detail + ")").join("; ")}. Pass --force to write anyway.`);
if (failed.length) lab.warnings.push("--force: wrote despite failed checks: " + failed.map((c) => c.name).join(", "));

// ---- split -----------------------------------------------------------------------
/* Into: --append's target, the material --redo kept, a same-named material
   already there (only reachable with --force over a seat-material failure),
   or a fresh flat red one. */
let seatMat = target || reuse || root.listMaterials().find((mt) => mt.getName() === seatName);
if (!seatMat) {
  seatMat = doc.createMaterial(seatName)
    .setBaseColorFactor([0.863, 0.058, 0.058, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8)
    .setEmissiveFactor([0.025, 0.002, 0.002]);
}
const buffer = root.listBuffers()[0] || doc.createBuffer();
const byVisit = new Map();
for (const t of moveTris) {
  const vi = scene.triVisit[t];
  if (scene.visits[vi].prim.getMaterial() === seatMat) continue; // in the seat already
  if (!byVisit.has(vi)) byVisit.set(vi, []);
  byVisit.get(vi).push(t - scene.visits[vi].triStart);
}
if (!byVisit.size) fail(`nothing to move: every selected triangle is in ${seatName} already; not writing ${base(outPath)}`);
let moved = 0;
for (const [vi, locals] of byVisit) {
  const v = scene.visits[vi];
  let { mesh, prim } = v;
  /* A mesh drawn by more than one node (a mirrored seat, say) would carry the
     split into every copy. Give this node its own mesh first: new primitives
     that share the accessors, so only the index lists differ. */
  if (v.instanced) {
    const own = doc.createMesh(mesh.getName());
    for (const p of mesh.listPrimitives()) own.addPrimitive(p.clone());
    v.node.setMesh(own);
    mesh = own; prim = own.listPrimitives()[v.primIndex];
    for (const w of scene.visits) if (w.node === v.node && w !== v) { w.mesh = own; w.prim = own.listPrimitives()[w.primIndex]; w.instanced = false; }
    lab.warnings.push(`mesh ${mesh.getName()} was instanced; node ${v.node.getName()} got its own copy`);
  }
  const chosen = new Uint8Array(v.triCount);
  for (const l of locals) chosen[l] = 1;
  const inside = [], outside = [];
  for (let l = 0; l < v.triCount; l++) {
    const a = v.idx ? v.idx[l * 3] : l * 3, b = v.idx ? v.idx[l * 3 + 1] : l * 3 + 1, c = v.idx ? v.idx[l * 3 + 2] : l * 3 + 2;
    (chosen[l] ? inside : outside).push(a, b, c);
  }
  const Typed = v.vc < 65536 ? Uint16Array : Uint32Array;
  const mk = (list) => doc.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer).setArray(new Typed(list));
  const oldIdx = prim.getIndices();
  if (outside.length) prim.setIndices(mk(outside));
  const seatPrim = doc.createPrimitive().setMode(prim.getMode()).setMaterial(seatMat).setIndices(mk(inside));
  for (const sem of prim.listSemantics()) seatPrim.setAttribute(sem, prim.getAttribute(sem));
  mesh.addPrimitive(seatPrim);
  if (!outside.length) { mesh.removePrimitive(prim); if (!prim.listParents().some((p) => p.propertyType !== "Root")) prim.dispose(); }
  if (oldIdx && oldIdx.listParents().every((p) => p.propertyType === "Root")) oldIdx.dispose();
  moved += inside.length / 3;
  log("moved " + inside.length / 3 + " triangles from " + (mesh.getName() || v.node.getName()) + " (" + v.matName + ") to " + seatName);
}
await writeGlb(io, doc, outPath);
lab.ok = true; lab.output = outPath; lab.bytesOut = fileSize(outPath);
lab.summary.timings.totalMs = Date.now() - t0;
log(`wrote ${base(outPath)} with ${moved} seat triangles under material ${seatName} (${lab.bytesIn} -> ${lab.bytesOut} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (json) printLabJson(lab);
