#!/usr/bin/env node
/* lab-server: the page's static server plus a small local API that lets the
   ?tune=1 dial page (visual-search-standalone/car3d-lab.jsx) run the REAL car
   tools on a car, preview the result, and save it into the site.

     node tools/lab-server.mjs [--port 3000] [--host <this PC's LAN ip>]
     then open http://localhost:3000/?tune=1

   It replaces `npx serve` while you are editing cars; `npx serve` still works
   for just looking (the dial page then says the server is missing and only
   offers the motion dials).

   Why a server and not the browser: a page cannot write project files, and
   re-implementing the tools in the browser would not produce the same bytes
   (Draco settings, the occlusion-map writer) -- the rule is that anything that
   ships is written by the CLI tools. So the page only sends a tool name and
   its flags; this server runs `node tools/<tool>.mjs` on a draft copy, exactly
   as you would by hand.

   Drafts. Every car has a chain of drafts in tools/.lab/drafts/<car>/: the
   first edit reads the shipped file, each later edit reads the previous
   draft, so a seat split and then panel shading stack. Nothing in the site
   changes until Save. Undo drops the newest draft only; Discard drops the
   whole chain. A tool writes to partial-<n>-<tool>.glb and the server renames
   it to <n>-<tool>.glb only when the run succeeded -- a server killed mid-
   write (Ctrl+C reaches the child too) used to leave a truncated draft that
   listDrafts accepted and Save would have installed. A report (Check) run
   writes nothing and leaves no empty draft folder behind.

   Variants and Try another. seat-split, cabin-black, vertex-shading and
   occlusion-patch take --seed <uint32> (and --tries <n>): with a seed the
   tool draws its tunable parameters from it, inside ranges around the
   calibrated values, and retries sub-seeds until its own checks pass;
   without one it gives the calibrated result (deterministic). The page's
   "Random cut" / "Random" / "Random seams" send a fresh seed; "Try another"
   sends a new one with replace:true, which swaps the newest draft for the
   new result instead of stacking a second variant on the first:
     - allowed only when the newest draft was made by the same tool with the
       same opKey (the action's name the page sends, e.g. "seat-auto",
       "cabin", "gaps-vertex"), as its sidecar records; otherwise 409,
       nothing runs;
     - the run reads the draft BEFORE the newest (or the shipped file), so
       every variant starts from the same car, and the same seed on the same
       base reproduces a variant exactly (the page's Tried list uses that);
     - it writes partial-<n>-<tool>.glb under the newest's own number and,
       only when it succeeded, renames it over the newest draft -- the same
       file name, so the swap is one atomic rename and the draft's ?t= (its
       mtime) changes, which reloads the preview. A failed variant leaves
       the newest draft and its sidecar exactly as they were.
   Every draft has a sidecar <n>-<tool>.json (how it was made: tool, opKey,
   args, seed, the tool's variation summary, its checks; see "draft
   sidecars" below) that follows it through Undo, Discard, Save and replace,
   and that is never listed, previewed or saved as a draft.

   The cabin. cabin-black moves every cabin triangle except the driver's
   seat into ONE material, Interior_Black (or its --name), and removes the
   materials it emptied. The order is seat first, then cabin: seat-split
   finds the seat by its material, and after the cabin is black the seat
   shares one material with the whole dash. Two things follow for the site:
   the car's look needs that material in its interior slot (Save adds it,
   step 4), and the interior names the look lists may be gone from the file
   because they were merged into it -- which loses nothing the site paints,
   so it must not refuse the Save (step 0).

   Save (what "apply to the main page" means):
     0. the checks first, before anything is touched: the draft must still
        carry every material name the car's registry look:{...} lists (a
        seat-split --redo that renamed Driver_Seat_Red to Driver_Seat, or a
        stale mesh-strip tick that deleted the seat, would otherwise ship a
        car whose look silently paints nothing), and the car must have exactly
        one registry entry. Either failing answers 409 {missing, needForce}
        and changes NOTHING; {force:true} overrides it.
        Except the cabin slots (interior, and wheel -- the steering wheel is
        cabin too): a name listed only there is COVERED, never a refusal,
        when the file has the cabin material (cabin-black removes a material
        only once every triangle of it moved into the black one, so the site
        paints those triangles through the cabin material now), or when the
        missing name IS the cabin material and another interior name is in
        the file (a Restore of the file from before the cabin went black:
        its own interior materials are painted again). Covered names stay in
        the look -- a Restore of the older file needs them back -- and the
        answer lists them as registry.interiorCovered. paint, seat and every
        other slot still refuse as before.
     1. sources/backup/<file> -- the ORIGINAL, written the first time a car is
        ever saved and never overwritten afterwards;
     2. sources/backup/history/<car>-<local time>-<ms>.glb -- the version being
        replaced, on every save and restore, so any save can be undone. The
        copy is exclusive (COPYFILE_EXCL, -2/-3 suffix on a clash): two saves in
        one second used to share a one-second stamp and the second overwrote
        the first's backup. A version already in the history (byte-identical)
        is not copied again; the response names the existing entry;
     3. the latest draft is copied over visual-search-standalone/assets/<file>
        (via a temp file + rename, so a half-written car is never served);
     4. index.html: that car's registry src gets its ?v= bumped, so every
        browser fetches the new file instead of a cached one; and when the
        saved file has a seat material (a name starting "Driver_Seat") but the
        car's look has no seat slot, seat: ["<that name>"] is added so the red
        seat shows. Likewise the cabin: when the saved file has the cabin
        material (Interior_Black, or the --name the chain's cabin-black run
        used) and the look's interior slot does not list it, it is added --
        appended to interior: [...], or interior: ["Interior_Black"] when
        the look has no interior slot -- so the black cabin keeps the
        profile's interior recipe. The entry is found by its src and walked
        as JS (strings, comments, nesting), so a multi-line entry like the
        Camry's and an entry with no look at all (look: { seat: [...] } is
        inserted) both work; when it cannot be edited safely the response
        says seatNeeded / interiorNeeded: true and the page asks for it by
        hand.
   Restore copies a backup (the original, or any history entry) back the same
   way, with the same registry check, the same seat and interior slots, and
   drops the car's unsaved drafts (the page warns first). sources/ is
   gitignored, so backups are local only -- the shipped files themselves are
   also in git (LFS), which is the second safety net.

   Safety. The threat is not the user; it is (a) another web page in the same
   browser and (b) another device on the network.
     - Listens on 127.0.0.1 (and ::1 when the OS has it) only, unless
       --host <ip> opts into LAN mode (below).
     - Every /__lab/ request, GET included, must arrive with a Host header of
       localhost/127.0.0.1/[::1]:PORT (or the --host ip:PORT). That is what
       stops DNS rebinding: a page on evil.test whose name is re-pointed at
       127.0.0.1 is same-origin with itself, so it can send X-Lab without any
       preflight -- but its requests still say Host: evil.test, and get 403.
       An Origin header that is not this Host (or is "null", or is not a URL)
       is a 403 as well, never a 500.
     - Every POST carries X-Lab. A cross-site page cannot send a custom header
       without a CORS preflight, which this server never answers. On a local
       Host X-Lab: 1 is enough; the random token printed at start-up always
       works, and on the LAN Host only the token does (X-Lab: 1 stops other
       web pages, not other devices).
     - Car names must be an existing assets/*.glb; tools come from a fixed
       list; the tool runs with its cwd in the car's draft folder (never the
       repo root), with absolute input/output paths this server chooses.
     - Flags (validArgs): every arg is either a --flag, or the value directly
       after a flag that takes one (per tool, VALUE_FLAGS). A stray bare word
       is refused, because a tool that reads it as a positional would write
       there -- export-fix in check mode once wrote a glTF over victim.json in
       the repo root that way. Values may hold material-name characters
       (spaces, [ ] & ' @ # ( ) . , : + = -) but nothing path-like: no / \ ..,
       no drive prefix (C:), no file extension. --seed and --tries must be
       whole numbers in range (INT_FLAGS). The error names the arg.
     - One thing at a time: a running job, or a save / restore / discard / undo
       in progress, holds `busy` (set before the handler's first await and
       cleared in finally), and everything else answers 409 until it is done.
       Save used to delete the draft a run had just started reading.

   LAN mode (opt-in): --host 192.168.1.20 also listens on that address and
   prints http://192.168.1.20:PORT/?tune=1#lab=<token>. Open exactly that URL
   on the phone: the page sends the #lab= value as X-Lab. Without the token a
   LAN request can read status and drafts but not run or save anything.
   --host auto finds this PC's LAN address itself; --open drops the token on
   the LAN address (X-Lab: 1 is enough there, as on localhost). lab.cmd in
   the repo root starts exactly that on port 8001, next to the plain site
   server on 8000:
     node tools/lab-server.mjs --host auto --port 8001 --open

   API (JSON; POSTs carry X-Lab):
     GET  /__lab/status   {ok, tools, busy, cars, auth}
            busy: {kind: "job"|"save"|"restore"|"discard"|"undo", id?, file} | null
            auth: "local" (X-Lab: 1 is accepted on this Host) | "token"
            cars[]: {file, id, bytes, original, history: [{name, label, bytes}],
                     drafts: [{n, tool, bytes, url, file, t, meta}], lastJob,
                     lastJobByTool, info}
            lastJob: the id of this car's newest finished job still kept (a
            page reloaded after a job ended shows its result from it), or null;
            lastJobByTool: {<tool>: id} the same per tool, for a page that
            shows each section's own last result
            draft url: /__lab/draft/<id>/<n>.glb?t=<mtimeMs> (a new chain, or
            a draft replaced by Try another, never reuses an old URL, so
            model-viewer's cache cannot show a stale car); t is that stamp
            draft meta: its sidecar {n, tool, opKey, args, seed, variation,
            checks, bytes, t, time, job, input, replaces, summary?}, or null
            (a draft made before sidecars existed, or a record that no
            longer matches the file); summary: cabin-black's LAB_JSON
            summary (what moved, what was left), for the Cabin tab's card
            info (newest draft, else the shipped file; JSON chunk only):
                     {from, materials: [{name, occlusion: null|"png"|"jpeg"|"other",
                      mr, color0, specular, prims, tris, shaded, patched, cabin}],
                      seatMaterials, cabinMaterial, cabinTris,
                      skinned, color0Prims, color0Foreign,
                      registry: {found, lookNames, seat, interior, slots,
                                 lengthMm, error?}}
            (shaded / patched / cabin: the material carries vertex-shading's
            / occlusion-patch's / cabin-black's marker; color0Foreign counts
            COLOR_0 primitives of unmarked materials; tris: triangles, from
            the accessor counts; cabinMaterial: the black cabin material's
            name -- Interior_Black, the --name of the chain's cabin-black
            run, or a marked one -- when it has geometry, else null, and
            cabinTris its triangles; registry.slots: {<slot>: [names]} for
            each array slot of the look)
     POST /__lab/run     {file, tool, args, report, opKey?, replace?}
                                           -> {job: {id, replace, n}}   id "<boot>-<n>"
            opKey: the page's name for the action ([a-z0-9-], 40 at most),
            kept in the job and the draft's sidecar. replace: true = Try
            another (see "Variants" above): needs opKey, refused with a
            Check (400); 409 {cannotReplace: true, newest: {n, tool, opKey}}
            when there is no draft, the newest has no sidecar, or it was made
            by another tool / opKey. n: the draft number being replaced.
     GET  /__lab/job/<id>  {job: {state, log, result, draft, opKey, replace, ...}}
            log: the last ~12 KB, \r progress collapsed, absolute paths made
            relative, LAB_JSON lines left out (they are `result`). The last 30
            jobs are kept. draft: the draft written (with meta), or null --
            for a replace, the newest draft under its own number.
     GET  /__lab/draft/<car>/<n>.glb  a draft, for the page to preview
     POST /__lab/undo    {file}                -> {dropped: {n, tool, meta}, car}
                                                  drops the newest draft (and its sidecar) only
     POST /__lab/discard {file}                -> {car}   drops every draft
     POST /__lab/save    {file, force?}        -> {bytesBefore, bytesAfter, backup,
                                                   registry: {ok, version, seatAdded,
                                                   seatNeeded, interiorAdded, interiorNeeded,
                                                   interiorCovered, cabinMaterial, error?},
                                                   chain, car}
                                                  chain: [{n, tool, meta}] the drafts
                                                  that went into the saved file
                                                  interiorCovered: look names missing from
                                                  the file that the cabin covers (step 0)
                                                  409 {missing, alreadyMissing, covered,
                                                  needForce} before any change
                                                  (alreadyMissing: the names the shipped
                                                  file lacks as well; covered: the cabin
                                                  names that did not count)
     POST /__lab/restore {file, from: "original" | "<history name>", force?}  same */
import http from "node:http";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS_DIR, "..");
/* --site / --backup / --drafts exist for testing the save path against a
   scratch copy of the site; normal use passes none of them. */
const SITE = path.resolve(opt("site", path.join(ROOT, "visual-search-standalone")));
const ASSETS = path.join(SITE, "assets");
const INDEX = path.join(SITE, "index.html");
const BACKUP = path.resolve(opt("backup", path.join(ROOT, "sources", "backup")));
const HISTORY = path.join(BACKUP, "history");
const DRAFTS = path.resolve(opt("drafts", path.join(TOOLS_DIR, ".lab", "drafts")));
const PORT = Number(opt("port", 3000));
/* --host auto picks this PC's LAN address itself: the Wi-Fi address comes
   from DHCP and can change, and a launcher with a fixed ip would then fail
   with EADDRNOTAVAIL. The first non-internal IPv4 that is not link-local
   (169.254.x.x, what an unplugged Ethernet port carries) wins. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return null;
}
let HOST = opt("host", null);
if (HOST === "auto") {
  HOST = lanAddress();
  if (!HOST) { console.error("--host auto: this PC has no LAN address right now (is Wi-Fi connected?)"); process.exit(2); }
}
/* --open: on the LAN Host, X-Lab: 1 is enough, as on localhost -- no token
   in the URL. The user's call (2026-10-06): the network is theirs, and the
   tab is what drives every edit. The Host allow-list, the Origin check and
   the X-Lab header still apply, so another web page in a browser still
   cannot drive it; what --open gives up is the guard against another DEVICE
   on the network sending requests by hand. */
const OPEN = argv.includes("--open");
if (OPEN && !HOST) { console.error("--open only means something with --host (LAN mode)"); process.exit(2); }
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) { console.error("--port wants a port number"); process.exit(2); }
if (HOST !== null && (!net.isIP(HOST) || /^(0\.0\.0\.0|::0*)$/.test(HOST))) {
  /* A concrete address, not "every interface": the Host allow-list and the
     printed URL both need the one name the phone will actually use. */
  console.error("--host wants this PC's LAN address, e.g. --host 192.168.1.20 (not a name, not 0.0.0.0)");
  process.exit(2);
}
/* The token always exists, so a script or the LAN page can use it; on a
   local Host "1" is accepted too, which is what the page sends by default. */
const TOKEN = crypto.randomBytes(18).toString("base64url");
/* Job ids carry the boot id, so a page still polling job "7" from before a
   restart gets a 404 instead of somebody else's job 7. */
const BOOT = Date.now().toString(36);

/* The tools the page may run. A report (Check) run is read-only: the server
   passes no output path and adds --report (export-fix takes it as --check). */
const TOOLS = {
  "seat-split": "seat-split.mjs",
  "cabin-black": "cabin-black.mjs",
  "mesh-strip": "mesh-strip.mjs",
  "occlusion-patch": "occlusion-patch.mjs",
  "vertex-shading": "vertex-shading.mjs",
  "export-fix": "export-fix.mjs",
};
/* The flags of each tool that take a value -- the only places a bare word may
   appear (see validArgs). Keep in step with each tool's own parser; a flag
   missing here only makes the server refuse its value, never pass a path. */
const VALUE_FLAGS = {
  "seat-split": ["box", "exclude", "mesh", "source", "min-inside", "mode", "name", "pick", "front", "driver", "seed", "tries"],
  // --seat / --paint / --keep are comma lists of material names.
  "cabin-black": ["name", "seat", "paint", "keep", "seed", "tries"],
  "mesh-strip": ["match", "remove"],
  "occlusion-patch": ["material", "pocket", "seams", "mm-per-unit", "car-length-mm", "curve", "profile-scale", "seed", "tries"],
  "vertex-shading": ["material", "mm-per-unit", "car-length-mm", "ao-distance", "ao-rays", "ao-strength", "ao-floor",
    "ao-hidden-below", "ao-hidden-shade", "seams", "curve", "seam-coarse", "threads", "seed", "tries"],
  "export-fix": [],
};
/* Value flags that must be a whole number in a range, checked here so a typo
   is a 400 naming the arg instead of a tool run that dies on it. --seed is
   the variation seed (a uint32: the page draws a fresh one per "Random cut" /
   "Random seams" click; without it every tool gives its calibrated result),
   --tries how many sub-seeds a tool may draw before it gives up (each tool
   defaults to 8 and caps at 20). */
const INT_FLAGS = { seed: [0, 4294967295], tries: [1, 20] };
/* An opKey names WHICH action of a tool made a draft ("seat-auto",
   "seat-pick", "gaps-vertex", ...): the page sends it with every run, the
   draft's sidecar keeps it, and Try another (replace) is allowed only on a
   newest draft made by the same tool AND the same opKey -- a seat cut must
   never replace the gap shading that sits on top of it. */
const OPKEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/* Flags that make a run read-only whatever `report` says: with one of these
   the server passes no output path, so the tool cannot treat it as one.
   occlusion-patch's --dry-run is one of them: it runs the whole patch in
   memory and writes nothing, so a run carrying it that was handed an output
   path used to end "done" with no draft and no word why. */
const REPORT_FLAGS = ["--report", "--check", "--dry-run"];
const JOB_TIMEOUT_MS = 20 * 60 * 1000; // the AO bake is minutes, never this
const JOBS_KEPT = 30;
const LOG_KEPT = 200000;   // per job, in memory
const LOG_SENT = 12000;    // per poll: the page shows the last few lines

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/babel; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/* ── helpers ──────────────────────────────────────────────────────────────── */
const carId = (file) => file.replace(/\.glb$/, "");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function validCar(file) {
  if (typeof file !== "string" || !/^[a-z0-9][a-z0-9-]*\.glb$/.test(file)) return null;
  const p = path.join(ASSETS, file);
  return fs.existsSync(p) ? p : null;
}

/* A flag value may be a number list, a box, a part id (#3.0), or a material
   name -- and the real names use spaces, dots, colons, parentheses, '#', and
   on the Accent and the Optima also [ ] & (`[Color A07]`, `Projectors&DRLs`);
   ' and @ occur in other exports. None of those can form a path, and the tool
   is spawned without a shell, so none of them is special either. What is
   refused is anything path-like, and any bare word that is not the value of
   a value-taking flag: the only files a tool touches are the two positional
   paths this server passes. Returns null when fine, else {index, arg, why}. */
const VALUE_CHARS = /^[\w .,:+\-#()=[\]&'@]*$/u;
const FILE_EXT = /\.(glb|gltf|bin|png|jpe?g|webp|ktx2|basis|dds|tga|bmp|gif|svg|html?|m?js|cjs|jsx|tsx?|json|txt|md|csv|log|ini|cfg|ya?ml|xml|bat|cmd|ps1|psm1|sh|exe|dll|lnk|url|vbs|zip|7z|obj|fbx|blend|mtl|stl|ply|usdz?)$/i;
function badValue(v) {
  if (/[\\/]|\.\./.test(v)) return "looks like a path";
  if (/^[A-Za-z]:/.test(v)) return "looks like a drive (C:...)";
  if (!VALUE_CHARS.test(v)) return "has a character a material name never uses (allowed: letters, digits, space and . , : + - # ( ) = [ ] & ' @ _)";
  if (FILE_EXT.test(v.trim())) return "looks like a file name";
  return null;
}
function badInt(flag, v) {
  const range = INT_FLAGS[flag];
  if (!range) return null;
  if (!/^\d{1,10}$/.test(v) || Number(v) < range[0] || Number(v) > range[1]) return `--${flag} wants a whole number from ${range[0]} to ${range[1]}`;
  return null;
}
function validArgs(tool, args) {
  if (!Array.isArray(args)) return { index: -1, arg: null, why: "args must be a list of strings" };
  if (args.length > 64) return { index: 64, arg: null, why: "too many args (64 at most)" };
  const takes = new Set(VALUE_FLAGS[tool] || []);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string" || a.length > 400) return { index: i, arg: a, why: "not a string of at most 400 characters" };
    if (a.startsWith("--")) {
      const m = /^--([a-z0-9][a-z0-9-]*)(?:=(.*))?$/s.exec(a);
      if (!m) return { index: i, arg: a, why: "not a --flag name" };
      if (m[2] !== undefined) {
        if (!takes.has(m[1])) return { index: i, arg: a, why: `--${m[1]} takes no value here` };
        const why = badValue(m[2]) || badInt(m[1], m[2]);
        if (why) return { index: i, arg: a, why };
      } else if (INT_FLAGS[m[1]] && takes.has(m[1]) && (i + 1 >= args.length || String(args[i + 1]).startsWith("--"))) {
        // A numeric flag with its value missing: the tool would fail on it anyway.
        return { index: i, arg: a, why: `--${m[1]} needs a value` };
      }
      continue;
    }
    const prev = i > 0 ? /^--([a-z0-9][a-z0-9-]*)$/.exec(args[i - 1]) : null;
    if (!prev || !takes.has(prev[1])) return { index: i, arg: a, why: prev ? `--${prev[1]} takes no value, so this would be read as a file path` : "a bare word would be read as a file path; values must directly follow the flag that takes them" };
    const why = badValue(a) || badInt(prev[1], a);
    if (why) return { index: i, arg: a, why };
  }
  return null;
}
/* The --seed a run carries (either form), or null. */
function seedArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed" && i + 1 < args.length) return Number(args[i + 1]);
    const m = /^--seed=(\d+)$/.exec(args[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

/* Backup names: <car>-YYYY-MM-DD_HH-MM-SS-mmm.glb in LOCAL time (the labels
   the page shows used to read UTC, hours off the user's clock), with -2, -3
   added if that name exists. Older names without the milliseconds still
   parse. */
const pad = (n, w = 2) => String(n).padStart(w, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}
/* Exact match on "<id>-<date>_": a prefix test (startsWith(id + "-")) would
   hand one car's history to another whose id is it plus "-something". */
function historyRe(id) {
  return new RegExp(`^${escRe(id)}-(\\d{4}-\\d\\d-\\d\\d)_(\\d\\d)-(\\d\\d)-(\\d\\d)(?:-(\\d{3}))?(?:-(\\d+))?\\.glb$`);
}
const size = (p) => { try { return fs.statSync(p).size; } catch (e) { return null; } };
function removeIfEmpty(dir) {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (e) { /* gone or busy: harmless */ }
}

/* Only <n>-<tool>.glb is a draft. The sidecar <n>-<tool>.json beside it, and
   any partial-* file, never match, so neither can be listed, previewed or
   saved as one. */
const DRAFT_RE = /^(\d+)-([a-z0-9-]+)\.glb$/;
function listDrafts(id) {
  const dir = path.join(DRAFTS, id);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .map((f) => DRAFT_RE.exec(f))
    .filter(Boolean)
    .map((m) => {
      let st = null;
      try { st = fs.statSync(path.join(dir, m[0])); } catch (e) { /* raced a delete */ }
      const t = st && Math.floor(st.mtimeMs);
      return st && { n: Number(m[1]), tool: m[2], bytes: st.size, url: `/__lab/draft/${id}/${m[1]}.glb?t=${t}`, file: m[0], t };
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}
function draftPath(id, n) {
  const d = listDrafts(id).find((x) => x.n === n);
  return d ? path.join(DRAFTS, id, d.file) : null;
}

/* ── draft sidecars ───────────────────────────────────────────────────────── */
/* Every draft a run writes gets <n>-<tool>.json beside it: how it was made,
   for the page's drafts list ("seed 31337, reach 7 mm") and for Try another,
   which may only replace a newest draft of the same tool and opKey:
     {n, tool, opKey, args, seed, variation, checks, bytes, t, time, job,
      input, replaces}
   seed: the run's --seed, or null for a calibrated (seedless) run;
   variation: the tool's LAB_JSON summary.variation ({seed, attempt, tries,
   params, ranges, rejected}), or null; checks: the tool's self-checks; t: the
   draft's mtime stamp, the same number as its url's ?t=; input: "shipped" or
   "draft <n>", what the run read; replaces: how many times Try another has
   replaced the draft under this number; summary (cabin-black only, see
   SIDECAR_SUMMARY): the tool's LAB_JSON summary, so the Cabin tab's card
   still says what went black after the job itself was pruned or the server
   restarted, and so Save can name the --name the cabin material was given.
   The sidecar follows its draft: Undo
   deletes both, Discard and Save drop the folder (Save answers with the
   chain's sidecars first), Try another rewrites both.
   A sidecar counts only while it still describes the file beside it (same n,
   tool, bytes and t): one left over from a crash between the two renames, or
   from a draft that was since replaced, reads as meta: null -- never as the
   record of a different file. Orphans (no draft beside them) are swept before
   each job and at start-up. */
const metaFile = (draftFile) => draftFile.replace(/\.glb$/, ".json");
/* Tools whose whole LAB_JSON summary is kept in the sidecar. Only
   cabin-black's: it is a few lines (what moved, what was left), while
   seat-split's and the shading tools' can carry long tables. */
const SIDECAR_SUMMARY = new Set(["cabin-black"]);
const metaCache = new Map();
function readMeta(id, d) {
  const p = path.join(DRAFTS, id, metaFile(d.file));
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  const key = st.mtimeMs + "|" + st.size;
  let m = metaCache.get(p);
  if (!m || m.key !== key) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { /* half written or junk: no record */ }
    m = { key, data };
    metaCache.set(p, m);
  }
  const s = m.data;
  return s && s.n === d.n && s.tool === d.tool && s.bytes === d.bytes && s.t === d.t ? s : null;
}
const withMeta = (id, drafts) => drafts.map((d) => ({ ...d, meta: readMeta(id, d) }));
/* Sidecars with no draft beside them (an undo whose second delete failed, a
   crash), so the folder can empty and a later draft n never sits next to an
   old n's record. */
function sweepOrphanMeta(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  const have = new Set(names);
  for (const f of names) {
    if (/^\d+-[a-z0-9-]+\.json$/.test(f) && !have.has(f.replace(/\.json$/, ".glb"))) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* retried next time */ }
    }
  }
}
/* Written via a partial- name and renamed, like the draft, so a reader never
   sees half a record. */
async function writeMeta(dir, draftFile, meta) {
  const dest = path.join(dir, metaFile(draftFile));
  const tmp = path.join(dir, "partial-" + metaFile(draftFile));
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 1));
  for (let t = 0; ; t++) {
    try { await fsp.rename(tmp, dest); return; } catch (e) { if (t >= 5) throw e; await delay(200); }
  }
}
/* Try another: may this run replace the car's newest draft? Only when that
   draft has a record, and the record names the same tool and opKey. Returns
   {newest, base} (base: the draft before it, or null for the shipped file),
   or {error, newest} to refuse with. Synchronous, like everything between
   the busy check and runJob taking the lock. */
function replaceTarget(id, tool, opKey) {
  const drafts = listDrafts(id);
  const newest = drafts[drafts.length - 1];
  if (!newest) return { error: "nothing to replace: this car has no draft (run it once first; Try another replaces that result)", newest: null };
  const meta = readMeta(id, newest);
  const view = { n: newest.n, tool: newest.tool, opKey: meta ? meta.opKey : null };
  if (!meta) return { error: `draft ${newest.n} (${newest.tool}) has no record of how it was made, so it cannot be told apart from another action; run without replace (it stacks) or Undo it first`, newest: view };
  if (newest.tool !== tool || meta.opKey !== opKey) {
    return { error: `the newest draft ${newest.n} was made by ${newest.tool}${meta.opKey ? " (" + meta.opKey + ")" : ""}, not ${tool} (${opKey}); Try another replaces only its own result. Run without replace to stack on it, or Undo it first`, newest: view };
  }
  return { newest, meta, base: drafts.length > 1 ? drafts[drafts.length - 2] : null };
}
function listHistory(id) {
  let names;
  try { names = fs.readdirSync(HISTORY); } catch (e) { return []; }
  const re = historyRe(id);
  const rows = names.map((f) => [f, re.exec(f)]).filter(([, m]) => m).map(([f, m]) => ({
    name: f,
    key: `${m[1]}_${m[2]}${m[3]}${m[4]}${m[5] || "000"}_${pad(Number(m[6] || 1), 4)}`,
    second: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`, ms: m[5] || null, n: m[6] ? Number(m[6]) : null,
    bytes: size(path.join(HISTORY, f)),
  })).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  /* Label: the local time to the second; the milliseconds only when two
     entries share that second, and the clash suffix when there is one. */
  const perSecond = {};
  for (const r of rows) perSecond[r.second] = (perSecond[r.second] || 0) + 1;
  return rows.map((r) => ({
    name: r.name,
    label: r.second + (perSecond[r.second] > 1 && r.ms ? "." + r.ms : "") + (r.n ? ` (${r.n})` : ""),
    bytes: r.bytes,
  }));
}

/* ── reading a GLB's JSON chunk (no decode) ───────────────────────────────── */
/* Only the 20-byte header and the JSON chunk are read -- status is polled and
   the Sonata is 12.5 MB of mostly textures. Cached by path + mtime + size. */
function readGlbJson(p) {
  const fd = fs.openSync(p, "r");
  try {
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) < 20) throw new Error("too short for a GLB");
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB (bad magic)");
    const len = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a || len > 64e6) throw new Error("GLB without a JSON chunk first");
    const buf = Buffer.alloc(len);
    if (fs.readSync(fd, buf, 0, len, 20) < len) throw new Error("GLB JSON chunk cut short");
    return JSON.parse(buf.toString("utf8"));
  } finally { fs.closeSync(fd); }
}
const infoCache = new Map();
const SEAT_PREFIX = "Driver_Seat";
/* cabin-black's default material name. A run with --name gives it another;
   its sidecar says which (cabinHint). */
const CABIN_DEFAULT = "Interior_Black";
/* The look slots a black cabin covers (see Save, step 0): the cabin itself,
   and the steering wheel (the Camry's `wheel` slot), which cabin-black
   blackens with the dash. */
const CABIN_SLOTS = ["interior", "wheel"];
/* Triangles a primitive draws, from the JSON alone: Draco keeps the decoded
   counts on the accessors. Strips and fans draw count - 2; points and lines
   draw none. */
function primTris(j, prim) {
  const mode = prim.mode ?? 4;
  const acc = (j.accessors || [])[prim.indices !== undefined ? prim.indices : (prim.attributes || {}).POSITION];
  const n = acc && Number.isInteger(acc.count) ? acc.count : 0;
  return mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
}
function glbInfo(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return { error: "missing file" }; }
  const key = p + "|" + st.mtimeMs + "|" + st.size;
  const hit = infoCache.get(p);
  if (hit && hit.key === key) return hit.info;
  let info;
  try {
    const j = readGlbJson(p);
    const mats = (j.materials || []).map((m) => ({ name: m.name ?? "", occlusion: null, mr: false, color0: false, specular: false, prims: 0, tris: 0, shaded: false, patched: false, cabin: false }));
    const kindOf = (texIndex) => {
      const t = (j.textures || [])[texIndex];
      if (!t) return "other";
      const src = t.source ?? null;
      const img = src === null ? null : (j.images || [])[src];
      if (!img) return "other"; // an extension-only source (webp, basisu): not one the patcher writes
      const mime = img.mimeType || (/\.png$/i.test(img.uri || "") ? "image/png" : /\.jpe?g$/i.test(img.uri || "") ? "image/jpeg" : "");
      return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : "other";
    };
    (j.materials || []).forEach((m, i) => {
      if (m.occlusionTexture && m.occlusionTexture.index !== undefined) mats[i].occlusion = kindOf(m.occlusionTexture.index);
      mats[i].mr = !!(m.pbrMetallicRoughness && m.pbrMetallicRoughness.metallicRoughnessTexture);
      mats[i].specular = !!(m.extensions && m.extensions.KHR_materials_specular);
      /* The two shading tools' markers (material extras). A marked material's
         COLOR_0 is vertex-shading's bake, which export-fix keeps -- so the page
         ticks "Drop COLOR_0" only for the rest (color0Foreign below). */
      mats[i].shaded = !!(m.extras && m.extras.vertexShading);
      mats[i].patched = !!(m.extras && m.extras.occlusionPatch);
      mats[i].cabin = !!(m.extras && m.extras.cabinBlack);
    });
    let color0Prims = 0, color0Foreign = 0, joints = false;
    for (const mesh of j.meshes || []) for (const prim of mesh.primitives || []) {
      const a = prim.attributes || {};
      if (a.COLOR_0 !== undefined) color0Prims++;
      if (a.JOINTS_0 !== undefined) joints = true;
      const mi = prim.material;
      if (mi !== undefined && mats[mi]) { mats[mi].prims++; mats[mi].tris += primTris(j, prim); if (a.COLOR_0 !== undefined) mats[mi].color0 = true; }
      // Unmarked = foreign as far as the JSON can tell (a marker-less old
      // bake counts here; export-fix's Check reads the bytes and knows).
      if (a.COLOR_0 !== undefined && !(mi !== undefined && mats[mi] && mats[mi].shaded)) color0Foreign++;
    }
    info = {
      materials: mats,
      seatMaterials: mats.filter((m) => m.name.startsWith(SEAT_PREFIX)).map((m) => m.name),
      cabinMaterial: null,
      cabinTris: null,
      // The tools refuse a skin only when something is actually weighted to it.
      skinned: (j.skins || []).length > 0 && joints,
      color0Prims,
      color0Foreign,
    };
    const cab = cabinOf(info, null);
    if (cab) { info.cabinMaterial = cab.name; info.cabinTris = cab.tris; }
  } catch (e) {
    info = { error: String(e.message || e) };
  }
  infoCache.set(p, { key, info });
  return info;
}
/* The black cabin material of a file, or null: the name the chain's
   cabin-black run was given (hint), else Interior_Black, else one carrying
   cabin-black's marker -- and only one that still has geometry. */
function cabinOf(info, hint) {
  if (!info || !info.materials) return null;
  for (const n of [hint, CABIN_DEFAULT]) {
    const m = n && info.materials.find((x) => x.name === n && x.prims > 0);
    if (m) return m;
  }
  return info.materials.find((m) => m.cabin && m.prims > 0) || null;
}
/* The --name of the newest cabin-black draft in a chain (its sidecar's
   args), or null: the name a cabin material was given, which Save and
   status cannot tell from the file alone. */
function cabinHint(id, drafts) {
  for (let i = drafts.length - 1; i >= 0; i--) {
    if (drafts[i].tool !== "cabin-black") continue;
    const meta = drafts[i].meta !== undefined ? drafts[i].meta : readMeta(id, drafts[i]);
    const a = (meta && meta.args) || [];
    for (let k = 0; k < a.length; k++) {
      if (a[k] === "--name" && k + 1 < a.length) return a[k + 1];
      const m = /^--name=(.+)$/s.exec(a[k]);
      if (m) return m[1];
    }
    if (meta) return CABIN_DEFAULT;
  }
  return null;
}
/* info with its cabin worked out again under a hint (a --name the file
   alone does not reveal). */
function withCabin(info, hint) {
  if (!hint || info.error) return info;
  const cab = cabinOf(info, hint);
  return { ...info, cabinMaterial: cab ? cab.name : null, cabinTris: cab ? cab.tris : null };
}
/* The seat name to put in a missing seat slot: the first seat material that
   still has geometry (an --append mishap can leave an empty one), else the
   first. */
function seatNameOf(info) {
  if (!info || !info.materials) return null;
  const seats = info.materials.filter((m) => m.name.startsWith(SEAT_PREFIX));
  return (seats.find((m) => m.prims > 0) || seats[0] || {}).name || null;
}

/* ── index.html's registry ────────────────────────────────────────────────── */
/* The CARS registry is plain JS inside index.html. A car's entry is found by
   its `src: "assets/<file>[?v=N]"` string (exactly one, or it is reported, not
   guessed at), then the enclosing `model: {` is walked as JS -- strings,
   template literals, // and block comments, bracket nesting -- so a key is
   only taken at the right depth and a brace inside a comment ("the Camry's
   look: {...}") never closes anything. Only that entry's text is edited. */
function scanJs(src, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [src[open]];
  const strings = [], keys = [];
  let i = open + 1, lastSig = open, prevSig = src[open];
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, val = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { val += src[j + 1]; j += 2; continue; }
        if (c !== "`" && src[j] === "\n") return null;
        val += src[j++];
      }
      if (j >= src.length) return null;
      strings.push({ value: val, start: i, end: j + 1, depth: stack.length });
      lastSig = j; prevSig = c; i = j + 1;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (pairs[c]) { stack.push(c); lastSig = i; prevSig = c; i++; continue; }
    if (c === "}" || c === "]" || c === ")") {
      if (pairs[stack[stack.length - 1]] !== c) return null;
      stack.pop();
      if (!stack.length) return { open, close: i, strings, keys, lastSig };
      lastSig = i; prevSig = c; i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      if (src[k] === ":" && (prevSig === "{" || prevSig === ",") && stack[stack.length - 1] === "{") {
        keys.push({ name: src.slice(i, j), start: i, colon: k, depth: stack.length });
      }
      lastSig = j - 1; prevSig = "w"; i = j;
      continue;
    }
    lastSig = i; prevSig = c; i++;
  }
  return null;
}
/* The next character that is not whitespace or a comment. */
function nextSig(src, i) {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src[i] === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return -1; i = e + 2; continue; }
    return i;
  }
  return -1;
}
function srcRegex(file) { return new RegExp(`(src:\\s*"assets/${escRe(file)})(\\?v=(\\d+))?"`, "g"); }

/* { found, error?, version, lookNames, seat, lengthMm, hasLook, hasSeat, and
   the scan positions updateRegistry needs }. */
function registryEntry(html, file) {
  const hits = [...html.matchAll(srcRegex(file))];
  if (hits.length !== 1) return { found: false, error: `expected one registry src for ${file} in index.html, found ${hits.length}`, lookNames: [], seat: [], lengthMm: null };
  const srcIdx = hits[0].index;
  const back = html.slice(Math.max(0, srcIdx - 4000), srcIdx);
  const mm = [...back.matchAll(/\bmodel\s*:\s*\{/g)].pop();
  const bad = (why) => ({ found: false, error: `the registry entry for ${file} ${why}`, lookNames: [], seat: [], lengthMm: null });
  if (!mm) return bad("has no `model: {` before its src");
  const modelOpen = srcIdx - back.length + mm.index + mm[0].length - 1;
  const model = scanJs(html, modelOpen);
  if (!model || model.close < srcIdx) return bad("could not be read as JS (unbalanced brackets or quotes)");
  const own = (scan, name) => scan.keys.find((k) => k.depth === 1 && k.name === name);
  const srcKey = own(model, "src");
  if (!srcKey || srcKey.start !== srcIdx) return bad("has its src somewhere other than directly in model");
  const e = { found: true, version: hits[0][3] ? Number(hits[0][3]) : 1, model, lookKey: own(model, "look"), look: null, lookNames: [], seat: [], seatKey: null, slots: {}, slotKeys: {}, slotArrays: {}, lengthMm: null };
  if (e.lookKey) {
    const lo = nextSig(html, e.lookKey.colon + 1);
    if (lo >= 0 && html[lo] === "{") e.look = scanJs(html, lo);
    if (e.look) {
      e.lookNames = [...new Set(e.look.strings.map((s) => s.value))];
      /* Every slot of the look: its key, and when its value is an array
         literal, the array's scan (where Save appends a name) and names. */
      for (const k of e.look.keys.filter((x) => x.depth === 1)) {
        e.slotKeys[k.name] = k;
        const so = nextSig(html, k.colon + 1);
        const arr = so >= 0 && html[so] === "[" ? scanJs(html, so) : null;
        if (arr) { e.slotArrays[k.name] = arr; e.slots[k.name] = arr.strings.filter((s) => s.depth === 1).map((s) => s.value); }
      }
      e.seatKey = e.slotKeys.seat || null;
      e.seat = e.slots.seat || [];
    }
  }
  const lk = own(model, "lengthMm");
  if (lk) {
    const m = /^\s*(\d+(?:\.\d+)?)/.exec(html.slice(lk.colon + 1, lk.colon + 40));
    if (m) e.lengthMm = Math.round(Number(m[1]));
  }
  e.hasLook = !!e.lookKey;
  e.hasSeat = !!e.seatKey;
  return e;
}
/* Adds `prop` as the last property of the object scanned as `scan`, in the
   object's own layout: on one line `{ a, prop }`; across lines, a new line at
   the last property's indent, with a trailing comma when the others have
   one. A comment after the last property stays where it is. An array scan
   works the same way, `prop` then being an element: ["a", prop], or [prop]
   for an empty one. */
function insertProp(html, scan, prop, eol) {
  const { open, close, lastSig } = scan;
  const empty = lastSig <= open;
  const lineEndOf = (i) => { let e = html.indexOf("\n", i); if (e < 0) e = html.length; if (html[e - 1] === "\r") e--; return e; };
  const sameLine = !html.slice(open, close).includes("\n") || lineEndOf(empty ? open : lastSig) >= close;
  if (empty) {
    if (sameLine) return html.slice(0, open) + (html[open] === "[" ? "[" + prop + "]" : "{ " + prop + " }") + html.slice(close + 1);
    const lineStart = html.lastIndexOf("\n", open) + 1;
    const indent = /^[ \t]*/.exec(html.slice(lineStart))[0] + "  ";
    const at = lineEndOf(open);
    return html.slice(0, at) + eol + indent + prop + "," + html.slice(at);
  }
  const trailing = html[lastSig] === ",";
  if (sameLine) return html.slice(0, lastSig + 1) + (trailing ? "" : ",") + " " + prop + html.slice(lastSig + 1);
  const lineStart = html.lastIndexOf("\n", lastSig) + 1;
  const indent = /^[ \t]*/.exec(html.slice(lineStart))[0];
  let out = html, at = lineEndOf(lastSig);
  if (!trailing) { out = out.slice(0, lastSig + 1) + "," + out.slice(lastSig + 1); at++; }
  return out.slice(0, at) + eol + indent + prop + (trailing ? "," : "") + out.slice(at);
}

let indexCache = null;
function readIndex() {
  const st = fs.statSync(INDEX);
  if (!indexCache || indexCache.mtimeMs !== st.mtimeMs || indexCache.size !== st.size) {
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, html: fs.readFileSync(INDEX, "utf8") };
  }
  return indexCache.html;
}
function registryInfo(file) {
  let e;
  try { e = registryEntry(readIndex(), file); } catch (err) { return { found: false, lookNames: [], seat: [], interior: [], slots: {}, lengthMm: null, error: "index.html: " + err.message }; }
  const out = { found: e.found, lookNames: e.lookNames, seat: e.seat, interior: (e.slots && e.slots.interior) || [], slots: e.slots || {}, lengthMm: e.lengthMm };
  if (e.error) out.error = e.error;
  return out;
}

/* Bumps the car's ?v= and, given `seatName`, adds the seat slot when the look
   has none; given `cabinName`, adds it to the interior slot when the look
   does not list it there (appended to the array, or a new interior slot).
   Never throws for a registry problem: it reports it. */
async function updateRegistry(file, { seatName, cabinName = null }) {
  let html = await fsp.readFile(INDEX, "utf8");
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  let e = registryEntry(html, file);
  if (!e.found) return { ok: false, error: e.error, version: null, seatAdded: false, seatNeeded: !!seatName, interiorAdded: false, interiorNeeded: !!cabinName };
  let seatAdded = false, seatNeeded = false;
  if (seatName && !e.hasSeat) {
    const seatProp = `seat: [${JSON.stringify(seatName)}]`;
    let next = null;
    if (e.look) next = insertProp(html, e.look, seatProp, eol);
    else if (!e.lookKey) next = insertProp(html, e.model, `look: { ${seatProp} }`, eol);
    // look: SOME_CONSTANT -- not ours to edit. Re-read the result: the edit
    // stands only if the entry still parses and now names the seat.
    const check = next && registryEntry(next, file);
    if (check && check.found && check.seat.includes(seatName)) { html = next; e = check; seatAdded = true; } else seatNeeded = true;
  }
  let interiorAdded = false, interiorNeeded = false;
  if (cabinName && !(e.slots.interior || []).includes(cabinName)) {
    /* Into the entry as it stands after the seat edit (e was re-read), so a
       look-less entry gets look: { seat: [...], interior: [...] }. */
    const lit = JSON.stringify(cabinName);
    let next = null;
    if (e.slotArrays.interior) next = insertProp(html, e.slotArrays.interior, lit, eol);
    else if (e.slotKeys.interior) next = null; // interior: SOME_CONSTANT -- not ours to edit
    else if (e.look) next = insertProp(html, e.look, `interior: [${lit}]`, eol);
    else if (!e.lookKey) next = insertProp(html, e.model, `look: { interior: [${lit}] }`, eol);
    const check = next && registryEntry(next, file);
    if (check && check.found && (check.slots.interior || []).includes(cabinName) && check.seat.join("\u0001") === e.seat.join("\u0001")) {
      html = next; interiorAdded = true;
    } else interiorNeeded = true;
  }
  let version = null;
  html = html.replace(srcRegex(file), (_, head, __, v) => { version = (Number(v) || 1) + 1; return `${head}?v=${version}"`; });
  const tmp = INDEX + ".lab-tmp";
  await fsp.writeFile(tmp, html);
  await fsp.rename(tmp, INDEX);
  indexCache = null;
  return { ok: true, version, seatAdded, seatNeeded, interiorAdded, interiorNeeded };
}

/* The look names a black cabin covers (see Save, step 0): of `missing` (look
   names the candidate lacks), those listed only under the cabin slots, when
   the candidate has the cabin material -- every triangle of a material
   cabin-black removed went into it -- or, for the cabin material's own name
   (cabinNames: Interior_Black, the chain's --name, the shipped file's), when
   another interior name is in the candidate: the file from before the cabin
   went black, whose own interior materials the look still paints. */
function coveredNames(reg, missing, names, cabin, cabinNames) {
  const slots = reg.slots || {};
  const onlyCabin = (n) => {
    const where = Object.keys(slots).filter((s) => slots[s].includes(n));
    return where.length > 0 && where.every((s) => CABIN_SLOTS.includes(s));
  };
  const otherInterior = (slots.interior || []).some((n) => names.has(n) && !cabinNames.has(n));
  return missing.filter((n) => onlyCabin(n) && (cabin ? true : cabinNames.has(n) && otherInterior));
}

/* The check before Save and Restore touch anything: is `candidate` a GLB, is
   the car in the registry, and does it still carry every name its look uses
   (bar the ones the black cabin covers)? Returns {refuse: null | [status,
   body], covered: [names], cabin: the candidate's cabin material or null}. */
function preflight(file, candidate, force, hint = null) {
  const info = glbInfo(candidate);
  if (info.error) return { refuse: [400, { ok: false, error: `${path.basename(candidate)} is not a readable GLB: ${info.error}` }], covered: [], cabin: null };
  const reg = registryInfo(file);
  const names = new Set(info.materials.map((m) => m.name));
  const cabin = cabinOf(info, hint);
  const shippedCabin = cabinOf(glbInfo(path.join(ASSETS, file)), hint);
  const cabinNames = new Set([CABIN_DEFAULT, hint, shippedCabin && shippedCabin.name, cabin && cabin.name].filter(Boolean));
  const covered = reg.found ? coveredNames(reg, reg.lookNames.filter((n) => !names.has(n)), names, cabin, cabinNames) : [];
  const go = { refuse: null, covered, cabin };
  if (force) return go;
  if (!reg.found) {
    return { ...go, refuse: [409, { ok: false, error: `${reg.error}; nothing was changed. Save anyway (the file is replaced, index.html is not) with force.`, missing: [], needForce: true }] };
  }
  const missing = reg.lookNames.filter((n) => !names.has(n) && !covered.includes(n));
  if (missing.length) {
    /* Say which misses are NEW. The Altima, Maxima and Sentra ship without
       the Driver_Seat their look names (the seat has to be cut again), and
       both Sportages without "Sparkling Silver": saving one of those after an
       unrelated edit loses nothing the site paints today, and "would stop
       painting it" sent the user hunting for a regression that was not
       there. Still refused: the look and the file disagree either way, and
       force is one confirm away. */
    const shipped = glbInfo(path.join(ASSETS, file));
    const shippedNames = shipped.materials ? new Set(shipped.materials.map((m) => m.name)) : null;
    const already = shippedNames ? missing.filter((n) => !shippedNames.has(n)) : [];
    const lost = missing.filter((n) => !already.includes(n));
    const q = (list) => list.map((n) => JSON.stringify(n)).join(", ");
    const parts = [];
    if (lost.length) parts.push(`${q(lost)}, which ${lost.length > 1 ? "are" : "is"} not in ${path.basename(candidate)}: the site would stop painting ${lost.length > 1 ? "them" : "it"}`);
    if (already.length) parts.push(`${q(already)}, which the shipped ${file} lacks too (the site does not paint ${already.length > 1 ? "them" : "it"} today either${already.some((n) => n.startsWith(SEAT_PREFIX)) ? "; cut the seat in the Seat tab first" : ""})`);
    return { ...go, refuse: [409, { ok: false, error: `the car's look in index.html names ${parts.join("; and ")}. Nothing was changed; fix the look (or the file), or pass force.`, missing, alreadyMissing: already, covered, needForce: true }] };
  }
  return go;
}

function carStatus(file) {
  const id = carId(file);
  const drafts = listDrafts(id);
  const last = drafts[drafts.length - 1];
  const infoPath = last ? path.join(DRAFTS, id, last.file) : path.join(ASSETS, file);
  /* The newest finished job of this car, so a page reloaded after a job
     ended can still show its result (status.busy only names a RUNNING one). */
  let lastJob = null;
  const lastJobByTool = {};
  for (const j of jobs.values()) if (j.file === file && j.state !== "running") { lastJob = j.id; lastJobByTool[j.tool] = j.id; }
  const listed = withMeta(id, drafts);
  return {
    file, id,
    bytes: size(path.join(ASSETS, file)),
    original: size(path.join(BACKUP, file)) !== null ? { bytes: size(path.join(BACKUP, file)) } : null,
    history: listHistory(id),
    drafts: listed,
    lastJob,
    lastJobByTool,
    // The cabin material under the name the chain's cabin-black run gave it.
    info: { from: last ? `draft ${last.n}` : "shipped", ...withCabin(glbInfo(infoPath), cabinHint(id, listed)), registry: registryInfo(file) },
  };
}

/* Atomic replace: a browser that fetches the car mid-copy must never get half
   a file. rename() within one volume is atomic on Windows and POSIX. */
async function installFile(src, dest) {
  const tmp = dest + ".lab-tmp";
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}
const sha1 = async (p) => crypto.createHash("sha1").update(await fsp.readFile(p)).digest("hex");
async function backupCurrent(file) {
  await fsp.mkdir(HISTORY, { recursive: true });
  const id = carId(file);
  const cur = path.join(ASSETS, file);
  const orig = path.join(BACKUP, file);
  // The first save keeps the original, once; EXCL so a second never replaces it.
  try { await fsp.copyFile(cur, orig, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== "EEXIST") throw e; }
  /* Restoring back and forth used to pile up identical copies: a version
     already in the history is not copied again. */
  const curSize = size(cur);
  let curHash = null;
  for (const h of listHistory(id)) {
    if (h.bytes !== curSize) continue;
    curHash = curHash || await sha1(cur);
    if (await sha1(path.join(HISTORY, h.name)) === curHash) return { name: h.name, reused: true };
  }
  const base = `${id}-${stamp()}`;
  for (let k = 1; k <= 50; k++) {
    const name = base + (k > 1 ? `-${k}` : "") + ".glb";
    try {
      await fsp.copyFile(cur, path.join(HISTORY, name), fs.constants.COPYFILE_EXCL);
      return { name, reused: false };
    } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  throw new Error("could not find a free history name for " + base);
}

/* ── jobs ─────────────────────────────────────────────────────────────────── */
const jobs = new Map();
let busy = null; // {kind, id?, file} -- a job, or a save/restore/discard/undo in flight
let nextJob = 1;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* Absolute paths in a log or a result, made relative: the draft folder the
   tool ran in vanishes (the file names are relative to it -- it is the cwd),
   the rest reads relative to the site or the repo. A partial-<n>-<tool>.glb
   is reported under the name it gets on success. */
function shortener(id) {
  const pairs = [
    [path.join(DRAFTS, id) + path.sep, ""],
    [DRAFTS + path.sep, "drafts/"],
    [ASSETS + path.sep, "assets/"],
    [BACKUP + path.sep, "backup/"],
    [SITE + path.sep, "site/"],
    [ROOT + path.sep, ""],
  ];
  const res = [];
  for (const [abs, rel] of pairs) {
    for (const form of new Set([abs, abs.replace(/\\/g, "/"), abs.replace(/\\/g, "\\\\")])) {
      res.push([new RegExp(escRe(form), process.platform === "win32" ? "gi" : "g"), rel]);
    }
  }
  return (s) => {
    for (const [re, rel] of res) s = s.replace(re, rel);
    return s.replace(/partial-(\d+-[a-z0-9-]+\.glb)/g, "$1");
  };
}
function deepMap(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => deepMap(x, f));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = deepMap(v[k], f); return o; }
  return v;
}
/* What a poll returns: the tail only, each line reduced to what a terminal
   would show after its \r progress rewrites (the AO bake writes ~70 of them
   on one line), without the LAB_JSON line (it is `result`, and mesh-strip's
   can be bigger than the whole tail). */
function logTail(job) {
  const lines = [];
  for (let l of job.log.split("\n")) {
    if (l.startsWith("LAB_JSON ")) continue;
    l = l.replace(/\r+$/, "");
    const r = l.lastIndexOf("\r");
    lines.push(r >= 0 ? l.slice(r + 1) : l);
  }
  let out = job.shorten(lines.join("\n"));
  if (out.length > LOG_SENT) {
    out = out.slice(-LOG_SENT);
    const nl = out.indexOf("\n"); // start at a whole line, unless that loses most of the tail
    out = "[lab] ...\n" + (nl >= 0 && nl < 2000 ? out.slice(nl + 1) : out);
  }
  return out;
}
function jobView(job) {
  return {
    id: job.id, file: job.file, tool: job.tool, args: job.args, report: job.report, state: job.state,
    opKey: job.opKey, replace: job.replace,
    input: job.input, started: job.started, ms: job.ms ?? null, exitCode: job.exitCode ?? null,
    log: logTail(job), result: job.result, draft: job.draft,
  };
}
function pruneJobs() {
  for (const [k, j] of jobs) {
    if (jobs.size <= JOBS_KEPT) break;
    if (j.state !== "running") jobs.delete(k);
  }
}

/* replace: the {newest, meta, base} replaceTarget() approved, or null. A
   replace run reads `base` (the draft before the newest, or the shipped
   file) instead of the newest draft, writes partial-<n>-<tool>.glb under the
   newest's own number, and only when it succeeded renames it over the newest
   draft (same name, so the swap is one atomic rename) and rewrites the
   sidecar. A failed one leaves the newest draft and its sidecar as they
   were. */
function runJob({ file, tool, args, report, opKey = null, replace = null }) {
  const id = carId(file);
  const dir = path.join(DRAFTS, id);
  /* The tool's cwd is the car's draft folder, so even a path the server did
     not choose could only land among this car's drafts -- never in the repo.
     A report run removes the folder again if it made it. */
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith("partial-")) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* retried next run */ } }
  sweepOrphanMeta(dir);
  const drafts = listDrafts(id);
  const last = replace ? replace.base : drafts[drafts.length - 1];
  const input = last ? path.join(dir, last.file) : path.join(ASSETS, file);
  const n = replace ? replace.newest.n : (last ? last.n : 0) + 1;
  const finalName = `${n}-${tool}.glb`;
  const output = report ? null : path.join(dir, "partial-" + finalName);
  const job = {
    id: `${BOOT}-${nextJob++}`, file, tool, args, report: !!report, opKey, replace: !!replace, state: "running", log: "", result: null, draft: null,
    started: Date.now(), input: last ? `drafts/${id}/${last.file}` : `assets/${file}`, shorten: shortener(id),
  };
  Object.defineProperty(job, "shorten", { enumerable: false });
  jobs.set(job.id, job);
  pruneJobs();
  busy = { kind: "job", id: job.id, file };

  const cli = [path.join(TOOLS_DIR, TOOLS[tool]), input];
  if (output) cli.push(output);
  cli.push(...args);
  if (report && !args.some((a) => REPORT_FLAGS.includes(a))) cli.push("--report");
  if (!args.includes("--json")) cli.push("--json");
  const take = (chunk) => { job.log = (job.log + chunk.toString()).slice(-LOG_KEPT); };

  let finished = false, timer = null;
  /* Runs once, on close or on a spawn error, and whatever throws in here
     (an antivirus EBUSY on the rename is common on Windows) the job ends and
     busy is released: a stuck busy locked the whole lab until a restart. */
  async function finish(code, err) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      if (err) job.log += `\n[lab] could not run the tool: ${err.message}\n`;
      const line = job.log.split("\n").reverse().find((l) => l.startsWith("LAB_JSON "));
      try { job.result = line ? deepMap(JSON.parse(line.slice(9)), job.shorten) : null; } catch (e) { job.result = null; }
      let ok = !err && code === 0 && (!job.result || job.result.ok !== false);
      if (output && fs.existsSync(output)) {
        if (ok && size(output) > 0) {
          let bad = null;
          try { readGlbJson(output); } catch (e) { bad = e.message; }
          if (bad) { ok = false; job.log += `\n[lab] the tool wrote a file that is not a GLB (${bad}); not keeping it\n`; }
        }
        if (ok && size(output) > 0) {
          /* On a replace this rename lands on the newest draft itself; the old
             sidecar beside it stops matching (bytes / t) at that instant, so
             the window before the new one is written reads meta: null. */
          for (let t = 0; ; t++) {
            try { await fsp.rename(output, path.join(dir, finalName)); break; } catch (e) { if (t >= 5) throw e; await delay(200); }
          }
          const d = listDrafts(id).find((x) => x.n === n) || null;
          if (d) {
            const r = job.result || {};
            const variation = (r.summary && r.summary.variation) || null;
            const seed = seedArg(args) ?? (variation && Number.isInteger(variation.seed) ? variation.seed : null);
            const meta = {
              n, tool, opKey, args, seed, variation, checks: r.checks || [], bytes: d.bytes, t: d.t,
              time: new Date().toISOString(), job: job.id, input: last ? `draft ${last.n}` : "shipped",
              replaces: replace ? ((replace.meta && replace.meta.replaces) || 0) + 1 : 0,
            };
            if (SIDECAR_SUMMARY.has(tool) && r.summary && typeof r.summary === "object") meta.summary = r.summary;
            try { await writeMeta(dir, finalName, meta); } catch (e) {
              // The draft stands (it passed); only its record is missing.
              job.log += `\n[lab] could not write the draft's record (${e.message}); Try another needs it, so Undo and run again\n`;
            }
            job.draft = { ...d, meta: readMeta(id, d) };
          }
        } else {
          await fsp.rm(output, { force: true, maxRetries: 5, retryDelay: 200 }); // a failed run never becomes a draft
        }
      }
      job.state = ok ? "done" : "failed";
    } catch (e) {
      job.state = "failed";
      job.log += `\n[lab] ${e.message}\n`;
    } finally {
      job.exitCode = err ? null : code;
      job.ms = Date.now() - job.started;
      removeIfEmpty(dir);
      if (busy && busy.id === job.id) busy = null;
    }
  }
  let child;
  try {
    child = spawn(process.execPath, cli, { cwd: dir, windowsHide: true });
  } catch (e) {
    finish(null, e);
    return job;
  }
  timer = setTimeout(() => { job.log += "\n[lab] timed out, killing\n"; child.kill(); }, JOB_TIMEOUT_MS);
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("error", (e) => finish(null, e));
  child.on("close", (code) => finish(code, null));
  return job;
}

/* ── http ─────────────────────────────────────────────────────────────────── */
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(data);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function readJson(req) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, "body too large"); }
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw new HttpError(400, "body is not JSON"); }
}

/* The Host allow-list, filled in once the port is known (--port 0 picks one). */
let LOCAL_HOSTS = new Set(), LAN_HOST = null;
function setHosts(port) {
  LOCAL_HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (port === 80) for (const h of ["localhost", "127.0.0.1", "[::1]"]) LOCAL_HOSTS.add(h);
  if (HOST) LAN_HOST = (net.isIPv6(HOST) ? `[${HOST}]` : HOST) + (port === 80 ? "" : `:${port}`);
}
function hostKind(req) {
  const h = String(req.headers.host || "").toLowerCase();
  if (LOCAL_HOSTS.has(h)) return "local";
  if (LAN_HOST && h === LAN_HOST.toLowerCase()) return "lan";
  return null;
}
function tokenOk(x, kind) {
  if (typeof x !== "string") return false;
  if ((kind === "local" || (kind === "lan" && OPEN)) && x === "1") return true;
  const a = Buffer.from(x), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const LOCKED = { "/__lab/save": "save", "/__lab/restore": "restore", "/__lab/discard": "discard", "/__lab/undo": "undo" };

async function api(req, res, url) {
  const p = url.pathname;
  const kind = hostKind(req);
  if (!kind) return send(res, 403, { ok: false, error: `Host ${JSON.stringify(req.headers.host || "")} is not this lab server (open it as localhost)` });
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let oh = null;
    try { oh = new URL(origin).host; } catch (e) { /* "null" or junk */ }
    if (!oh || oh.toLowerCase() !== String(req.headers.host).toLowerCase()) return send(res, 403, { ok: false, error: "cross-origin" });
  }
  if (req.method === "POST" && !tokenOk(req.headers["x-lab"], kind)) {
    return send(res, 403, { ok: false, error: kind === "lan" && !OPEN ? "this request needs the lab token: open the URL the server printed (…#lab=<token>)" : "missing X-Lab header" });
  }

  if (req.method === "GET" && p === "/__lab/status") {
    const cars = fs.readdirSync(ASSETS).filter((f) => validCar(f)).sort().map(carStatus);
    return send(res, 200, { ok: true, tools: Object.keys(TOOLS), busy, cars, auth: kind === "local" || OPEN ? "local" : "token", boot: BOOT });
  }
  let m;
  if (req.method === "GET" && (m = /^\/__lab\/job\/([a-z0-9]+-\d+)$/.exec(p))) {
    const job = jobs.get(m[1]);
    return job ? send(res, 200, { ok: true, job: jobView(job) }) : send(res, 404, { ok: false, error: "no such job (the server may have restarted)" });
  }
  if (req.method === "GET" && (m = /^\/__lab\/draft\/([a-z0-9-]+)\/(\d+)\.glb$/.exec(p))) {
    const f = draftPath(m[1], Number(m[2]));
    let data = null;
    try { data = f && await fsp.readFile(f); } catch (e) { /* dropped since it was listed */ }
    if (!data) return send(res, 404, { ok: false, error: "no such draft" });
    return send(res, 200, data, MIME[".glb"]);
  }
  if (req.method !== "POST") return send(res, 404, { ok: false, error: "unknown endpoint" });

  const body = await readJson(req);
  const assetPath = validCar(body.file);
  if (!assetPath) return send(res, 400, { ok: false, error: "unknown car file" });
  const id = carId(body.file);

  if (p === "/__lab/run") {
    if (busy) return send(res, 409, { ok: false, error: busy.kind === "job" ? "a job is already running" : `a ${busy.kind} is in progress`, busy });
    if (!TOOLS[body.tool]) return send(res, 400, { ok: false, error: "unknown tool" });
    const args = body.args === undefined ? [] : body.args;
    const bad = validArgs(body.tool, args);
    if (bad) return send(res, 400, { ok: false, error: `arg ${bad.index + 1}${bad.arg != null ? " " + JSON.stringify(bad.arg) : ""}: ${bad.why}`, arg: bad.arg, index: bad.index });
    const report = !!body.report || args.some((a) => REPORT_FLAGS.includes(a));
    const opKey = body.opKey === undefined || body.opKey === null ? null : body.opKey;
    if (opKey !== null && (typeof opKey !== "string" || !OPKEY_RE.test(opKey))) return send(res, 400, { ok: false, error: "opKey must be a short name of lowercase letters, digits and - (e.g. seat-auto)" });
    if (body.replace !== undefined && typeof body.replace !== "boolean") return send(res, 400, { ok: false, error: "replace must be true or false" });
    let replace = null;
    if (body.replace) {
      if (report) return send(res, 400, { ok: false, error: "replace swaps the newest draft for a new result; a Check (report / --dry-run) writes nothing to swap in" });
      if (opKey === null) return send(res, 400, { ok: false, error: "replace needs the opKey of the action whose result it replaces" });
      const t = replaceTarget(id, body.tool, opKey);
      if (t.error) return send(res, 409, { ok: false, error: t.error, cannotReplace: true, newest: t.newest });
      replace = t;
    }
    const job = runJob({ file: body.file, tool: body.tool, args, report, opKey, replace });
    return send(res, 200, { ok: true, job: { id: job.id, replace: !!replace, n: replace ? replace.newest.n : null } });
  }
  const lock = LOCKED[p];
  if (!lock) return send(res, 404, { ok: false, error: "unknown endpoint" });
  if (busy) return send(res, 409, { ok: false, error: busy.kind === "job" ? "a job is running; wait for it" : `a ${busy.kind} is in progress`, busy });
  /* Taken before the first await below and released in finally, so a run
     can never start on a draft this handler is about to delete or install. */
  busy = { kind: lock, file: body.file };
  try {
    const dropDrafts = () => fsp.rm(path.join(DRAFTS, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (lock === "discard") {
      await dropDrafts();
      return send(res, 200, { ok: true, car: carStatus(body.file) });
    }
    if (lock === "undo") {
      const drafts = listDrafts(id);
      if (!drafts.length) return send(res, 400, { ok: false, error: "nothing to undo: no draft" });
      const lastD = drafts[drafts.length - 1];
      const meta = readMeta(id, lastD);
      await fsp.rm(path.join(DRAFTS, id, lastD.file), { force: true, maxRetries: 5, retryDelay: 200 });
      // Its sidecar goes with it (a failure here leaves an orphan the next job sweeps).
      await fsp.rm(path.join(DRAFTS, id, metaFile(lastD.file)), { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      removeIfEmpty(path.join(DRAFTS, id));
      return send(res, 200, { ok: true, dropped: { n: lastD.n, tool: lastD.tool, meta }, car: carStatus(body.file) });
    }
    let from, chain = null;
    if (lock === "save") {
      const drafts = listDrafts(id);
      if (!drafts.length) return send(res, 400, { ok: false, error: "nothing to save: no draft" });
      from = path.join(DRAFTS, id, drafts[drafts.length - 1].file);
      /* What went into the saved file (the drafts stack, so all of them), read
         before the folder is dropped: the answer is the last place the seeds
         and variant params of a saved car exist. */
      chain = withMeta(id, drafts).map((d) => ({ n: d.n, tool: d.tool, meta: d.meta }));
    } else {
      from = body.from === "original" ? path.join(BACKUP, body.file)
        : (typeof body.from === "string" && historyRe(id).test(body.from)) ? path.join(HISTORY, body.from) : null;
      if (!from || !fs.existsSync(from)) return send(res, 400, { ok: false, error: "no such backup" });
    }
    /* The cabin material's name: a Save knows the --name its chain's
       cabin-black run used; a Restore goes by Interior_Black or the marker. */
    const hint = chain ? cabinHint(id, chain) : null;
    const pre = preflight(body.file, from, !!body.force, hint);
    if (pre.refuse) return send(res, pre.refuse[0], pre.refuse[1]);
    const before = size(assetPath);
    const hist = await backupCurrent(body.file);
    await installFile(from, assetPath);
    let reg;
    const cabinName = pre.cabin ? pre.cabin.name : null;
    try { reg = await updateRegistry(body.file, { seatName: seatNameOf(glbInfo(assetPath)), cabinName }); } catch (e) { reg = { ok: false, error: "index.html: " + e.message, version: null, seatAdded: false, seatNeeded: false, interiorAdded: false, interiorNeeded: false }; }
    reg.interiorCovered = pre.covered;
    reg.cabinMaterial = cabinName;
    await dropDrafts();
    const out = { ok: true, bytesBefore: before, bytesAfter: size(assetPath), backup: hist.name, backupReused: hist.reused, registry: reg, car: carStatus(body.file) };
    if (chain) out.chain = chain;
    return send(res, 200, out);
  } finally {
    busy = null;
  }
}

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, "bad path", "text/plain"); }
  if (rel.includes("\0")) return send(res, 400, "bad path", "text/plain");
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE + path.sep) && file !== SITE) return send(res, 403, "forbidden", "text/plain");
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) return send(res, 301, "", "text/plain", { Location: url.pathname + "/" + url.search });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    send(res, 404, "not found", "text/plain");
  }
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { return send(res, 400, "bad request", "text/plain"); }
  try {
    if (url.pathname.startsWith("/__lab/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain");
    return await serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    send(res, e instanceof HttpError ? e.status : 500, { ok: false, error: String(e && e.message || e) });
  }
}

/* Sweep partial drafts and sidecars a killed server left behind, and
   sidecars whose draft is gone; listDrafts and readMeta ignore them anyway,
   this only frees the space (and lets an emptied folder go). */
try {
  for (const car of fs.readdirSync(DRAFTS)) {
    const dir = path.join(DRAFTS, car);
    try { for (const f of fs.readdirSync(dir)) if (f.startsWith("partial-")) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* not a folder */ }
    sweepOrphanMeta(dir);
  }
} catch (e) { /* no drafts yet */ }

const server = http.createServer(handle);
const onListenError = (where, fatal) => (e) => {
  if (!fatal) {
    /* ::1 is a convenience (a browser may try "localhost" as ::1 first); a
       machine without IPv6 still works. Taken by another server, though,
       localhost may reach THAT server -- say so. */
    if (e.code === "EADDRINUSE") console.error(`note: [::1]:${PORT} is taken by another server; if the page says the lab server is missing, open http://127.0.0.1:${PORT}/?tune=1`);
    return;
  }
  if (e.code === "EADDRINUSE") console.error(`port ${PORT} is busy on ${where} -- stop \`npx serve\` (or pass --port 3100)`);
  else if (e.code === "EADDRNOTAVAIL") console.error(`${where} is not an address of this PC (--host wants this PC's own LAN ip)`);
  else console.error(e);
  process.exit(1);
};
server.on("error", onListenError("127.0.0.1", true));
server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  setHosts(port);
  const v6 = http.createServer(handle);
  v6.on("error", onListenError("::1", false));
  v6.listen(port, "::1");
  const show = (p) => { const r = path.relative(ROOT, p); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p; };
  console.log(`car lab: http://localhost:${port}/?tune=1  (site: ${show(SITE)}, backups: ${show(BACKUP)}, drafts: ${show(DRAFTS)})`);
  if (HOST) {
    const lan = http.createServer(handle);
    lan.on("error", onListenError(HOST, true));
    lan.listen(port, HOST, () => {
      if (OPEN) console.log(`LAN:      http://${LAN_HOST}/?tune=1  (--open: no token needed)`);
      else {
        console.log(`LAN:      http://${LAN_HOST}/?tune=1#lab=${TOKEN}`);
        console.log("          (open exactly that URL on the phone: the #lab= token is what lets it run tools and save)");
      }
    });
  }
  console.log(`token:    ${TOKEN}  (X-Lab header; on localhost "1" also works)`);
});
