/* car3d-lab.jsx — experiments for the 3D car stage in index.html.

   Loaded ONLY when the page URL carries ?tune=1 (a tiny script just above the
   app's own <script type="text/babel"> adds it), so regular visitors never
   fetch it. Babel standalone compiles it in the browser like the app, and
   runs it first, because it sits earlier in the document.

   Needs a real web server — a file:// page cannot fetch it. Either:
     lab.cmd                            (double-click it in the REPO ROOT,
                                         C:\Users\ali\Desktop\3d-model: the lab
                                         server on this PC's Wi-Fi address,
                                         port 8001, with --open, so a phone
                                         needs no token; the build tabs can
                                         edit and save cars)
     node tools/lab-server.mjs          (from the REPO ROOT; localhost:3000 only.
                                         Run from visual-search-standalone it
                                         fails with "Cannot find module")
     npx serve -l 3000 .                (from visual-search-standalone; dials only)
   then open  http://localhost:3000/?tune=1  -- or, with lab.cmd, the
   http://<PC's IP>:8001/?tune=1 it prints (http://localhost:8001/?tune=1
   works on the PC too). A server started with --host <ip> but WITHOUT
   --open prints a URL ending in #lab=<key> instead: open exactly that one;
   the page sends the key with every request (labCall).

   ── What the app exposes, and what this file must provide ──────────────────
   The app reads window.car3dLab once, at start-up (CAR3D_LAB in index.html),
   and uses exactly this; anything else in here is private:
     values             live object: the dial values plus `replay`, a counter
                        whose every bump makes ModelLoader re-run the real
                        cube → car handover on the loaded model
     subscribe(fn)      call fn on every change; returns an unsubscribe
     revealLagMs()      car delay after the cube starts fading
     loaderFadeMs()     when the loader unmounts after its fade starts
     hotspotStaggerMs() when the hotspot dots arrive after the car
     applyMotionCss()   write the motion values into the page (called by the
                        app's Replay effect at the instant the car is hidden)
     REPLAY_HOLD_MS     how long a replay holds the cube up
     srcFor(src)        a draft URL to show instead of the car file, or null
                        (the build tabs' preview; see labPreview)
     carFor(car)        a car with a patched look for the previewed draft (a
                        seat slot, the black cabin's interior name), or null
     previewing()       whether a draft is on show (keeps the panel up even if
                        a draft fails to load, so you can switch back)
     Panel              React component {car, viewerRef}, rendered while the 3D
                        screen is open
   The build tabs (Export, Seat, Cabin, Gaps, Parts, Save) also talk to
   tools/lab-server.mjs over /__lab/ (see its header); with plain `npx serve`
   they just say the server is missing.
   Without this file the app uses its shipped constants and the same hooks do
   nothing, so deleting it — or dropping ?tune=1 — is always safe.

   ── Adding a new experiment ─────────────────────────────────────────────────
   A new value is one entry in CAR3D_TUNE_DEFAULTS plus one in CAR3D_DIALS.
   Then make it do something:
     - CSS-driven (timings, transforms, colours): add a rule to
       car3dApplyTuneCss. Use the app's own selectors so the real path is what
       is tested, and keep motion inside the no-preference media query.
     - a model-viewer attribute: read `lab.<key>` where CarStage3D renders
       <model-viewer> (see shadow-intensity there).
     - a JS timing: add a getter here, list it above, and read it through
       CAR3D_LAB in index.html next to car3dRevealLagMs.
   Keep each default equal to the shipped value, so opening the panel changes
   nothing until a dial moves. When an experiment wins, move its value into
   index.html and delete it from here. */
(function () {
const { useState, useEffect, useRef, useLayoutEffect } = React;

/* The arrival's curve. `settle` is the share of the duration by which that
   curve is visually done (the car within ~1% of its size); the hotspot beat
   waits that long, which for quint is the shipped 550ms of 900. */
const CAR3D_EASES = {
  quint:     { css: "cubic-bezier(0.22, 1, 0.36, 1)", settle: 0.61 },
  expo:      { css: "cubic-bezier(0.16, 1, 0.3, 1)", settle: 0.55 },
  cubic:     { css: "cubic-bezier(0.33, 1, 0.68, 1)", settle: 0.8 },
  overshoot: { css: "cubic-bezier(0.34, 1.56, 0.64, 1)", settle: 0.9 },
  linear:    { css: "linear", settle: 0.97 },
};
const CAR3D_TUNE_DEFAULTS = {
  arriveMs: 900, fadeMs: 350, startScale: 0.55, dropPct: -7, ease: "quint",
  cubeFadeMs: 150, revealLagMs: 100,
  shadowIntensity: 1, shadowSoftness: 0.45, exposure: 0.9,
};
const CAR3D_TUNE_STORE = "car3d-tune";
/* How long Replay holds the cube up before handing over, so the exit being
   judged comes out of a loader that has actually settled on screen. */
const CAR3D_TUNE_REPLAY_HOLD_MS = 1200;
/* `replay` is a counter, not a setting: bumping it re-runs the handover
   (see ModelLoader). It is never persisted. */
const car3dTune = { ...CAR3D_TUNE_DEFAULTS, replay: 0 };
const car3dTuneSubs = new Set();
function car3dTuneValues() {
  const out = {};
  for (const k of Object.keys(CAR3D_TUNE_DEFAULTS)) out[k] = car3dTune[k];
  return out;
}
function car3dApplyTuneCss() {
  let el = document.getElementById("car3d-tune-css");
  if (!el) { el = document.createElement("style"); el.id = "car3d-tune-css"; document.head.appendChild(el); }
  const t = car3dTune;
  /* Wrapped in no-preference so the reduced-motion rules keep winning, and
     under its own keyframe name so the shipped carArrive is left alone. The
     .mv-loader rule only reaches the EXIT: the entrance lives on the more
     specific [data-show="true"] rule. */
  el.textContent =
    "@media (prefers-reduced-motion: no-preference) {" +
    `.car-stage-3d[data-model-ready="true"] model-viewer { transition-duration: ${t.fadeMs}ms; animation: carArriveTune ${t.arriveMs}ms ${CAR3D_EASES[t.ease].css}; }` +
    `.mv-loader { transition-duration: ${t.cubeFadeMs}ms; }` +
    "}" +
    `@keyframes carArriveTune { from { transform: translateY(${t.dropPct}%) scale(${t.startScale}); } }`;
}
/* Stores, persists and notifies — but does NOT touch the motion CSS. Writing
   a new duration into the stylesheet while the car rests would hand its
   finished arrival a longer timeline, and Chrome resumes it mid-flight: drag
   Speed above the time since the reveal and the resting car jumps back and
   replays under the thumb. So the motion CSS is written only at start-up and
   by a replay, at the instant the car is hidden (see ModelLoader's Replay
   effect). Shadow and exposure are plain attributes and apply live. */
function setCar3dTune(patch) {
  Object.assign(car3dTune, patch);
  try { localStorage.setItem(CAR3D_TUNE_STORE, JSON.stringify(car3dTuneValues())); } catch (e) {}
  car3dTuneSubs.forEach((f) => f());
}
/* Saved values from the last session, then the motion CSS they describe. */
{
  try {
    const saved = JSON.parse(localStorage.getItem(CAR3D_TUNE_STORE) || "{}");
    for (const k of Object.keys(CAR3D_TUNE_DEFAULTS)) {
      if (typeof saved[k] === typeof CAR3D_TUNE_DEFAULTS[k]) car3dTune[k] = saved[k];
    }
    if (!CAR3D_EASES[car3dTune.ease]) car3dTune.ease = CAR3D_TUNE_DEFAULTS.ease;
  } catch (e) {}
  car3dApplyTuneCss();
}
/* Re-renders the caller whenever a dial moves (the panel's own hook; the app
   subscribes through window.car3dLab.subscribe instead). */
function useCar3dTune() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    car3dTuneSubs.add(f);
    return () => { car3dTuneSubs.delete(f); };
  }, []);
  return car3dTune;
}
/* The three JS timings the dials reach, handed to the app's hooks. Loader
   unmount stays 30ms behind the cube's fade, as MV_LOADER_FADE_MS does behind
   the stylesheet's 0.15s. */
const revealLagMs = () => car3dTune.revealLagMs;
const loaderFadeMs = () => car3dTune.cubeFadeMs + 30;
const hotspotStaggerMs = () => Math.round(car3dTune.arriveMs * CAR3D_EASES[car3dTune.ease].settle);

const CAR3D_DIALS = [
  { group: "Arrival" },
  { key: "arriveMs", label: "Speed (duration)", min: 200, max: 2500, step: 50, unit: "ms", motion: true },
  { key: "fadeMs", label: "Fade in", min: 0, max: 1500, step: 25, unit: "ms", motion: true },
  { key: "startScale", label: "Start size (<1 zoom in, >1 zoom out)", min: 0.2, max: 1.8, step: 0.05, unit: "×", motion: true },
  { key: "dropPct", label: "Start height (− above, + below)", min: -25, max: 25, step: 1, unit: "%", motion: true },
  { key: "ease", label: "Curve", options: Object.keys(CAR3D_EASES), motion: true },
  { group: "Cube handover" },
  { key: "cubeFadeMs", label: "Cube fade-out", min: 0, max: 1000, step: 10, unit: "ms", motion: true },
  { key: "revealLagMs", label: "Car delay after cube", min: 0, max: 800, step: 10, unit: "ms", motion: true },
  { group: "Light & shadow" },
  { key: "shadowIntensity", label: "Shadow strength", min: 0, max: 2, step: 0.05 },
  { key: "shadowSoftness", label: "Shadow softness", min: 0, max: 1, step: 0.05 },
  { key: "exposure", label: "Exposure", min: 0.3, max: 2, step: 0.05 },
];

/* ── Build tabs: edit the car FILE through tools/lab-server.mjs ────────────────
   The motion dials above tune the page; the build tabs edit the car itself,
   with the same CLI tools the recipe uses, and save the result into the site.
   The lab server runs each tool on a DRAFT copy (the chain of edits for this
   car), the page previews a draft in place of the shipped file, and Save
   installs the newest one -- backing the original up to sources/backup/
   first -- and bumps the car's ?v= in index.html, which is what "apply to the
   main page" means. Everything here needs that server; with `npx serve` the
   tabs say so and do nothing.

   One tab per section, in the recipe's order (they used to be collapsible
   groups on one long Build tab, which read as one wall of controls):
     Export   export-fix: a skinned export (an identity rig) and a stray
              COLOR_0 come first, because the other tools refuse a skin and
              vertex-shading refuses a foreign COLOR_0 on the paint;
     Seat     seat-split: Find it (--auto), a tap (--pick) or a box from two
              taps (--box); Inspect and Fix name sit under More options.
              Every cut is the WHOLE driver's seat (cushion, backrest,
              headrest and its posts, bolsters, the seat back); a variant
              only adds what comes along with it;
     Cabin    cabin-black: every cabin triangle but the driver's seat into
              one black material (Interior_Black). After the seat: the seat
              finder works by material, and a black cabin is one material.
              It sends --seat (the file's Driver_Seat* materials) and
              --paint (the look's paint) so neither can go black; --keep,
              --name and Force sit under More options;
     Gaps     occlusion-patch (the paint has a PNG occlusion map) or
              vertex-shading (it has none), plus the plate pocket;
     Parts    mesh-strip by exact id, with a follow-up that lifts the pocket
              a deleted plate leaves behind (it opens Gaps);
     Save     the draft chain (each draft's tool, action, seed and drawn
              values, from its sidecar), the preview, Undo last, Discard,
              Save to site and Restore.
   A slim strip under the tabs (build tabs only) says what the tools read --
   the newest draft, or the shipped file -- switches which file the car
   shows, and names a job or a save in flight. Each tab shows only its own
   last job and its own message. Every flag a tool's own error message tells
   you to use has a control; "Extra flags" (one box per tab, under More
   options, so a leftover --pocket never reaches seat-split) takes the rest,
   with "double quotes" for a value with spaces.

   Variants (Seat, Cabin and Gaps). A seat cut, the cabin's edge (the dash
   top under the windscreen, the door tops, the parcel shelf) and the
   panel-gap seams have more than one plausible answer, so the main button
   is "Random cut" / "Random" / "Random seams": it sends a fresh --seed (a
   crypto-random uint32), and the tool
   draws its tunable values from it, inside ranges around the calibrated
   ones, retrying until its own checks pass. While that draft is the newest
   the button reads "Try another": a new seed with replace:true, so the
   server swaps the draft for the new result instead of stacking a second
   cut on the first. "Keep" ends the trying (the next run stacks on it);
   "Calibrated" is today's deterministic result (no --seed) -- a new draft,
   or, while trying, in place of the variant. The Tried list (per car and
   tab, this session) holds every seed tried on the same base; tapping one
   runs it again with replace, which reproduces it exactly. The controls the
   user set (paint, length, method, box, kept materials, Extra flags) are
   passed as flags, so they stay fixed while the rest varies. Every run
   sends an opKey (seat-auto, seat-pick, seat-box, cabin, gaps-vertex,
   gaps-occlusion for these), which is what the server matches a replace
   against.

   The seat is picked by TAPPING it: the tap is taken before the stage's own
   rotate gesture sees it (a window capture listener, the same trick the panel
   uses for its sliders), and model-viewer's positionAndNormalFromPoint gives
   the point in the model's own coordinates -- the space the tools work in --
   plus materialFromPoint for the cabin material it sits on. Glass sits in
   front of the seat from almost every angle, so transparent and cut-out
   meshes are made un-hittable for the length of the tap (see labHit).

   State lives OUTSIDE React, per car file (labBag). The panel unmounts
   whenever the 3D screen closes, and the build host (BuildHost) is hidden,
   not unmounted, on collapse or the Motion tab -- but a job outlives both:
   its poll loop keeps writing into the bag, so reopening the panel shows
   where it got to, and a page reload picks a running job back up from
   status.busy. */

/* Which draft (if any) the page shows instead of the shipped car. Module
   state, not React state: the app reads it through srcFor / carFor while
   rendering CarStage3D, and a change is announced through the same
   subscribers the dials use, so the stage re-renders and swaps the src.
   Cleared only by Discard, Save, Restore, Undo of the shown draft and a
   change of car -- never by the panel unmounting, so collapsing it (the only
   way to see the car on a phone) keeps the draft on show. */
let labPreview = null; // { file, url, n, seat, cabin }
const labUiSubs = new Set();
const labUiNotify = () => labUiSubs.forEach((f) => f());
const labNotify = () => { car3dTuneSubs.forEach((f) => f()); labUiNotify(); };
const setLabPreview = (p) => { labPreview = p; labNotify(); };
const fileOfSrc = (src) => ((src || "").split("?")[0].split("/").pop() || "");
function srcFor(src) {
  return labPreview && labPreview.file === fileOfSrc(src) ? labPreview.url : null;
}
/* A previewed draft may carry a seat material on a car whose registry entry
   has no seat slot yet (the Accent, both Sportages). Save adds the slot to
   index.html; until then the preview adds it here, under the name the draft
   really uses (status.info.seatMaterials), so the red seat shows. A car that
   HAS a slot keeps it as is: if the draft lost that material (a Redo without
   --name), the preview shows no red seat -- which is exactly what Save would
   ship, and the Site group says why.
   The black cabin the same way: a draft with Interior_Black (cabin-black's
   material, status.info.cabinMaterial) on a car whose look.interior does
   not list it gets it appended for the preview, as Save appends it to
   index.html -- the material is already near-black in the file, and the
   profile's interior recipe is what the rest of the cabin gets. The look's
   other interior names stay (Save keeps them too, for a Restore). */
function carFor(car) {
  if (!labPreview || labPreview.file !== fileOfSrc(car.model && car.model.src)) return null;
  const look = (car.model && car.model.look) || {};
  const add = {};
  if (!look.seat && labPreview.seat) add.seat = [labPreview.seat];
  if (labPreview.cabin && !(look.interior || []).includes(labPreview.cabin)) add.interior = [...(look.interior || []), labPreview.cabin];
  if (!add.seat && !add.interior) return null;
  return { ...car, model: { ...car.model, look: { ...look, ...add } } };
}

/* ── talking to the server ──────────────────────────────────────────────────
   Every request carries X-Lab. On localhost the server takes "1", and on its
   LAN address too when it was started with --open (lab.cmd does: the page at
   http://<PC's IP>:8001/?tune=1 needs nothing else, and status.auth says
   "local"). A LAN server started without --open wants the random key it
   printed, which arrives in the URL it prints as #lab=<key>. Read once at
   load, in case the app rewrites the hash later. The paths are relative, so
   every request goes to the address the page was opened on -- the Host the
   server checks. */
const labHashToken = () => { const m = /(?:^#|[#&])lab=([^&]+)/.exec(location.hash || ""); return m ? decodeURIComponent(m[1]) : null; };
const LAB_TOKEN = labHashToken();
const labToken = () => LAB_TOKEN || labHashToken() || "1";
const LAB_API = "/__lab/";
const labErr = (message, extra) => Object.assign(new Error(message), extra);
/* Throws an Error whose message is the server's own text. `noServer` marks
   "nothing lab-like answered" (an HTML page from npx serve, a 404, a refused
   connection), the one case the tab shows its how-to-start note for; `data`
   is the server's JSON (save's 409 carries missing/needForce there). */
async function labCall(path, body) {
  let res;
  const headers = { "X-Lab": labToken() };
  try {
    res = await fetch(LAB_API + path, body === undefined ? { cache: "no-store", headers } : {
      method: "POST", cache: "no-store", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) { throw labErr("cannot reach the lab server (" + (e.message || e) + ")", { noServer: true }); }
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) {
    let text = "";
    try { text = (await res.text()).trim(); } catch (e) {}
    if (res.status === 404 || /^</.test(text)) throw labErr("no lab server here", { noServer: true, status: res.status });
    throw labErr("HTTP " + res.status + (text ? ": " + text.slice(0, 300) : ""), { status: res.status });
  }
  let json;
  try { json = await res.json(); } catch (e) { throw labErr("HTTP " + res.status + ": the server sent broken JSON", { status: res.status }); }
  if (!res.ok || !json.ok) throw labErr(json.error || "request failed (HTTP " + res.status + ")", { status: res.status, data: json });
  return json;
}

const mb = (b) => (b == null ? "–" : (b / 1048576).toFixed(2) + " MB");
const delta = (a, b) => {
  if (a == null || b == null) return "";
  const d = b - a;
  return (d >= 0 ? "+" : "−") + (Math.abs(d) >= 1048576 ? (Math.abs(d) / 1048576).toFixed(2) + " MB" : Math.round(Math.abs(d) / 1024) + " KB");
};
const fmtPt = (p) => [p.x, p.y, p.z].map((n) => Number(n).toFixed(4)).join(",");
const plural = (n, w, ws) => n + " " + (n === 1 ? w : ws || w + "s");
/* Extra flags: split on spaces, but "a quoted value" stays one argument, so
   --source "2016 Kia Optima" reaches the tool as two args, not four. Only
   double quotes: an apostrophe is a legal character in a material name. */
function labParseFlags(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ""))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
/* A box "x0,y0,z0,x1,y1,z1" around two corners, padded on every side by
   `pad` times its largest side (a pocket's floor sits below the plate's own
   bounds; two taps on a seat touch its surface, not its far edges). */
function labBox(a, b, pad = 0) {
  const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const p = pad * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return [...lo.map((v) => v - p), ...hi.map((v) => v + p)].map((v) => Number(v).toFixed(4)).join(",");
}
const labVec = (p) => [Number(p.x), Number(p.y), Number(p.z)];
const labCentre = (lo, hi) => ({ x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 });
/* Three significant digits, not fixed decimals: model units differ per
   export (the Camry is in metres, the Altima about 26 m to the unit). */
const labSize = (lo, hi) => [0, 1, 2].map((k) => Number((hi[k] - lo[k]).toPrecision(3))).join(" × ");
/* status.busy is {kind, id?} on the current server; an older one sent the
   bare job id. */
const labNormBusy = (b) => (b == null ? null : typeof b === "object" ? b : { kind: "job", id: String(b) });
/* A draft's URL carries ?t=<mtime>, so an Undo followed by a new write -- the
   same draft number with different bytes -- is a new URL (model-viewer
   caches recently released models by URL). */
const labDraftUrl = (d) => (d.url.includes("?") ? d.url : d.url + "?n=" + d.n + "&b=" + d.bytes);
const labNewest = (row) => { const d = (row && row.drafts) || []; return d[d.length - 1] || null; };
/* What the tools read right now: the newest draft, else the shipped file.
   A part list or an export check taken from another key is stale. */
const labDraftKey = (row) => { const d = labNewest(row); return d ? labDraftUrl(d) : "shipped:" + (row && row.bytes); };

/* ── per-car state, outside React ──────────────────────────────────────────
   One bag per car file. The tabs render from it and every write goes
   through labPut, which re-renders every mounted tab. Keyed by file, so
   another car starts fresh and coming back to a car finds its list, its
   picked point, its jobs and its Tried lists where they were.
   Jobs and messages are per tab ("export", "seat", "cabin", "gaps", "parts",
   "save"),
   so each tab shows its own last result: a patch's `job` lands in
   jobs[the tab of its tool], and its `say` ({where, text, ok, reload}) in
   msgs[where] -- text: null clears that tab's message. */
const LAB_DEFAULTS = {
  status: null,       // this car's /__lab/status row
  jobs: {},           // tab -> its running / last job
  msgs: {},           // tab -> { text, ok, reload }
  op: null,           // save | restore | discard | undo, while one is in flight
  autoPreviewed: false,
  more: {},           // which "More options" folds are open, by id
  /* Variants: tab -> the runs tried this session (labRecordTry), and the
     variant drafts the user kept, by draft url (Try another changes it). */
  tried: {}, kept: {},
  // Export fixes. null = follow status.info (tick what the file needs).
  xfUnskin: null, xfDropColor0: null, xfExtra: "", xf: null,
  // Driver seat. seatMethod null = the newest seat draft's, else Find it.
  seatMethod: null,
  pick: null,         // null | { for: "seat" } | { for: "seatBox" | "pocket", a: [x,y,z] | null }
  picked: null,       // { pos, normal, material }
  seatMode: "redo", seatForce: false, front: "", driver: "", seatBox: "", boxMode: "shell", seatExtra: "",
  // Cabin black. cabinKeep: material name -> never blacken it (--keep);
  // cabinName "" = the tool's own (or the file's existing cabin material).
  cabinKeep: {}, cabinName: "", cabinForce: false, cabinExtra: "",
  // Panel gaps. null = the default worked out from status.info / the registry.
  gapTool: null, paint: null, lengthMm: null, seams: true, fromMR: true, resetSpec: false, dropForeign: true,
  pocket: "", gapForce: false, gapExtra: "", clusters: null,
  // Delete parts.
  stripFilter: "", strip: null, stripSel: {}, stripAll: false, stripForce: false, stripExtra: "",
  focus: null,        // { pos, size, label } -- the pin on a listed part or cluster
  removed: null,      // the parts the last delete took, for "Lift pocket under it"
  restoreFrom: "original",
};
const labBags = new Map();
function labBag(file) {
  let b = labBags.get(file);
  if (!b) { b = { file, ...LAB_DEFAULTS, jobs: {}, msgs: {}, more: {}, tried: {}, kept: {}, stripSel: {}, cabinKeep: {} }; labBags.set(file, b); }
  return b;
}
/* The tab a tool's jobs and messages belong to. */
const LAB_GROUP = { "export-fix": "export", "seat-split": "seat", "cabin-black": "cabin", "occlusion-patch": "gaps", "vertex-shading": "gaps", "mesh-strip": "parts" };
function labPut(file, patch) {
  const b = labBag(file);
  const { job, say, ...rest } = typeof patch === "function" ? patch(b) : patch;
  Object.assign(b, rest);
  // After the plain fields, so a patch that resets jobs / msgs ({}) can still say something.
  if (job && LAB_GROUP[job.tool]) b.jobs = { ...b.jobs, [LAB_GROUP[job.tool]]: job };
  if (say && say.where) b.msgs = { ...b.msgs, [say.where]: say.text == null ? null : say };
  labUiNotify();
}
function useLabUi() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    labUiSubs.add(f);
    return () => { labUiSubs.delete(f); };
  }, []);
}
/* The server as a whole: one job (or save/restore/…) at a time for every car,
   so `busy` here disables every car's buttons. */
const labServer = { state: "checking", error: "", busy: null, auth: null };
/* The panel's tabs, and the one on show: module state, so collapsing the
   panel or closing the screen keeps it, and a button in one tab can open
   another (Parts' "Lift pocket under it" opens Gaps). Short labels: all
   seven fit one row of the 300px panel (and of a 250px one). */
const LAB_TABS = [["motion", "Motion"], ["export", "Export"], ["seat", "Seat"], ["cabin", "Cabin"], ["gaps", "Gaps"], ["parts", "Parts"], ["save", "Save"]];
let car3dTunerTab = "motion";
const labSetTab = (t) => { car3dTunerTab = t; labUiNotify(); };

/* ── variants ──────────────────────────────────────────────────────────────
   The actions whose result can be tried again with another seed, and the
   tool each one runs (the server allows a replace only on a newest draft
   made by the same tool with the same opKey). */
const LAB_VARIANT_OPS = { "seat-auto": "seat-split", "seat-pick": "seat-split", "seat-box": "seat-split", "cabin": "cabin-black", "gaps-vertex": "vertex-shading", "gaps-occlusion": "occlusion-patch" };
const LAB_OP_LABEL = { "seat-auto": "Find it", "seat-pick": "Tap", "seat-box": "Box", "cabin": "Cabin black", "gaps-vertex": "vertex-shading", "gaps-occlusion": "occlusion-patch", "seat-name": "Fix name" };
const LAB_TOOL_LABEL = { "export-fix": "Export fix", "seat-split": "Seat", "cabin-black": "Cabin black", "vertex-shading": "Gaps", "occlusion-patch": "Gaps", "mesh-strip": "Delete parts" };
/* A fresh seed per click. crypto.getRandomValues works on a plain-http LAN
   page too (only crypto.subtle needs a secure context). */
function labNewSeed() {
  try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
  catch (e) { return Math.floor(Math.random() * 4294967296) >>> 0; }
}
/* The --seed a run carried (either form), or null: a calibrated run. */
function labSeedOf(args) {
  const a = args || [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--seed" && i + 1 < a.length) return Number(a[i + 1]);
    const m = /^--seed=(\d+)$/.exec(a[i]);
    if (m) return Number(m[1]);
  }
  return null;
}
/* Extra flags minus a --seed of their own, when the button brings one: two
   seeds would leave it to the tool's parser which one counts. */
function labStripSeed(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed") { i++; continue; }
    if (/^--seed=/.test(args[i])) continue;
    out.push(args[i]);
  }
  return out;
}
/* What a run read, as a key that changes whenever that file does: a draft's
   url (its ?t= is the mtime), or the shipped file's size. A Tried entry is
   offered again only on the same base: the same seed on another state of
   the car is another result. job.input is "assets/<file>" or
   "drafts/<car>/<n>-<tool>.glb". */
function labBaseKey(row, input) {
  if (!input || String(input).startsWith("assets/")) return "shipped:" + (row && row.bytes);
  const f = String(input).split("/").pop();
  const d = ((row && row.drafts) || []).find((x) => x.file === f);
  return d ? labDraftUrl(d) : "gone:" + input;
}
/* The variant on the car: the newest draft, when one of this tab's variant
   actions made it (its sidecar says which; a draft from before sidecars, or
   another tab's, is none). kept: the user pressed Keep on it, so the next
   run stacks. baseKey: what it was cut from, the draft before it. */
function labVariantOf(row, tab, kept) {
  const d = labNewest(row);
  const m = d && d.meta;
  const tool = m && LAB_VARIANT_OPS[m.opKey];
  if (!tool || LAB_GROUP[tool] !== tab || m.tool !== tool || d.tool !== tool) return null;
  const drafts = row.drafts;
  const base = drafts.length > 1 ? drafts[drafts.length - 2] : null;
  const url = labDraftUrl(d);
  return { d, meta: m, opKey: m.opKey, tool, url, kept: !!(kept && kept[url]), baseKey: base ? labDraftUrl(base) : "shipped:" + row.bytes };
}
/* Every variant run (Random, Try another, Calibrated, a Tried entry) lands
   in its tab's Tried list: the seed (null = calibrated), pass or fail, the
   drawn values, the exact args (sent again with replace they reproduce it)
   and the base it read. A run of an entry already listed updates it in
   place, so the list never reorders under the finger. */
function labRecordTry(file, j, row) {
  if (!j || j.report || !LAB_VARIANT_OPS[j.opKey] || j.state === "running" || j.state === "lost") return;
  const tab = LAB_GROUP[j.tool];
  const r = j.result || {};
  const v = (r.summary && r.summary.variation) || (j.draft && j.draft.meta && j.draft.meta.variation) || null;
  const ok = j.state === "done" && !!j.draft;
  const failedChecks = (r.checks || []).filter((c) => !c.pass).map((c) => c.name);
  const lastRejected = v && v.rejected && v.rejected.length ? v.rejected[v.rejected.length - 1].failed || [] : [];
  const baseKey = labBaseKey(row, j.input);
  const args = j.args || [];
  labAddTry(file, tab, {
    key: j.opKey + "|" + baseKey + "|" + args.join("\u0001"),
    opKey: j.opKey, tool: j.tool, args, seed: labSeedOf(args), ok, baseKey,
    params: (v && v.params) || null, label: (v && typeof v.label === "string" && v.label) || null, attempt: (v && v.attempt) || null, tries: (v && v.tries) || null,
    triangles: v && typeof v.triangles === "number" ? v.triangles : null, nothingNew: labQuiet(j),
    failed: ok ? [] : failedChecks.length ? failedChecks : lastRejected,
    error: ok ? null : r.error || null,
  });
}
function labAddTry(file, tab, entry, { onlyNew = false } = {}) {
  labPut(file, (b) => {
    const list = b.tried[tab] || [];
    const i = list.findIndex((e) => e.key === entry.key);
    if (i >= 0 && onlyNew) return {};
    return { tried: { ...b.tried, [tab]: i >= 0 ? list.map((e, k) => (k === i ? entry : e)) : [entry, ...list].slice(0, 30) } };
  });
}
/* Before Try another replaces the variant on the car, it goes into the
   Tried list if it is not there yet -- one made before a page reload, whose
   seed would otherwise be lost with the draft. Its sidecar has all of it. */
function labRememberVariant(file, tool) {
  const v = labVariantOf(labBag(file).status, LAB_GROUP[tool], null);
  if (!v || v.tool !== tool) return;
  const m = v.meta, vr = m.variation;
  const args = m.args || [];
  labAddTry(file, LAB_GROUP[tool], {
    key: m.opKey + "|" + v.baseKey + "|" + args.join("\u0001"),
    opKey: m.opKey, tool, args, seed: labSeedOf(args), ok: true, baseKey: v.baseKey,
    params: (vr && vr.params) || null, label: (vr && typeof vr.label === "string" && vr.label) || null, attempt: (vr && vr.attempt) || null, tries: (vr && vr.tries) || null,
    triangles: vr && typeof vr.triangles === "number" ? vr.triangles : null, failed: [], error: null,
  }, { onlyNew: true });
}
/* A variant's drawn values, in a short form: the ones that tell variants
   apart first (per tool), then the rest; `max` keeps the first few. */
const LAB_KEY_PARAMS = {
  "seat-split": ["headrest", "others", "gapVox", "envelope", "minInside", "padWidth", "padUp", "padLength", "borderTris"],
  "cabin-black": ["dash", "aPillar", "doorTops", "parcel", "straddle", "envelope"],
  "vertex-shading": ["curve", "aoStrength", "aoDistanceMm", "seamCoarseMm"],
  "occlusion-patch": ["curve", "profileScale"],
};
const labFmtVal = (v) => (v === true ? "yes" : v === false ? "no" : typeof v === "number" ? String(Number(v.toPrecision(4)))
  : Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.join(":") : labFmtVal(x))).join(",") : v && typeof v === "object" ? JSON.stringify(v) : String(v));
function labParams(tool, params, max) {
  if (!params || typeof params !== "object") return [];
  // The seam curve says its core, hold and fall itself: their own entries would repeat it.
  const keys = Object.keys(params).filter((k) => !("curve" in params && ["seamCore", "seamCoreMm", "seamFallMm"].includes(k)));
  const first = (LAB_KEY_PARAMS[tool] || []).filter((k) => k in params);
  const order = [...first, ...keys.filter((k) => !first.includes(k))];
  return (max ? order.slice(0, max) : order).map((k) => [k, labFmtVal(params[k])]);
}
/* The same in the fewest words, for one-line rows (the Tried list, the
   Save tab): short names, and a seam curve as its depth and reach. */
const LAB_SHORT = { aoDistanceMm: ["AO ", " mm"], seamCoarseMm: ["coarse ", " mm"], aoStrength: ["AO ×", ""], profileScale: ["depth ×", ""] };
/* The gap tools have no label of their own: their seam (its core, to its
   reach) and the AO strength or the profile scale tell variants apart. */
const LAB_BRIEF_MAX = { "vertex-shading": 2, "occlusion-patch": 2 };
function labBrief(tool, params, max = 3) {
  return labParams(tool, params, max).map(([k, val]) => {
    const c = k === "curve" && /^0:([\d.]+),.*,([\d.]+):1$/.exec(val);
    if (c) return "seam " + c[1] + " to " + c[2] + " mm";
    const short = LAB_SHORT[k];
    return short ? short[0] + val + short[1] : k + " " + val;
  }).join(" · ");
}
/* A variant in one line: seat-split's own label ("no headrest, tight,
   trimmed to 89%"), else the values that matter; then its triangles and
   which attempt passed. v: a variation summary or a Tried entry. */
function labVariantBrief(tool, v) {
  if (!v) return "";
  const out = [];
  if (v.label) out.push(v.label);
  else { const b = labBrief(tool, v.params, LAB_BRIEF_MAX[tool] || 3); if (b) out.push(b); }
  if (typeof v.triangles === "number") out.push(v.triangles.toLocaleString() + " tris");
  if (v.attempt) out.push("attempt " + v.attempt + (v.tries ? "/" + v.tries : ""));
  return out.join(" · ");
}
/* "No new variant": seat-split found only seats already tried (the Camry
   has one variant, no headrest). Not a fault of the car or the tool, so it
   is said plainly, with the way on, not as a red failure. */
const labNoNew = (j) => !!(j && j.state === "failed" && /no new variant/i.test(String((j.result && j.result.error) || "")));
/* "Nothing to do": cabin-black found no cabin triangle left to blacken (the
   cabin is black already, and wrote nothing). The same plain note. */
const labNothing = (j) => !!(j && j.state === "failed" && j.tool === "cabin-black" && /nothing to do/i.test(String((j.result && j.result.error) || "")));
const labQuiet = (j) => labNoNew(j) || labNothing(j);
/* A draft in a few words, from its sidecar: what made it, and with which
   seed ("Seat · Find it · seed 31337", "Gaps · calibrated"). */
function labDraftWhat(d) {
  const m = d.meta;
  const out = [LAB_TOOL_LABEL[d.tool] || d.tool];
  if (m && m.opKey && m.opKey.startsWith("seat-") && LAB_OP_LABEL[m.opKey]) out.push(LAB_OP_LABEL[m.opKey]);
  if (m && LAB_VARIANT_OPS[m.opKey]) out.push(m.seed != null ? "seed " + m.seed : "calibrated");
  return out.join(" · ");
}

/* ── preview ─────────────────────────────────────────────────────────────── */
function labShowDraft(file, row, which) {
  const drafts = (row && row.drafts) || [];
  const d = which === "newest" ? drafts[drafts.length - 1] : drafts.find((x) => x.n === which);
  if (!d) { if (labPreview && labPreview.file === file) setLabPreview(null); return; }
  const seat = ((row.info && row.info.seatMaterials) || [])[0] || null;
  /* status.info describes the newest draft; an older one carries the black
     cabin only if a cabin-black draft sits at or below it in the chain. */
  const infoCabin = (row.info && row.info.cabinMaterial) || null;
  const cabin = d === drafts[drafts.length - 1] ? infoCabin
    : drafts.some((x) => x.n <= d.n && x.tool === "cabin-black") ? infoCabin || "Interior_Black" : null;
  setLabPreview({ file, n: d.n, url: labDraftUrl(d), seat, cabin });
}
/* After every status read: a previewed draft that is gone (undo, discard,
   save) falls back to the newest one, one replaced under the same number gets
   its new URL, and the first status of a car that already has drafts turns
   the preview on -- the tools run on the newest draft, so that is the car to
   look at, not the shipped file. */
function labSyncPreview(file, row) {
  const drafts = (row && row.drafts) || [];
  if (labPreview && labPreview.file === file) {
    const d = drafts.find((x) => x.n === labPreview.n);
    if (!d) labShowDraft(file, row, drafts.length ? "newest" : null);
    else if (labDraftUrl(d) !== labPreview.url) labShowDraft(file, row, d.n);
  } else if (drafts.length && !labBag(file).autoPreviewed) labShowDraft(file, row, "newest");
  labBag(file).autoPreviewed = true;
}

/* ── status, jobs and site operations ──────────────────────────────────────
   Module functions, not component closures: a poll loop must keep going (and
   keep writing the bag) after the panel closes, and must never read a stale
   closure's idea of the state. */
let labLaterTimer = 0;
async function labRefresh(file) {
  let s;
  try { s = await labCall("status"); }
  catch (e) {
    Object.assign(labServer, { state: e.noServer ? "missing" : "error", error: e.message });
    labUiNotify();
    return null;
  }
  const busy = labNormBusy(s.busy);
  Object.assign(labServer, { state: "ok", error: "", busy, auth: s.auth || null });
  const row = (s.cars || []).find((c) => c.file === file) || null;
  labPut(file, { status: row });
  labSyncPreview(file, row);
  /* Resume: a reload during a long AO bake, or a save from another tab.
     A running job is polled to its end (its result lands in its car's bag);
     anything else is waited out with another status read. */
  clearTimeout(labLaterTimer);
  /* The job may be another car's (busy.file): its result lands in that
     car's bag, where coming back to it finds it. */
  if (busy && busy.kind === "job" && busy.id) labPoll(busy.id, busy.file || file);
  else if (busy) labLaterTimer = setTimeout(() => labRefresh(file), 1000);
  if (row && !(busy && busy.kind === "job" && busy.file === file)) labAdoptLastJobs(file, row);
  return row;
}

/* Jobs that ended while no page was watching them -- the page was reloaded
   (or opened in a new tab) after the AO bake finished -- used to vanish: only
   a RUNNING job came back through status.busy. status.lastJobByTool names
   each tool's newest finished job, and each tab gets the newest of its own
   tools' (an older server sends only lastJob, the car's newest). It is shown
   once, the way it would have landed, but only while it still describes the
   car: a write whose draft is still in the chain (a draft Try another
   replaced since has a new url, so the old job is history), or a check of
   what the tools read now. After an Undo, a Save or a Discard it is history,
   and showing "draft 2 written" for a draft that is gone would mislead.
   Every job this page started or polled is in labSeenJobs, so a Discard
   (which clears the job blocks on purpose) never brings its job back on the
   next status read. */
const labSeenJobs = new Set();
const labJobSeq = (id) => Number(String(id).split("-").pop()) || 0;
function labAdoptLastJobs(file, row) {
  const byTab = {};
  const byTool = row.lastJobByTool || (row.lastJob ? { "?": row.lastJob } : {});
  for (const [tool, id] of Object.entries(byTool)) {
    if (!id) continue;
    const t = LAB_GROUP[tool] || tool;
    if (!byTab[t] || labJobSeq(id) > labJobSeq(byTab[t])) byTab[t] = id;
  }
  for (const id of Object.values(byTab)) labAdoptJob(file, id);
}
async function labAdoptJob(file, id) {
  if (labSeenJobs.has(id) || labPolling.has(id)) return;
  labSeenJobs.add(id);
  let j;
  try { j = (await labCall("job/" + encodeURIComponent(id))).job; } catch (e) { return; } // pruned or restarted: nothing to show
  const now = labBag(file);
  const tab = j && LAB_GROUP[j.tool];
  if (!j || !tab || j.state === "running" || now.jobs[tab] || j.file !== file) return;
  const drafts = (now.status && now.status.drafts) || [];
  const last = drafts[drafts.length - 1];
  const reads = last ? "drafts/" + now.status.id + "/" + last.file : "assets/" + file;
  const current = j.draft ? drafts.some((d) => d.url === j.draft.url) : j.input === reads;
  if (!current) return;
  labPut(file, { job: j, ...labJobPatch(j, now.status, { adopted: true }).patch });
  labRecordTry(file, j, now.status);
}

const labPolling = new Map(); // job id -> promise of the finished job
/* When this page first saw each job running (by its own clock: a phone's
   may differ from the PC's), for the "running · 42 s" a long AO bake shows. */
const labJobSeen = new Map();
const labElapsed = (j) => (j && j.state === "running" && labJobSeen.has(j.id) ? Math.round((Date.now() - labJobSeen.get(j.id)) / 1000) + " s" : "");
function labPoll(id, file) {
  if (labPolling.has(id)) return labPolling.get(id);
  labSeenJobs.add(id);
  if (!labJobSeen.has(id)) labJobSeen.set(id, Date.now());
  const p = (async () => {
    let j = null, misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      try { j = (await labCall("job/" + encodeURIComponent(id))).job; misses = 0; }
      catch (e) {
        // A restarted server has forgotten the job: stop, and say so.
        if (e.status === 404 || ++misses > 20) {
          labServer.busy = null;
          labPut(file, (b) => {
            const tab = Object.keys(b.jobs).find((k) => b.jobs[k] && b.jobs[k].id === id) || "save";
            const say = { where: tab, text: "lost track of job " + id + ": " + e.message };
            return b.jobs[tab] ? { job: { ...b.jobs[tab], state: "lost" }, say } : { say };
          });
          return null;
        }
        continue;
      }
      labPut(j.file || file, { job: j });
      if (j.state !== "running") break;
    }
    return labAfterJob(j);
  })();
  labPolling.set(id, p);
  p.finally(() => labPolling.delete(id));
  return p;
}

/* What a finished job means for the page. Driven by the job itself (tool,
   report, args, opKey), not by the button that started it, so a job picked
   back up after a reload lands the same way. */
async function labAfterJob(j) {
  const file = j.file;
  const row = await labRefresh(file);
  // The job is over even if the status read just failed: never leave every
  // button disabled behind a lock the server no longer holds.
  if (labServer.busy && labServer.busy.id === j.id) { labServer.busy = null; labUiNotify(); }
  if (j.state === "done" && j.draft) labShowDraft(file, row, "newest");
  const { patch, relist } = labJobPatch(j, row);
  labPut(file, patch);
  labRecordTry(file, j, row);
  // Dark clusters to pick a pocket from: open the fold they are listed in.
  if (patch.clusters && patch.clusters.list.length) labPut(file, (b) => ({ more: { ...b.more, pocket: true } }));
  if (relist) labList(file, { keepMsg: true });
  return j;
}
/* The bag patch a finished job makes: its message, an export check's
   summary, the dark clusters, the part list. `adopted` is a job picked up
   from status.lastJobByTool after a reload: same landing, minus the re-list
   (the page does not start a job nobody asked for). */
function labJobPatch(j, row, { adopted = false } = {}) {
  const r = j.result || {};
  const s = r.summary || {};
  const ok = j.state === "done";
  const where = LAB_GROUP[j.tool];
  const patch = {};
  let relist = false;
  if (labNoNew(j)) patch.say = { where, info: true, text: "No new variant: every draw cut a seat already tried, so this car's seat has few variants. The draft is unchanged; Keep it, use Calibrated, or try another seed." };
  else if (labNothing(j)) patch.say = { where, info: true, text: "Nothing to do: no cabin triangle is left to blacken" + (row && row.info && row.info.cabinMaterial ? " (the cabin is " + row.info.cabinMaterial + " already)" : "") + ". Nothing was written." };
  else if (!ok) patch.say = { where, text: (r.error || j.tool + " failed" + (j.exitCode != null ? " (exit " + j.exitCode + ")" : "") + " — see its log") + (j.replace ? " The draft on the car is unchanged." : "") };
  if (ok && j.draft) {
    /* The seed is on the variant card and in the job box: the message only
       says what happened to the draft. */
    patch.say = { where, ok: true, text: "Draft " + j.draft.n + (j.replace ? " replaced" : " written") + " (" + mb(j.draft.bytes) + ")" + (adopted ? "" : "; the car shows it now")
      + (LAB_VARIANT_OPS[j.opKey] ? "." : ". Save to site (Save tab) when it looks right.") };
  }
  // A write that had nothing to do (Fix name on a car already named right).
  if (ok && !j.report && !j.draft) patch.say = { where, ok: true, text: "Nothing written: " + (((r.warnings || [])[0] || "no change was needed").replace(/^nothing written:\s*/, "")) + "." };
  if (j.tool === "export-fix" && j.report && ok) patch.xf = { ...s, key: labDraftKey(row) };
  if (j.tool === "occlusion-patch" && j.report && Array.isArray(s.clusters)) patch.clusters = { list: s.clusters, key: labDraftKey(row) };
  if (j.tool === "mesh-strip") {
    const removing = (j.args || []).includes("--remove");
    if (j.report && !removing && ok) {
      const mi = (j.args || []).indexOf("--match");
      patch.strip = { rows: s.rows || [], total: s.total, shown: s.shown, key: labDraftKey(row), filter: mi >= 0 ? j.args[mi + 1] : "" };
      patch.stripAll = false;
    } else if (!j.report && ok) {
      /* The ids are mesh indices and the next file numbers them afresh, so
         the old list now points at different parts (a second click once
         deleted the Camry's red seat). Drop the ticks and list again. */
      patch.stripSel = {};
      patch.strip = null;
      patch.focus = null;
      patch.removed = (s.removed || []).filter((x) => x.lo && x.hi);
      relist = !adopted;
    }
  }
  return { patch, relist };
}

/* opKey: the action's name, kept in the draft's sidecar (the Save tab
   shows it; Try another needs it). replace: Try another -- the server swaps
   the newest draft for this result, or answers 409 when the newest is not
   this action's. */
async function labRun(file, tool, args, report = false, { keepMsg = false, opKey = null, replace = false } = {}) {
  const where = LAB_GROUP[tool];
  if (!keepMsg) labPut(file, { say: { where, text: null } });
  const body = { file, tool, args, report };
  if (opKey) body.opKey = opKey;
  if (replace) { body.replace = true; labRememberVariant(file, tool); }
  let id;
  try { id = (await labCall("run", body)).job.id; }
  catch (e) {
    labPut(file, { say: { where, text: e.message } });
    if (e.status === 409) labRefresh(file);
    return null;
  }
  labServer.busy = { kind: "job", id, file };
  labPut(file, { job: { id, file, tool, args, report, opKey, replace, state: "running", log: "", result: null } });
  return labPoll(id, file);
}
function labList(file, opts) {
  const b = labBag(file);
  const f = b.stripFilter.trim();
  return labRun(file, "mesh-strip", [...(f ? ["--match", f] : []), ...labParseFlags(b.stripExtra)], true, opts);
}

/* Save, restore, discard and undo hold the server's lock (it refuses a run
   meanwhile); the page mirrors it so nothing can be clicked in between. */
async function labOp(file, kind, body) {
  labServer.busy = { kind };
  labPut(file, { op: kind });
  try { return await labCall(kind, body); }
  finally { labServer.busy = null; labPut(file, { op: null }); }
}
/* What Save / Restore did to index.html. interiorCovered: look names the
   file no longer has, merged into the black cabin -- kept in the look (a
   Restore of the older file needs them), never a refusal. */
function labRegistryText(reg, seatName) {
  if (!reg) return { text: "", ok: true };
  if (!reg.ok) return { text: " index.html was NOT updated: " + (reg.error || "registry entry not found") + ". Bump this car's ?v= by hand.", ok: false };
  const cabin = reg.cabinMaterial || "Interior_Black";
  let t = " index.html ?v=" + reg.version + (reg.seatAdded ? ", seat slot added" : "") + (reg.interiorAdded ? ", " + cabin + " added to the interior slot" : "");
  const covered = reg.interiorCovered || [];
  if (covered.length) t += "; " + covered.map((n) => "\"" + n + "\"").join(", ") + (covered.length > 1 ? " are" : " is") + " covered by the black cabin (kept in the look for a Restore)";
  const byHand = [];
  if (reg.seatNeeded) byHand.push("seat: [\"" + (seatName || "Driver_Seat") + "\"]");
  if (reg.interiorNeeded) byHand.push("\"" + cabin + "\" to interior: [...]");
  if (byHand.length) return { text: t + ". Add " + byHand.join(" and ") + " to this car's look by hand: its entry could not be edited safely.", ok: false };
  return { text: t + ".", ok: true };
}
/* The two kinds of look-name miss in a 409, told apart (alreadyMissing is
   the part of missing[] the SHIPPED file lacks too). A new miss is a real
   loss: the site paints that slot today and would stop. An old one changes
   nothing on the site -- the Altima, Maxima and Sentra ship without the
   Driver_Seat their look names, both Sportages without "Sparkling Silver" --
   and read as one list, the second kind sent the user hunting for a
   regression the edit never made. Empty when the 409 is about something
   else (no registry entry), and the server's own text is shown then. */
function labMissingLines(d) {
  const missing = d.missing || [];
  const already = d.alreadyMissing || [];
  const lost = missing.filter((n) => !already.includes(n));
  const q = (list) => list.map((n) => "\"" + n + "\"").join(", ");
  const out = [];
  if (lost.length) out.push("Would stop matching: " + q(lost) + ". The car's look in index.html names " + (lost.length > 1 ? "them" : "it") + ", the shipped file has " + (lost.length > 1 ? "them" : "it") + " and the new file does not, so that slot (paint, seat, interior…) would stop painting on the site.");
  if (already.length) out.push("Already missing: " + q(already) + ". The shipped file lacks " + (already.length > 1 ? "these" : "this") + " too, so the site does not paint " + (already.length > 1 ? "them" : "it") + " today either; this edit changes nothing there" + (already.some((n) => n.startsWith("Driver_Seat")) ? " (cut the seat in the Seat tab to fill the seat slot)" : " (fix the name in look:{…})") + ".");
  // Not part of the refusal: said so the list above is not read as all of it.
  if (out.length && (d.covered || []).length) out.push("Fine: " + q(d.covered) + " merged into the black cabin, which covers " + (d.covered.length > 1 ? "them" : "it") + ".");
  return out;
}
/* Save / Restore share the server's pre-check: before anything is installed
   it compares the file's materials with every name in the car's look (and
   that the registry entry exists). A miss is a 409 with missing[] and
   needForce; the page names the slots that would stop matching and asks
   before sending force:true. Nothing has changed at that point. */
async function labInstall(file, kind, force = false) {
  const b = labBag(file);
  const st = b.status;
  if (!st) return;
  const drafts = st.drafts || [];
  const last = labNewest(st);
  if (!force) {
    const text = kind === "save"
      ? "Save " + plural(drafts.length, "edit") + " to the site?\n\n" + file + ": " + mb(st.bytes) + " → " + mb(last && last.bytes) + " (" + delta(st.bytes, last && last.bytes) + ")\n\nThe current file is kept in sources/backup/ " + (st.original ? "(history)" : "(as the original)") + ", and index.html gets a new ?v= for this car."
      : "Replace " + file + " with " + (b.restoreFrom === "original" ? "the original backup" : labHistLabel(st, b.restoreFrom)) + "?\n\nThe current file is kept in the history first." + (drafts.length ? "\n\nThis also DROPS " + plural(drafts.length, "unsaved edit") + " (the draft chain)." : "");
    if (!window.confirm(text)) return;
  }
  const body = kind === "save" ? { file } : { file, from: b.restoreFrom };
  if (force) body.force = true;
  let r;
  try { r = await labOp(file, kind, body); }
  catch (e) {
    const d = e.data || {};
    if (d.needForce && !force) {
      const Verb = kind === "save" ? "Save" : "Restore";
      const lines = labMissingLines(d);
      const ask = Verb + " refused; nothing was changed.\n\n" + (lines.length ? lines.join("\n\n") : e.message) + "\n\n" + Verb + " anyway?";
      if (window.confirm(ask)) return labInstall(file, kind, true);
      labPut(file, { say: { where: "save", text: Verb + " cancelled; nothing was changed. " + (lines.length ? lines.join(" ") : e.message) } });
      return;
    }
    labPut(file, { say: { where: "save", text: e.message } });
    labRefresh(file);
    return;
  }
  if (labPreview && labPreview.file === file) setLabPreview(null);
  const reg = labRegistryText(r.registry, ((r.car && r.car.info && r.car.info.seatMaterials) || [])[0]);
  // backupReused: the replaced bytes were in the history already, under that name.
  const reused = r.backupReused ? " (already there, not copied again)" : "";
  /* chain: the drafts that went into the saved file, with their sidecars --
     the last place a saved variant's seed is written down, so say it. */
  const chain = (r.chain || []).map((d) => labDraftWhat(d)).join("; ");
  const head = kind === "save"
    ? "Saved" + (chain ? " (" + chain + ")" : "") + ". " + mb(r.bytesBefore) + " → " + mb(r.bytesAfter) + ". Backup: " + r.backup + reused + "."
    : "Restored (" + mb(r.bytesAfter) + "). The replaced file is in the history as " + r.backup + reused + ".";
  labPut(file, { status: r.car || null, strip: null, stripSel: {}, removed: null, focus: null, restoreFrom: "original",
    say: { where: "save", ok: reg.ok, reload: true, text: head + reg.text + " Reload the page to see it as visitors will." } });
  labRefresh(file);
}
async function labDiscard(file) {
  const n = ((labBag(file).status || {}).drafts || []).length;
  if (!window.confirm("Discard all " + plural(n, "unsaved edit") + " to " + file + "? The site is not touched.")) return;
  try {
    const r = await labOp(file, "discard", { file });
    if (labPreview && labPreview.file === file) setLabPreview(null);
    labPut(file, { status: r.car || null, jobs: {}, msgs: {}, strip: null, stripSel: {}, removed: null, say: { where: "save", ok: true, text: "Edits discarded; the car shows the shipped file." } });
  } catch (e) { labPut(file, { say: { where: "save", text: e.message } }); }
  labRefresh(file);
}
async function labUndo(file) {
  try {
    const r = await labOp(file, "undo", { file });
    const now = labNewest(r.car);
    const gone = r.dropped ? "draft " + r.dropped.n + " (" + labDraftWhat(r.dropped) + ")" : "the newest draft";
    labPut(file, { status: r.car || null, strip: null, stripSel: {}, removed: null, say: { where: "save", ok: true, text: "Dropped " + gone + "; tools now run on " + (now ? "draft " + now.n : "the shipped file") + "." } });
    labSyncPreview(file, r.car);
  } catch (e) { labPut(file, { say: { where: "save", text: e.message } }); }
  labRefresh(file);
}
const labHistLabel = (st, name) => {
  const h = ((st && st.history) || []).find((x) => x.name === name);
  return (h && h.label) || (st && name.startsWith(st.id + "-") ? name.slice(st.id.length + 1) : name).replace(/\.glb$/, "");
};

/* ── the tap ────────────────────────────────────────────────────────────────
   model-viewer's hit test returns the FIRST surface under the finger, which
   from almost every angle is the windscreen (the Camry's Index_0_2, alpha
   BLEND) or an invisible Outline_* mesh (MASK, alpha 0) -- never the seat.
   Its raycast skips any object with userData.noHit, so every mesh whose
   material is see-through (transparent, opacity under one half, or cut away
   by its own alphaTest) gets that flag for the length of the tap only, and
   gets it back off straight after. The scene is model-viewer's private
   symbol property; without it the plain hit test still runs. */
function labHit(mv, x, y) {
  const sym = Object.getOwnPropertySymbols(mv).find((s) => s.description === "scene");
  const scene = sym ? mv[sym] : null;
  const off = [];
  if (scene && typeof scene.traverse === "function") {
    scene.traverse((o) => {
      if (!o.isMesh || !o.material || (o.userData && o.userData.noHit)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const solid = o.visible !== false && mats.some((m) => m && m.visible !== false && !m.transparent &&
        !(m.opacity < 0.5) && !(m.alphaTest > 0 && m.opacity < m.alphaTest));
      if (!solid) { o.userData.noHit = true; off.push(o); }
    });
  }
  try {
    const hit = mv.positionAndNormalFromPoint && mv.positionAndNormalFromPoint(x, y);
    if (!hit) return null;
    const mat = mv.materialFromPoint && mv.materialFromPoint(x, y);
    return { pos: hit.position, normal: hit.normal, material: mat ? mat.name : "" };
  } finally { off.forEach((o) => { delete o.userData.noHit; }); }
}

/* ── small pieces ─────────────────────────────────────────────────────────── */
/* The facts in a result, as one line each: what the log says in 20 lines. */
function labJobFacts(j) {
  const r = j.result || {};
  const s = r.summary || {};
  const num = (x) => typeof x === "number";
  const f = [];
  if (j.tool === "export-fix") {
    if (num(s.skins)) f.push(s.skins ? plural(s.skins, "skin") + ", " + s.usedJoints + " of " + s.joints + " joints used, identity error " + s.worstIdentityError + (s.unskinnable ? " (an identity rig: --unskin can drop it)" : " (NOT an identity rig: --unskin refuses it)") : "no skin");
    if (num(s.color0Prims)) f.push("COLOR_0 on " + plural(s.color0Prims, "primitive") + (s.color0Bake ? " (" + s.color0Bake + " a vertex-shading bake)" : ""));
    if (s.unskinnedNodes) f.push("unskinned " + plural(s.unskinnedNodes, "node"));
    if (s.droppedColor0) f.push("dropped COLOR_0 from " + plural(s.droppedColor0, "primitive"));
    if (s.freedAccessors) f.push("freed " + plural(s.freedAccessors, "orphaned accessor"));
  } else if (j.tool === "seat-split") {
    if (num(s.triangles)) f.push(s.triangles.toLocaleString() + " triangles in " + plural(s.shells || 0, "shell") + (s.method ? " (" + s.method + ")" : ""));
    if (s.materials && typeof s.materials === "object") f.push("from " + Object.entries(s.materials).map(([k, v]) => k + " " + (typeof v === "object" ? JSON.stringify(v) : v)).join(", "));
    if (s.consoleLeftOut) f.push("console left out: " + s.consoleLeftOut + " triangles");
    /* Which material the cut lands in, and why: the Camry's Driver_Seat_Red
       must say "redo-reuse" (its maps kept), never "new". */
    // (Only for a run that selected a seat: Inspect fills seatTarget with the
    // default name too, and "Driver_Seat (new)" on the Camry read as a plan.)
    if (s.seatTarget && s.seatTarget.name && num(s.triangles)) f.push("seat material " + s.seatTarget.name + " (" + ({ new: "new", append: "added to it", "redo-reuse": "cut again, its maps kept" }[s.seatTarget.how] || s.seatTarget.how) + "; name from " + s.seatTarget.from + ")");
    else if (s.seatName) f.push("seat material " + s.seatName);
    if (s.append) f.push("append into " + s.append.into + ": " + s.append.before + " + " + s.append.added + " triangles" + (s.append.alreadyIn ? " (" + s.append.alreadyIn + " already in it)" : ""));
  } else if (j.tool === "cabin-black") {
    // Its summary is LabCabinSummary (rows, not a line): see LabJob.
  } else if (j.tool === "mesh-strip") {
    if (num(s.total) && s.rows) f.push(s.shown + " of " + plural(s.total, "part") + " listed");
    if (s.wouldRemove) f.push("would remove " + plural(s.wouldRemove.length, "part"));
    if (num(s.removedPrimitives)) f.push("removed " + plural(s.removedPrimitives, "part") + ", " + (s.removedTriangles || 0).toLocaleString() + " triangles");
  } else {
    if (s.state) f.push("state: " + Object.entries(s.state).filter(([, v]) => v != null).map(([k, v]) => k + " " + v).join(", "));
    if (s.seams && s.seams.parts) f.push("seams between " + plural(s.seams.parts.length, "part"));
    if (s.pocket) f.push("pocket: " + plural(s.pocket.triangles || 0, "triangle") + (s.pocket.texelsLifted != null ? ", " + s.pocket.texelsLifted + " texels lifted" : s.pocket.wouldLift != null ? ", would lift " + s.pocket.wouldLift + " texels" : ""));
    if (s.bandRatio != null) f.push("band ratio " + s.bandRatio);
    if (s.specularReset) f.push("specular reset");
    if (Array.isArray(s.clusters)) f.push(plural(s.clusters.length, "dark cluster") + " (listed under Plate pocket)");
    // A dry run's exact size of the file the write would make.
    if (s.bytesWouldBe != null) f.push("a write would be " + mb(s.bytesWouldBe) + (r.bytesIn != null ? " (" + delta(r.bytesIn, s.bytesWouldBe) + ")" : ""));
  }
  if (r.bytesOut != null) f.push(mb(r.bytesIn) + " → " + mb(r.bytesOut) + " (" + delta(r.bytesIn, r.bytesOut) + ")");
  return f;
}
/* cabin-black's summary, the one-line facts: how much went black, the
   seat it kept, how much of the cabin seen through the glass is black now,
   how the paint was found, what it never touched. `report`: a Check, which
   says what WOULD go. The material lists are rows (LabCabinSummary). */
function labCabinFacts(s, report = false) {
  const f = [];
  if (!s || typeof s !== "object") return f;
  const n = (x) => (typeof x === "number" ? x.toLocaleString() : "?");
  if (typeof s.triangles === "number" && s.triangles > 0) f.push(n(s.triangles) + " triangles " + (report ? "would go" : "went") + " black" + (s.shells ? " (" + plural(s.shells, "shell") + ")" : "") + (s.material ? " into " + s.material : ""));
  const seat = Array.isArray(s.seat) ? s.seat : [];
  if (seat.length) f.push("seat kept: " + seat.join(", ") + (typeof s.seatTris === "number" ? " (" + n(s.seatTris) + " triangles)" : ""));
  else if (Array.isArray(s.seat)) f.push("no seat material: the seat " + (report ? "would go" : "went") + " black with the rest");
  if (typeof s.coverage === "number") f.push(Math.round(s.coverage * 1000) / 10 + "% of the cabin seen through the glass " + (report ? "would be" : "is") + " black");
  // How the paint was told apart, when the run had to find it itself.
  if (typeof s.paintHow === "string" && s.paintHow && !/^--paint/.test(s.paintHow)) f.push("paint: " + s.paintHow);
  /* skipped: {glass, paint, lights, keep, outside}, each {materials, tris}
     (outside: {shells, tris}); an older shape had name lists or counts. */
  if (s.skipped && typeof s.skipped === "object") {
    const sk = Object.entries(s.skipped).map(([k, v]) => {
      if (Array.isArray(v)) return v.length ? k + " " + plural(v.length, "material") : "";
      if (typeof v === "number") return v ? k + " " + n(v) : "";
      if (v && typeof v === "object" && typeof v.tris === "number") return v.tris ? k + " " + n(v.tris) + " tris" : "";
      return "";
    }).filter(Boolean);
    if (sk.length) f.push("not touched: " + sk.join(", "));
  }
  return f;
}
/* The whole cabin summary: the facts, then the materials it took triangles
   from ("all" when the material went whole and is gone) and the biggest
   leftovers with why they stayed, one row each -- the Optima's names run to
   45 characters, and six of them in one sentence read as a wall. The card
   (from the draft's sidecar) and a Check's job box both use it. */
const LAB_CABIN_ROWS = { moved: 5, left: 4 };
function LabCabinSummary({ s, report = false }) {
  if (!s || typeof s !== "object") return null;
  const n = (x) => (typeof x === "number" ? x.toLocaleString() : "?");
  const facts = labCabinFacts(s, report);
  const moved = Array.isArray(s.movedFrom) ? s.movedFrom : [];
  const left = Array.isArray(s.leftovers) ? s.leftovers : [];
  const more = (list, k) => (list.length > k ? <div className="c3t-dim c3t-mrow">+{list.length - k} more</div> : null);
  return (
    <React.Fragment>
      {facts.slice(0, 1).map((t, i) => <div key={"h" + i} className="c3t-fact">{t}</div>)}
      {moved.length > 0 && (
        <div className="c3t-mlist">
          <div className="c3t-dim">{report ? "Would take from" : "Taken from"} ({moved.length})</div>
          {moved.slice(0, LAB_CABIN_ROWS.moved).map((m, i) => (
            <div key={"m" + i + m.name} className="c3t-mrow"><span>{m.name}</span><output>{m.whole ? "all " + n(m.tris) : n(m.tris) + " / " + n(m.ofTris)}</output></div>
          ))}
          {more(moved, LAB_CABIN_ROWS.moved)}
        </div>
      )}
      {left.length > 0 && (
        <div className="c3t-mlist">
          <div className="c3t-dim">Left as it was ({left.length})</div>
          {left.slice(0, LAB_CABIN_ROWS.left).map((l, i) => (
            <div key={"l" + i + l.name} className="c3t-mrow"><span>{l.name}{l.why ? <i> · {l.why}</i> : null}</span><output>{n(l.tris)}</output></div>
          ))}
          {more(left, LAB_CABIN_ROWS.left)}
        </div>
      )}
      {facts.slice(1).map((t, i) => <div key={"f" + i} className="c3t-fact">{t}</div>)}
    </React.Fragment>
  );
}
/* The log tail: a progress line rewritten with \r keeps only its last state
   (the server collapses it too; an older one did not). */
const labLogTail = (log) => (log || "").split("\n").map((l) => l.split("\r").filter(Boolean).pop() || "")
  .filter((l) => l.trim() && !l.startsWith("LAB_JSON ")).slice(-8).join("\n");

/* A job box or a message is brought into the panel's view once per thing it
   announces (a job starting, the same job ending, a new message) -- not
   again each time its tab is shown, which would undo the scroll position a
   tab keeps. One that landed while its tab was hidden is announced when the
   tab opens. */
const labAnnounced = new Set();
const labAnnouncedMsgs = new WeakSet();
const labScrollTo = (el) => { if (el && el.offsetParent) el.scrollIntoView({ block: "nearest" }); };

function LabJob({ job }) {
  const r = job.result;
  const s = (r && r.summary) || {};
  const facts = labJobFacts(job);
  const notes = Array.isArray(s.notes) ? s.notes : [];
  const table = Array.isArray(s.materialTable) ? s.materialTable : null;
  const tail = labLogTail(job.log);
  const seed = labSeedOf(job.args);
  const checks = (r && r.checks) || [];
  const failed = checks.filter((c) => !c.pass);
  const passed = checks.filter((c) => c.pass);
  const ref = useRef(null);
  useEffect(() => {
    const k = job.id + ":" + job.state;
    if (labAnnounced.has(k)) return;
    labAnnounced.add(k);
    labScrollTo(ref.current);
  }, [job.state]);
  return (
    <div className="c3t-job" data-state={labQuiet(job) ? "nothing-new" : job.state} ref={ref}>
      <div className="c3t-kv"><span>{job.tool}{job.report ? ((job.args || []).includes("--dry-run") ? " (dry run)" : " (check)") : ""}{seed != null ? " · seed " + seed : ""}</span>
        <output>{labNoNew(job) ? "no new variant" : labNothing(job) ? "nothing to do" : job.state}{job.ms ? " · " + (job.ms / 1000).toFixed(1) + "s" : labElapsed(job) ? " · " + labElapsed(job) : ""}</output></div>
      {facts.map((t, i) => <div key={"f" + i} className="c3t-fact">{t}</div>)}
      {/* A written cabin draft's summary is on the Cabin tab's card. */}
      {job.tool === "cabin-black" && (job.report || !job.draft) && r && <LabCabinSummary s={r.summary} report={job.report} />}
      {table && (
        <div className="c3t-fact">
          <b>Materials by triangles</b>
          {table.slice(0, 12).map((m) => <div key={m.name} className="c3t-dim">{m.name} — {m.tris.toLocaleString()}</div>)}
          {table.length > 12 && <div className="c3t-dim">+{table.length - 12} more (in the log)</div>}
        </div>
      )}
      {failed.map((c, i) => <div key={"x" + i} className="c3t-check" data-pass="false">✗ {c.name}: {c.detail}</div>)}
      {r && (r.warnings || []).map((w, i) => <div key={"w" + i} className="c3t-check" data-pass="warn">! {w}</div>)}
      {/* A real seat cut reports a dozen passing checks and a few notes:
          spelled out they pushed the Try another button off the panel after
          every try. One line says they passed; it opens to the details. */}
      {(passed.length > 0 || notes.length > 0) && (
        <details className="c3t-log c3t-passed">
          <summary>{passed.length ? <span className="c3t-ok">✓ {failed.length ? plural(passed.length, "other check") : passed.length > 1 ? "all " + passed.length + " checks" : "its check"} passed</span> : null}
            {notes.length ? (passed.length ? ", " : "") + plural(notes.length, "note") : ""}</summary>
          {notes.map((t, i) => <div key={"n" + i} className="c3t-fact c3t-dim">note: {t}</div>)}
          {passed.map((c, i) => <div key={"c" + i} className="c3t-check" data-pass="true">✓ {c.name}: {c.detail}</div>)}
        </details>
      )}
      {/* The log tail repeats what is above once a result came back, so it
          starts folded then; a failure, a run still going, or a result with
          nothing else to show opens it. */}
      {tail && (
        <details className="c3t-log" open={job.state !== "done" || !(facts.length || (r && (r.checks || []).length))}>
          <summary>Log (last lines)</summary>
          <pre className="c3t-code">{tail}</pre>
        </details>
      )}
    </div>
  );
}

/* A tab's message (a refusal, "Draft 2 written", Save's verdict), brought
   into view the first time it shows, as LabJob is. */
function LabMsg({ msg }) {
  const ref = useRef(null);
  useEffect(() => {
    if (labAnnouncedMsgs.has(msg)) return;
    labAnnouncedMsgs.add(msg);
    labScrollTo(ref.current);
  }, [msg]);
  return <p className="c3t-msg" data-ok={msg.ok ? "true" : msg.info ? "info" : undefined} ref={ref}>{msg.text}</p>;
}

/* The how-to-start note. lab.cmd in the repo root is the one-click start:
   the lab server on this PC's Wi-Fi address, port 8001, with --open (no
   token), so the page at http://<PC's IP>:8001/?tune=1 -- on the PC or on a
   phone -- runs the tools; it listens on localhost:8001 as well. A page
   served by something else (npx serve on :3000, the plain site on :8000)
   cannot use a lab server on another port: the requests are same-origin.
   By hand, the server must be started from the repo root: from
   visual-search-standalone, `node tools/lab-server.mjs` fails with "Cannot
   find module". */
function LabMissing({ onRetry }) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(location.hostname);
  // Opened by this PC's LAN address (the plain site on :8000): that is the address lab.cmd uses too.
  const host = !local && /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : "<PC's IP>";
  return (
    <div className="c3t-body">
      {labServer.state === "error" && <p className="c3t-msg">The lab server answered: {labServer.error}</p>}
      <p className="c3t-note">Editing car files needs the lab server. This page (<b>{location.host}</b>) is served by something else{location.port === "8000" ? ", the plain site" : ""}.</p>
      <ol className="c3t-ol">
        <li>Double-click <b>lab.cmd</b> in the repo root, <code>C:\Users\ali\Desktop\3d-model</code>. It starts the lab server on this PC's Wi-Fi address, port 8001, and prints that address.</li>
        <li>Open <code>{"http://" + host + ":8001/?tune=1"}</code> — on this PC or on a phone on the same Wi-Fi{local ? <span> (here, <code>http://localhost:8001/?tune=1</code> works too)</span> : null}.</li>
      </ol>
      <p className="c3t-note">Or by hand, from the repo root (from visual-search-standalone it fails with "Cannot find module"):</p>
      <pre className="c3t-code">{"cd C:\\Users\\ali\\Desktop\\3d-model\n" + (local ? "node tools/lab-server.mjs" : "node tools/lab-server.mjs --host auto --port 8001 --open")}</pre>
      {local && <p className="c3t-note">then reopen <code>http://localhost:3000/?tune=1</code>.</p>}
      <div className="c3t-actions"><button onClick={onRetry}>Check again</button></div>
    </div>
  );
}

/* ── pieces the tabs share ─────────────────────────────────────────────────── */
/* What every tab reads from the bag and status, worked out once per render. */
function labDerive(car, file) {
  const S = labBag(file);
  const look = (car && car.model && car.model.look) || {};
  const st = S.status;
  const running = Object.keys(S.jobs).find((k) => S.jobs[k] && S.jobs[k].state === "running") || null;
  const busy = !!(labServer.busy || S.op || running);
  const drafts = (st && st.drafts) || [];
  const info = (st && st.info) || null;
  const mats = (info && info.materials) || [];
  const matNames = new Set(mats.map((m) => m.name));
  const reg = (info && info.registry) || null;
  const regSeat = (reg && reg.seat && reg.seat.length ? reg.seat : look.seat) || [];
  const paintGuess = (look.paint || []).find((n) => matNames.has(n)) || (info ? "" : (look.paint || [])[0] || "");
  const paint = S.paint != null ? S.paint : paintGuess;
  /* Look names the newest file lacks, minus the ones the black cabin covers
     -- the server's rule (lab-server.mjs, Save step 0): a name listed only
     under interior / wheel is covered when the file has the cabin material,
     or, being the cabin material's own name, when another interior name is
     in the file. Save refuses only the rest. */
  const cabin = (info && info.cabinMaterial) || null;
  const slots = (reg && reg.slots) || {};
  const onlyCabin = (n) => { const w = Object.keys(slots).filter((k) => (slots[k] || []).includes(n)); return w.length > 0 && w.every((k) => k === "interior" || k === "wheel"); };
  const lookMissing = info ? ((reg && reg.lookNames) || []).filter((n) => !matNames.has(n)) : [];
  const covered = lookMissing.filter((n) => onlyCabin(n) && (cabin || (n === "Interior_Black" && (slots.interior || []).some((x) => matNames.has(x)))));
  return {
    S, file, look, st, info, mats, matNames, reg, regSeat, paint, running, busy, drafts, cabin, covered,
    put: (p) => labPut(file, p),
    last: drafts[drafts.length - 1] || null,
    key: labDraftKey(st),
    missingLook: lookMissing.filter((n) => !covered.includes(n)),
    skinned: !!(info && info.skinned),
    seatMats: (info && info.seatMaterials) || [],
    seatName: regSeat[0] || "",
    paintInfo: mats.find((m) => m.name === paint) || null,
    previewN: labPreview && labPreview.file === file ? labPreview.n : null,
    carLen: (car && car.model && car.model.lengthMm) || null,
  };
}

/* A tab's own job and message, under its buttons. */
function LabFeedback({ S, tab }) {
  const job = S.jobs[tab];
  const msg = S.msgs[tab];
  return (
    <React.Fragment>
      {job && <LabJob key={job.id} job={job} />}
      {msg && <LabMsg msg={msg} />}
    </React.Fragment>
  );
}

/* "More options": the flags most runs never need, folded; remembered per
   car. */
function LabMore({ S, file, id, label = "More options", children }) {
  const open = !!S.more[id];
  return (
    <div className="c3t-more">
      <button className="c3t-morehead" aria-expanded={open} onClick={() => labPut(file, (b) => ({ more: { ...b.more, [id]: !open } }))}>
        {open ? "▾" : "▸"} {label}
      </button>
      {open && <div className="c3t-morebody">{children}</div>}
    </div>
  );
}

/* A short row of exclusive choices (how Seat finds the seat). */
function LabSeg({ label, value, options, onChange }) {
  return (
    <div className="c3t-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/* The skinned-export hint, with the way out one tap away. */
const LabSkinHint = ({ tool }) => (
  <p className="c3t-hint">Skinned export: {tool} refuses it (it can lie on its side in the tools' coordinates). <button className="c3t-link" onClick={() => labSetTab("export")}>Remove the skin in Export</button> first.</p>
);

/* Tap-to-pick buttons and their instructions. */
function labPickBtn(S, file, purpose, label) {
  const on = S.pick && S.pick.for === purpose;
  return (
    <button className={on ? "c3t-on" : ""} onClick={() => labPut(file, { pick: on ? null : { for: purpose, a: null }, ...(purpose === "seat" ? { picked: null } : {}) })}>
      {on ? (purpose === "seat" ? "Tap the seat…" : S.pick.a ? "Tap corner B…" : "Tap corner A…") : label}
    </button>
  );
}
function LabPickNote({ S }) {
  if (!S.pick) return null;
  return (
    <p className="c3t-note c3t-tip">
      {S.pick.for === "seat"
        ? "Rotate to a front-three-quarter view (looking in past the windscreen corner at the driver's seat), then tap the seat. Glass is ignored. Works with the panel collapsed."
        : S.pick.a ? "Corner A " + fmtPt({ x: S.pick.a[0], y: S.pick.a[1], z: S.pick.a[2] }) + ". Rotate if needed and tap the opposite corner."
        : "Tap one corner of the " + (S.pick.for === "pocket" ? "pocket" : "seat") + ", then the opposite corner; the box spans both, padded a little."}
    </p>
  );
}

/* ── variants: the buttons, the card, the Tried list ───────────────────────
   run(seed, replace): the tab's action with the current controls, seed null
   for the calibrated result. While this very action's result is the newest
   draft (and not kept), every run replaces it instead of stacking. */
function LabVariantActions({ D, tab, opKey, tool, ready, randomOk = true, run, check, randomLabel, randomTitle, calibratedLabel = "Calibrated" }) {
  const v = labVariantOf(D.st, tab, D.S.kept);
  const trying = !!(v && !v.kept && v.opKey === opKey && v.tool === tool);
  const dis = D.busy || !ready;
  return (
    <div className="c3t-actions c3t-main">
      <button className="c3t-primary" disabled={dis || !randomOk}
        title={(trying ? "A new random seed, in place of draft " + v.d.n : "A new draft from a fresh random seed; every click gives another valid result") + (randomTitle ? ". " + randomTitle : "")}
        onClick={() => run(labNewSeed(), trying)}>{trying ? "Try another" : randomLabel}</button>
      {trying && <button disabled={D.busy} title="Keep this one: the next run stacks on it" onClick={() => labPut(D.file, (b) => ({ kept: { ...b.kept, [v.url]: true } }))}>Keep</button>}
      <button disabled={dis} title={"Today's calibrated result (no seed)" + (trying ? ", in place of draft " + v.d.n : "")} onClick={() => run(null, trying)}>{calibratedLabel}</button>
      {check && <button disabled={dis} title="What it would do; nothing is written" onClick={check}>Check</button>}
    </div>
  );
}
/* When the newest draft is another action of this tab (a Tap cut while Box
   is chosen), a run stacks on it: said in one line, so it is no surprise. */
function LabStackNote({ D, tab, opKey }) {
  const v = labVariantOf(D.st, tab, D.S.kept);
  if (!v || v.kept || v.opKey === opKey) return null;
  return <p className="c3t-note">Draft {v.d.n} is a {LAB_OP_LABEL[v.opKey]} result: this stacks on it (Undo last in Save drops it).</p>;
}
/* The variant on the car: its seed and every drawn value, so a good one can
   be noted, or reproduced with --seed. */
function LabVariantCard({ D, tab }) {
  const v = labVariantOf(D.st, tab, D.S.kept);
  if (!v) return null;
  const m = v.meta;
  const vr = m.variation;
  const params = labParams(v.tool, vr && vr.params);
  const rej = (vr && vr.rejected) || [];
  const failed = [...new Set(rej.flatMap((x) => x.failed || []))];
  return (
    <div className="c3t-variant">
      <div className="c3t-kv"><span>Draft {v.d.n}{tab === "seat" ? " · " + LAB_OP_LABEL[v.opKey] : ""}{v.kept ? " · kept" : ""}</span><output>{m.seed != null ? "seed " + m.seed : "calibrated"}</output></div>
      {vr && typeof vr.label === "string" && vr.label && <div className="c3t-fact">{vr.label}</div>}
      {params.length > 0 && <div className="c3t-params">{params.map(([k, val]) => <span key={k}>{k} <b>{val}</b></span>)}</div>}
      {vr && (typeof vr.triangles === "number" || vr.attempt) && (
        <div className="c3t-fact c3t-dim">{typeof vr.triangles === "number" ? vr.triangles.toLocaleString() + " triangles" + (vr.attempt ? " · " : "") : ""}{vr.attempt ? "attempt " + vr.attempt + " of " + vr.tries : ""}{vr.attempt > 1 && failed.length ? "; the draws before it failed " + failed.join(", ") : ""}</div>
      )}
    </div>
  );
}
/* The runs tried on this base, newest first. Tapping one puts it back on
   the car: the same args (seed included) on the same base, with replace. */
function LabTried({ D, tab }) {
  const v = labVariantOf(D.st, tab, D.S.kept);
  if (!v || v.kept) return null;
  const list = (D.S.tried[tab] || []).filter((e) => e.opKey === v.opKey && e.baseKey === v.baseKey);
  if (list.length < 2) return null;
  const cur = (v.meta.args || []).join("\u0001");
  return (
    <div className="c3t-tried">
      <div className="c3t-sub">Tried ({list.length})</div>
      {list.map((e) => {
        const on = e.args.join("\u0001") === cur;
        const brief = e.ok ? labVariantBrief(e.tool, e) : e.nothingNew ? (e.tool === "cabin-black" ? "nothing to do" : "no new variant") : "failed " + (e.failed.join(", ") || "its checks");
        return (
          <button key={e.key} className="c3t-try" data-on={on ? "true" : undefined} data-ok={e.ok ? "true" : "false"} disabled={D.busy || !e.ok || on}
            title={on ? "This one is draft " + v.d.n : e.ok ? "Put this one back on the car (replaces draft " + v.d.n + ")" : e.error || "no variant passed"}
            onClick={() => labRun(D.file, e.tool, e.args, false, { opKey: e.opKey, replace: true })}>
            <span className="c3t-tryseed">{e.ok ? "✓" : e.nothingNew ? "·" : "✗"} {e.seed != null ? e.seed : "calibrated"}</span>
            <span className="c3t-trywhat">{brief}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── the strip under the tabs ───────────────────────────────────────────────
   What the tools read, which file the car shows, and what the server is
   busy with. One line: everything else lives in the tabs. */
function LabStrip({ car, file, tab }) {
  const D = labDerive(car, file);
  const { S, st, drafts, last, previewN, running } = D;
  const b = labServer.busy;
  let state = "ok", text;
  if (labServer.state === "checking") { state = "wait"; text = "Looking for the lab server…"; }
  else if (labServer.state !== "ok") { state = "off"; text = "No lab server"; }
  else if (running) { state = "busy"; text = "Running " + S.jobs[running].tool + "… " + labElapsed(S.jobs[running]); }
  else if (S.op) { state = "busy"; text = { save: "Saving…", restore: "Restoring…", undo: "Undoing…", discard: "Discarding…" }[S.op] || S.op + "…"; }
  else if (b) { state = "busy"; text = "Busy: " + (b.kind === "job" ? "a job" : "a " + b.kind) + (b.file && b.file !== file ? " on " + b.file : "") + "…"; }
  else if (!st) text = "No assets/" + file + " on the lab server";
  else text = last ? "Tools read draft " + last.n : "Tools read the shipped file";
  const readOnly = labServer.state === "ok" && labServer.auth === "token" && labToken() === "1";
  return (
    <React.Fragment>
      <div className="c3t-strip" data-state={state}>
        <i className="c3t-dot" aria-hidden="true" />
        {running && running !== tab
          ? <button className="c3t-link c3t-striptext" title="Open its tab" onClick={() => labSetTab(running)}>{text}</button>
          : <span className="c3t-striptext">{text}</span>}
        {st && drafts.length > 0 && (
          <label className="c3t-show" data-old={previewN != null && previewN !== last.n ? "true" : undefined}
            title={previewN != null && previewN !== last.n ? "The car shows draft " + previewN + "; the tools read draft " + last.n : "Which file the car shows"}>
            <span>Show</span>
            <select value={previewN == null ? "" : String(previewN)} onChange={(e) => labShowDraft(file, st, e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">shipped</option>
              {drafts.map((d) => <option key={d.n} value={String(d.n)}>draft {d.n}</option>)}
            </select>
          </label>
        )}
      </div>
      {readOnly && <p className="c3t-hint">Read-only from here: this server wants its key. Open the URL it printed (ending in #lab=…), or start it with lab.cmd.</p>}
    </React.Fragment>
  );
}

/* ── Export ── */
function ExportTab({ D }) {
  const { S, file, put, info, skinned, paint, paintInfo, key, busy } = D;
  const xf = S.xf;
  /* A Check of this very file settles what each fix can do: --unskin only
     on an identity rig (export-fix refuses any other, and with no skin there
     is nothing to drop), --drop-color0 only while COLOR_0 that is not a
     vertex-shading bake is there (export-fix keeps a bake unless --force,
     which Extra flags can still send). Before a Check both stay open. */
  const xfCur = xf && xf.key === key ? xf : null;
  const xfForeign = xfCur ? (typeof xfCur.color0Foreign === "number" ? xfCur.color0Foreign : (xfCur.color0Prims || 0) - (xfCur.color0Bake || 0)) : null;
  const canUnskin = !xfCur || !!xfCur.unskinnable;
  const canDrop = xfForeign == null || xfForeign > 0;
  /* Ticked by default when the file needs it: a skin, or foreign COLOR_0.
     The Check tells a bake from foreign COLOR_0 by the bytes; before one,
     status counts the COLOR_0 primitives of materials without
     vertex-shading's marker. */
  const xfUnskin = canUnskin && (S.xfUnskin != null ? S.xfUnskin : skinned);
  const xfDrop = canDrop && (S.xfDropColor0 != null ? S.xfDropColor0
    : xfForeign != null ? xfForeign > 0
    : !!(info && (typeof info.color0Foreign === "number" ? info.color0Foreign : info.color0Prims) > 0));
  const xfArgs = () => [...(xfUnskin ? ["--unskin"] : []), ...(xfDrop ? ["--drop-color0"] : []), ...labParseFlags(S.xfExtra)];
  return (
    <React.Fragment>
      {skinned && <p className="c3t-hint">Skinned export: tick "Remove identity skin" and Fix export first. Seat and Gaps refuse a skinned file (it can lie on its side in the tools' coordinates).</p>}
      {paintInfo && paintInfo.color0 && !paintInfo.shaded && <p className="c3t-hint">The paint ({paint}) carries COLOR_0: drop it here before Gaps (vertex-shading refuses a foreign COLOR_0).</p>}
      {xf && (
        <p className="c3t-note">Last check{xf.key !== key ? " (of an older draft)" : ""}: {xf.skins ? plural(xf.skins, "skin") + (xf.unskinnable ? " (identity: can unskin)" : " (NOT identity)") : "no skin"}, COLOR_0 on {plural(xf.color0Prims || 0, "primitive")}{xf.orphanedAccessors ? ", " + xf.orphanedAccessors + " orphaned accessors" : ""}.</p>
      )}
      {!xf && <p className="c3t-note">{skinned ? "This file is skinned." : info && info.color0Prims ? "COLOR_0 on " + plural(info.color0Prims, "primitive") + "." : "Nothing to fix that status can see; Check reads the file itself."}</p>}
      <label className="c3t-opt"><input type="checkbox" checked={xfUnskin} disabled={!canUnskin} onChange={(e) => put({ xfUnskin: e.target.checked })} /><span>Remove identity skin (--unskin){!canUnskin ? (xfCur.skins ? " — not an identity rig, refused" : " — no skin") : ""}</span></label>
      <label className="c3t-opt"><input type="checkbox" checked={xfDrop} disabled={!canDrop} onChange={(e) => put({ xfDropColor0: e.target.checked })} /><span>Drop COLOR_0 (--drop-color0){!canDrop ? (xfCur.color0Bake ? " — only the shading bake, kept" : " — none") : ""}</span></label>
      <LabMore S={S} file={file} id="export">
        <label className="c3t-row"><span>Extra flags</span><input className="c3t-input" value={S.xfExtra} onChange={(e) => put({ xfExtra: e.target.value })} placeholder="--force" /></label>
      </LabMore>
      <div className="c3t-actions c3t-main">
        <button className="c3t-primary" disabled={busy || (!xfUnskin && !xfDrop)} onClick={() => labRun(file, "export-fix", xfArgs(), false, { opKey: "export-fix" })}>Fix export</button>
        <button disabled={busy} onClick={() => labRun(file, "export-fix", labParseFlags(S.xfExtra).filter((a) => a !== "--force"), true)}>Check</button>
      </div>
      <LabFeedback S={S} tab="export" />
    </React.Fragment>
  );
}

/* ── Seat ── */
function SeatTab({ D }) {
  const { S, file, put, info, busy, skinned, seatMats, seatName, regSeat, matNames, st, cabin, drafts } = D;
  const v = labVariantOf(st, "seat", S.kept);
  const method = S.seatMethod || (v ? v.opKey.slice(5) : S.picked ? "pick" : "auto");
  const opKey = "seat-" + method;
  // --name keeps a car's own seat name (the Camry's Driver_Seat_Red):
  // without it a Redo renames the seat and the site loses it.
  const nameArgs = seatName && seatName !== "Driver_Seat" ? ["--name", seatName] : [];
  const hintArgs = [...(S.front ? ["--front", S.front] : []), ...(S.driver ? ["--driver", S.driver] : [])];
  /* --redo / --append go with a file that has a seat already. Try another
     reads the draft BEFORE the newest, which status.info does not describe;
     the variant it replaces was cut with the right flag for that file, so
     its own args say whether that file had a seat. */
  const modeArgs = (replace) => {
    if (!S.seatMode) return [];
    const had = replace && v ? (v.meta.args || []).some((a) => a === "--redo" || a === "--append") : seatMats.length > 0;
    return had ? ["--" + S.seatMode] : [];
  };
  const seatArgs = (sel, write, replace = false, seeded = false) => {
    const extra = labParseFlags(S.seatExtra);
    return [...sel, ...hintArgs, ...nameArgs, ...modeArgs(replace), ...(write && S.seatForce ? ["--force"] : []), ...(seeded ? labStripSeed(extra) : extra)];
  };
  /* The point (or box) of the variant being tried, when the page has none
     of its own -- after a reload: Try another must not need a new tap. */
  const vArg = (flag) => { const a = v && !v.kept && v.opKey === opKey ? v.meta.args || [] : []; const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  const pickPt = S.picked ? fmtPt(S.picked.pos) : vArg("--pick");
  const boxVal = S.seatBox.trim() || vArg("--box") || "";
  const sel = method === "auto" ? ["--auto"]
    : method === "pick" ? (pickPt ? ["--pick", pickPt] : null)
    : boxVal ? ["--box", boxVal, "--mode", S.seatBox.trim() ? S.boxMode : vArg("--mode") || S.boxMode] : null;
  /* No --source for these: a seat can span several materials (the
     Maxima's white_leather + perforation + plastic), and the tool already
     refuses pillars, headliner, doors and the other seat. */
  const run = (seed, replace) => labRun(file, "seat-split", [...seatArgs(sel, true, replace, seed != null), ...(seed != null ? ["--seed", String(seed)] : [])], false, { opKey, replace });
  const regSeatMissing = info && regSeat.length && !regSeat.some((n) => matNames.has(n));
  return (
    <React.Fragment>
      {skinned && <LabSkinHint tool="seat-split" />}
      {info && (
        <p className="c3t-note">{seatMats.length ? <span>Has <b>{seatMats.join(", ")}</b>.</span> : "No seat material yet."}
          {seatName ? <span> Registry seat: <b>{seatName}</b>{nameArgs.length ? " (passed as --name)" : ""}.</span> : " No seat slot in the registry (Save adds one)."}</p>
      )}
      {regSeatMissing ? <p className="c3t-hint">The registry's seat slot names {regSeat.join(", ")}, which the newest file does not have: the site would show no red seat, and Save refuses. Cut it again (the name is passed for you) or Undo.</p> : null}
      {/* seat-split finds the seat by its material; after cabin-black the
          seat's leftovers, the dash and the doors are one material. */}
      {cabin && <p className="c3t-hint">The cabin is already black ({cabin}): undo it before re-cutting the seat, then black it again. <button className="c3t-link" onClick={() => labSetTab("save")}>{drafts.some((d) => d.tool === "cabin-black") ? "Undo in Save" : "It is in the saved file: Restore the one before it in Save"}</button></p>}
      <LabSeg label="How to find the seat" value={method} options={[["auto", "Find it"], ["pick", "Tap"], ["box", "Box"]]}
        onChange={(m) => put({ seatMethod: m, pick: S.pick && S.pick.for === "pocket" ? S.pick : null })} />
      {method === "auto" && <p className="c3t-note">Finds the driver's whole seat by itself: cushion, backrest, headrest and its posts, bolsters and the seat back.</p>}
      {method === "pick" && (
        <React.Fragment>
          <div className="c3t-actions">{labPickBtn(S, file, "seat", S.picked ? "Tap again" : "Tap the seat")}</div>
          {S.pick && S.pick.for === "seat" ? <LabPickNote S={S} />
            : S.picked ? <p className="c3t-note">Picked {fmtPt(S.picked.pos)} on <b>{S.picked.material || "?"}</b></p>
            : pickPt ? <p className="c3t-note">Point {pickPt}, from draft {v.d.n}.</p>
            : <p className="c3t-note">Cuts the whole seat under a tap on it.</p>}
        </React.Fragment>
      )}
      {method === "box" && (
        <React.Fragment>
          <p className="c3t-note">The fallback when Find it or a tap cannot separate the seat.</p>
          <input className="c3t-input c3t-wide" aria-label="Seat box" value={S.seatBox} onChange={(e) => put({ seatBox: e.target.value })} placeholder={boxVal || "x0,y0,z0,x1,y1,z1"} />
          <div className="c3t-actions">
            {labPickBtn(S, file, "seatBox", "Tap 2 corners")}
            <select value={S.boxMode} onChange={(e) => put({ boxMode: e.target.value })} title="--mode: whole shells, or triangles inside the box">
              <option value="shell">shells</option>
              <option value="tris">triangles</option>
            </select>
          </div>
          {S.pick && S.pick.for === "seatBox" && <LabPickNote S={S} />}
        </React.Fragment>
      )}
      <LabMore S={S} file={file} id="seat">
        {seatMats.length > 0 && (
          <label className="c3t-row"><span>Seat already cut</span>
            <select value={S.seatMode} onChange={(e) => put({ seatMode: e.target.value })}>
              <option value="redo">Redo: cut again, replacing it (--redo)</option>
              <option value="append">Append: add to it (--append)</option>
              <option value="">Neither (the tool refuses)</option>
            </select>
          </label>
        )}
        <div className="c3t-actions c3t-hints">
          <label>Front <select value={S.front} onChange={(e) => put({ front: e.target.value })}><option value="">auto</option><option value="+z">+z</option><option value="-z">−z</option><option value="+x">+x</option><option value="-x">−x</option></select></label>
          <label>Driver <select value={S.driver} onChange={(e) => put({ driver: e.target.value })}><option value="">auto</option><option value="left">left</option><option value="right">right</option></select></label>
        </div>
        <label className="c3t-opt"><input type="checkbox" checked={S.seatForce} onChange={(e) => put({ seatForce: e.target.checked })} /><span>Write despite failed checks (--force)</span></label>
        <label className="c3t-row"><span>Extra flags</span><input className="c3t-input" value={S.seatExtra} onChange={(e) => put({ seatExtra: e.target.value })} placeholder={'--source "a b",c  --exclude …  --min-inside 0.5'} /></label>
        <div className="c3t-actions">
          <button disabled={busy || skinned} title="List every material: triangles, meshes, bounds" onClick={() => labRun(file, "seat-split", [], true)}>Inspect</button>
          <button disabled={busy || skinned} title={"Rename a lone near-miss like Driver_Seat.001 to " + (seatName || "Driver_Seat") + " (JSON only)"} onClick={() => labRun(file, "seat-split", ["--rename-seat", ...nameArgs], false, { opKey: "seat-name" })}>Fix name</button>
        </div>
      </LabMore>
      <LabVariantActions D={D} tab="seat" opKey={opKey} tool="seat-split" ready={!!sel && !skinned} run={run} randomLabel="Random cut"
        randomTitle="Always the whole seat; a variant only changes what comes along with it (base covers, recliner lever, belt buckle)"
        check={() => labRun(file, "seat-split", seatArgs(sel, false), true)} />
      <LabStackNote D={D} tab="seat" opKey={opKey} />
      <LabVariantCard D={D} tab="seat" />
      <LabTried D={D} tab="seat" />
      <LabFeedback S={S} tab="seat" />
    </React.Fragment>
  );
}

/* ── Cabin ──
   cabin-black: every cabin triangle except the driver's seat into one black
   material. The flags that keep the wrong things out are sent for the user:
   --seat (the file's Driver_Seat* materials -- the tool takes those by
   itself too, but saying so costs nothing) and --paint (the look's paint,
   so a body panel is never read as cabin). --keep, --name, Force and Extra
   flags sit under More options. */
function CabinTab({ D }) {
  const { S, file, put, info, busy, skinned, seatMats, mats, matNames, look, st, cabin } = D;
  const v = labVariantOf(st, "cabin", S.kept);
  const trying = !!(v && !v.kept);
  // The tool's lists are comma-separated: a name with a comma cannot be in one.
  const listable = (n) => !!n && !n.includes(",");
  /* --paint: the look's paint names this file has, else the one chosen in
     Gaps; with neither the tool finds the paint itself and says how. */
  const lookPaint = (look.paint || []).filter((n) => matNames.has(n));
  const paintList = (lookPaint.length ? lookPaint : S.paint ? [S.paint] : []).filter(listable);
  const seatList = seatMats.filter(listable);
  /* --name: the one typed, else the file's own cabin material when it goes
     by another name, so a re-run adds to it instead of starting a second. */
  const nameArg = S.cabinName.trim() || (cabin && cabin !== "Interior_Black" ? cabin : "");
  const keep = Object.keys(S.cabinKeep).filter((k) => S.cabinKeep[k]);
  const cabinArgs = (write, seeded = false) => {
    const extra = labParseFlags(S.cabinExtra);
    return [
      ...(seatList.length ? ["--seat", seatList.join(",")] : []),
      ...(paintList.length ? ["--paint", paintList.join(",")] : []),
      ...(keep.length ? ["--keep", keep.join(",")] : []),
      ...(nameArg ? ["--name", nameArg] : []),
      ...(write && S.cabinForce ? ["--force"] : []),
      ...(seeded ? labStripSeed(extra) : extra),
    ];
  };
  const run = (seed, replace) => labRun(file, "cabin-black", [...cabinArgs(true, seed != null), ...(seed != null ? ["--seed", String(seed)] : [])], false, { opKey: "cabin", replace });
  const check = () => labRun(file, "cabin-black", cabinArgs(false), true);
  /* What --keep can name: the materials of the file the next run reads.
     While trying that is the draft BEFORE the variant, so the names the
     variant merged away (its record's movedFrom) are listed as well. The
     seat, the paint and the black material itself are left out (the tool
     never blackens the first two). Biggest first: the cabin's own materials
     are the big ones. */
  const merged = trying && v.meta.summary && Array.isArray(v.meta.summary.movedFrom) ? v.meta.summary.movedFrom : [];
  const sizes = new Map(mats.map((m) => [m.name, typeof m.tris === "number" ? m.tris : null]));
  for (const m of merged) if (m && m.name) sizes.set(m.name, typeof m.ofTris === "number" ? m.ofTris : sizes.get(m.name) ?? null);
  const hide = new Set([...seatMats, ...paintList, ...(cabin ? [cabin] : [])]);
  for (const k of keep) if (!sizes.has(k)) sizes.set(k, null);
  const keepRows = [...sizes.entries()].filter(([n]) => n && (!hide.has(n) || keep.includes(n))).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  const tris = info && typeof info.cabinTris === "number" ? info.cabinTris.toLocaleString() + " triangles" : "";
  return (
    <React.Fragment>
      {skinned && <LabSkinHint tool="cabin-black" />}
      {info && (
        <p className="c3t-note">
          {seatMats.length ? <span>Seat <b>{seatMats.join(", ")}</b> stays red. </span> : null}
          {!cabin ? "The cabin is not black yet."
            : trying ? <span>Draft {v.d.n} made it black: <b>{cabin}</b>{tris ? ", " + tris : ""}.</span>
            : <span>The cabin is already black: <b>{cabin}</b>{tris ? ", " + tris : ""}. A run adds what is left to it.</span>}
        </p>
      )}
      {info && !seatMats.length && (
        <p className="c3t-hint">No driver's seat material in this file: cut the seat first (<button className="c3t-link" onClick={() => labSetTab("seat")}>Seat tab</button>), or it goes black with the rest of the cabin.</p>
      )}
      {!cabin && <p className="c3t-note">Moves every cabin triangle except the driver's seat into one black material: dash, door panels, the other seats, carpets, headliner. Glass, paint, lights and the outside stay.</p>}
      {info && !paintList.length && <p className="c3t-note">The look names no paint this file has: cabin-black finds the body paint itself (its result says how).</p>}
      <LabMore S={S} file={file} id="cabin" label={"More options" + (keep.length ? " · keeps " + keep.length : "") + (S.cabinName.trim() ? " · named" : "")}>
        <div className="c3t-sub">Never blacken (--keep){keep.length ? ": " + keep.length : ""}</div>
        <div className="c3t-list c3t-keep" role="group" aria-label="Materials to keep">
          {keepRows.length === 0 && <p className="c3t-note">No other materials.</p>}
          {keepRows.map(([n, t]) => (
            <label key={n} className="c3t-opt" title={listable(n) ? n : "A name with a comma cannot be passed in --keep's list"}>
              <input type="checkbox" checked={!!S.cabinKeep[n]} disabled={!listable(n)} onChange={(e) => put((b) => ({ cabinKeep: { ...b.cabinKeep, [n]: e.target.checked } }))} />
              <span>{n}</span>{t != null && <output>{t.toLocaleString()}</output>}
            </label>
          ))}
        </div>
        <label className="c3t-row"><span>Material name (--name)</span><input className="c3t-input" value={S.cabinName} onChange={(e) => put({ cabinName: e.target.value })} placeholder={cabin || "Interior_Black"} /></label>
        <label className="c3t-opt"><input type="checkbox" checked={S.cabinForce} onChange={(e) => put({ cabinForce: e.target.checked })} /><span>Write despite failed checks (--force)</span></label>
        <label className="c3t-row"><span>Extra flags</span><input className="c3t-input" value={S.cabinExtra} onChange={(e) => put({ cabinExtra: e.target.value })} placeholder="--tries 12" /></label>
      </LabMore>
      <LabVariantActions D={D} tab="cabin" opKey="cabin" tool="cabin-black" ready={!!st && !skinned} run={run} check={check} randomLabel="Random"
        randomTitle="The seat, glass, paint and lights never change; a variant moves the cabin's edge (dash top, door tops, pillar trims, parcel shelf)" />
      <LabCabinCard D={D} v={v} />
      <LabTried D={D} tab="cabin" />
      <LabFeedback S={S} tab="cabin" />
    </React.Fragment>
  );
}
/* The black cabin on the car: the newest cabin-black draft in the chain,
   what made it (seed or calibrated, the variant's label) and, from its
   sidecar, what went black, from which materials, and what was left. */
function LabCabinCard({ D, v }) {
  const { drafts, S } = D;
  let d = null;
  for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].tool === "cabin-black") { d = drafts[i]; break; }
  if (!d) return null;
  const m = d.meta || null;
  const newest = d === drafts[drafts.length - 1];
  const job = S.jobs.cabin;
  // The record's summary; a job that wrote this very draft has it too.
  const s = (m && m.summary) || (job && job.draft && job.draft.url === d.url && job.result && job.result.summary) || null;
  const vr = (m && m.variation) || null;
  const params = labParams("cabin-black", vr && vr.params, 6);
  const kept = newest && v && v.d === d && v.kept;
  return (
    <div className="c3t-variant c3t-cabincard">
      <div className="c3t-kv"><span>Draft {d.n}{newest ? "" : " · under draft " + drafts[drafts.length - 1].n}{kept ? " · kept" : ""}</span>
        <output>{m ? (m.seed != null ? "seed " + m.seed : "calibrated") : ""}</output></div>
      {vr && typeof vr.label === "string" && vr.label && <div className="c3t-fact">{vr.label}</div>}
      {params.length > 0 && <div className="c3t-params">{params.map(([k, val]) => <span key={k}>{k} <b>{val}</b></span>)}</div>}
      <LabCabinSummary s={s} />
      {!s && <div className="c3t-fact c3t-dim">No record of what moved (a draft from before this page kept one).</div>}
    </div>
  );
}

/* ── Gaps ── */
function GapsTab({ D }) {
  const { S, file, put, info, busy, skinned, mats, look, paint, paintInfo, reg, key, st } = D;
  const v = labVariantOf(st, "gaps", S.kept);
  const gapGuess = paintInfo && paintInfo.occlusion === "png" ? "occlusion-patch" : "vertex-shading";
  const gapTool = S.gapTool || gapGuess;
  const isOP = gapTool === "occlusion-patch";
  const opKey = isOP ? "gaps-occlusion" : "gaps-vertex";
  const regLen = (reg && reg.lengthMm) || D.carLen || null;
  const lengthMm = S.lengthMm != null ? S.lengthMm : regLen || 4800;
  const missingPaint = info ? (look.paint || []).filter((n) => !D.matNames.has(n)) : [];
  const showMR = isOP && paintInfo && paintInfo.mr && !paintInfo.occlusion;
  // A marked paint's COLOR_0 is vertex-shading's own bake, not a foreign one.
  const showDropForeign = !isOP && paintInfo && paintInfo.color0 && !paintInfo.shaded;
  /* Try another reads the draft before the newest, which status.info does
     not describe: the flags that depend on that file (its paint's foreign
     COLOR_0, its map being off) come from the variant being replaced, which
     was made for it. */
  const gapArgs = (write, { seeded = false, replace = false } = {}) => {
    const was = replace && v ? v.meta.args || [] : null;
    const a = ["--material", paint];
    if (S.seams) a.push("--seams", "auto");
    if (!isOP || S.seams) a.push("--car-length-mm", String(lengthMm));
    if (!isOP) {
      /* vertex-shading carries the Maxima's shipped settings (the calibrated
         AO reach and curve from the Camry benchmark); a car that needs
         different ones takes them in Extra flags, which come last and win.
         A seeded run leaves out the ones the tool varies (AO reach,
         strength and hidden-below, the seam curve, --seam-coarse): a flag
         given is a value fixed, and the variant would only vary the rest.
         --ao-ground is on by default under --seed. */
      if (seeded) a.push("--ao-rays", "128");
      else a.push("--ao-distance", "2050", "--ao-rays", "128", "--ao-ground", "--ao-strength", "1.0", "--ao-hidden-below", "0.25");
      if (S.seams && !seeded) a.push("--curve", "0:0.45,4:0.45,8:1", "--seam-coarse", "20");
      if (S.dropForeign && (was ? was.includes("--drop-foreign-color0") : showDropForeign)) a.push("--drop-foreign-color0");
    } else {
      if (S.pocket.trim()) a.push("--pocket", S.pocket.trim());
      if (S.resetSpec) a.push("--reset-specular");
      if (S.fromMR && (was ? was.includes("--from-metal-roughness") : showMR)) a.push("--from-metal-roughness");
    }
    if (write && S.gapForce) a.push("--force");
    const extra = labParseFlags(S.gapExtra);
    a.push(...(seeded ? labStripSeed(extra) : extra));
    return a;
  };
  const gapNothing = isOP && !S.seams && !S.pocket.trim() && !S.resetSpec && !(showMR && S.fromMR);
  // occlusion-patch varies the seam curve and the pocket's padding: with neither, a seed has nothing to draw.
  const randomOk = !(isOP && !S.seams && !S.pocket.trim());
  const run = (seed, replace) => labRun(file, gapTool, [...gapArgs(true, { seeded: seed != null, replace }), ...(seed != null ? ["--seed", String(seed)] : [])], false, { opKey, replace });
  /* occlusion-patch's Check is a dry run: the whole patch and its checks in
     memory, so an unpatched map gets a real verdict instead of "no seam
     lines drawn yet". */
  const check = () => labRun(file, gapTool, isOP ? [...gapArgs(false), "--dry-run"] : gapArgs(false), true);
  const clusters = S.clusters && S.clusters.list;
  const focusCluster = (c, i) => ({ pos: labCentre(c.min, c.max), size: labSize(c.min, c.max), label: "cluster " + (i + 1) });
  return (
    <React.Fragment>
      {skinned && <LabSkinHint tool={gapTool} />}
      <label className="c3t-row"><span>Tool</span>
        <select value={gapTool} onChange={(e) => put({ gapTool: e.target.value })}>
          <option value="occlusion-patch">occlusion-patch (paint has a map){gapGuess === "occlusion-patch" ? " — suggested" : ""}</option>
          <option value="vertex-shading">vertex-shading (no map){gapGuess === "vertex-shading" ? " — suggested" : ""}</option>
        </select>
      </label>
      <label className="c3t-row"><span>Paint material</span>
        {mats.length ? (
          <select value={paint} onChange={(e) => put({ paint: e.target.value })}>
            {!paint && <option value="">choose…</option>}
            {mats.map((m) => (
              <option key={m.name} value={m.name}>{m.name}{(look.paint || []).includes(m.name) ? " ★" : ""} ({m.prims}{m.occlusion ? ", map " + m.occlusion : ""}{m.color0 ? ", COLOR_0" : ""})</option>
            ))}
          </select>
        ) : <input className="c3t-input" value={paint} onChange={(e) => put({ paint: e.target.value })} />}
      </label>
      {missingPaint.length > 0 && <p className="c3t-hint">The registry's paint {missingPaint.map((n) => "\"" + n + "\"").join(", ")} is not in this file: choose the body paint by hand, and fix look.paint in index.html.</p>}
      {paintInfo && paintInfo.occlusion === "jpeg" && <p className="c3t-hint">This paint's map is a JPEG: occlusion-patch only patches an embedded PNG.</p>}
      <label className="c3t-row"><span>Car length<output>{lengthMm} mm{S.lengthMm == null && regLen ? " (registry)" : ""}</output></span>
        <input type="range" min={3500} max={5500} step={5} value={lengthMm} onChange={(e) => put({ lengthMm: Number(e.target.value) })} />
      </label>
      {!regLen && S.lengthMm == null && <p className="c3t-hint">This car's length is unknown (no lengthMm in its registry entry): set the real bumper-to-bumper length. It scales the seam reach and the AO distance.</p>}
      <label className="c3t-opt"><input type="checkbox" checked={S.seams} onChange={(e) => put({ seams: e.target.checked })} /><span>Seams (--seams auto)</span></label>
      {showDropForeign && <label className="c3t-opt"><input type="checkbox" checked={S.dropForeign} onChange={(e) => put({ dropForeign: e.target.checked })} /><span>Drop the paint's foreign COLOR_0 (--drop-foreign-color0)</span></label>}
      {showMR && <label className="c3t-opt"><input type="checkbox" checked={S.fromMR} onChange={(e) => put({ fromMR: e.target.checked })} /><span>Map off: switch it on from metallicRoughness (--from-metal-roughness)</span></label>}
      {isOP && <label className="c3t-opt"><input type="checkbox" checked={S.resetSpec} onChange={(e) => put({ resetSpec: e.target.checked })} /><span>Reset specular (--reset-specular){paintInfo && paintInfo.specular ? " — paint has KHR_materials_specular" : ""}</span></label>}
      {isOP && (
        <LabMore S={S} file={file} id="pocket" label={"Plate pocket" + (S.pocket.trim() ? " (set)" : "") + (clusters && clusters.length ? " · " + plural(clusters.length, "dark cluster") : "")}>
          <input className="c3t-input c3t-wide" aria-label="Pocket box" value={S.pocket} onChange={(e) => put({ pocket: e.target.value })} placeholder="x0,y0,z0,x1,y1,z1 (empty = none)" />
          <div className="c3t-actions">
            {labPickBtn(S, file, "pocket", "Tap 2 corners")}
            {S.pocket && <button onClick={() => put({ pocket: "" })}>Clear</button>}
          </div>
          {S.pick && S.pick.for === "pocket" && <LabPickNote S={S} />}
          {clusters && (
            <div className="c3t-list">
              <div className="c3t-note">Dark clusters from the last check{S.clusters.key !== key ? " (older draft)" : ""}:</div>
              {clusters.length === 0 && <p className="c3t-note">none</p>}
              {clusters.map((c, i) => (
                <div key={i} className="c3t-rowline" data-focus={S.focus && S.focus.label === "cluster " + (i + 1) ? "true" : undefined}>
                  <span><button className="c3t-link" onClick={() => put({ focus: focusCluster(c, i) })}>#{i + 1}</button> {c.tris} tris, AO {Number(c.meanAO).toFixed(2)} <i>{labSize(c.min, c.max)}</i></span>
                  <button className="c3t-mini" onClick={() => put({ pocket: labBox(c.min, c.max, 0.1), focus: focusCluster(c, i) })}>use as pocket</button>
                </div>
              ))}
            </div>
          )}
        </LabMore>
      )}
      {gapNothing && <p className="c3t-note">Tick Seams, Reset specular or set a pocket: occlusion-patch has nothing to do.</p>}
      <LabMore S={S} file={file} id="gaps">
        <label className="c3t-opt"><input type="checkbox" checked={S.gapForce} onChange={(e) => put({ gapForce: e.target.checked })} /><span>Replace existing shading / write despite failed checks (--force)</span></label>
        <label className="c3t-row"><span>Extra flags</span><input className="c3t-input" value={S.gapExtra} onChange={(e) => put({ gapExtra: e.target.value })} placeholder="--curve 0:0.45,4:0.45,8:1  --no-seam-behind" /></label>
      </LabMore>
      <LabVariantActions D={D} tab="gaps" opKey={opKey} tool={gapTool} ready={!!paint && !skinned && !gapNothing} randomOk={randomOk} run={run} check={check}
        randomLabel="Random seams" calibratedLabel={isOP && !S.seams && !S.pocket.trim() ? "Apply" : "Calibrated"} />
      <LabStackNote D={D} tab="gaps" opKey={opKey} />
      <LabVariantCard D={D} tab="gaps" />
      <LabTried D={D} tab="gaps" />
      {S.focus && !S.pick && S.focus.label.startsWith("cluster") && <p className="c3t-note">Pin: {S.focus.label} (size {S.focus.size}) <button className="c3t-link" onClick={() => put({ focus: null })}>clear</button></p>}
      <LabFeedback S={S} tab="gaps" />
    </React.Fragment>
  );
}

/* ── Parts ── */
function PartsTab({ D }) {
  const { S, file, put, busy, key, last } = D;
  const strip = S.strip;
  const stripStale = strip && strip.key !== key;
  const rows = strip ? strip.rows : [];
  const CAP = 40;
  const shownRows = S.stripAll ? rows : rows.slice(0, CAP);
  const selIds = Object.keys(S.stripSel).filter((k) => S.stripSel[k]);
  const selRows = rows.filter((r) => S.stripSel[r.id]);
  const selShared = selRows.some((r) => r.nodes > 1);
  const focusOn = (label, lo, hi) => put({ focus: { pos: labCentre(lo, hi), size: labSize(lo, hi), label } });
  const del = () => {
    const list = selRows.map((r) => r.id + "  " + r.label + " (" + r.tris + " tris, " + r.material + (r.nodes > 1 ? ", all " + r.nodes + " copies" : "") + ")").join("\n");
    if (!window.confirm("Delete " + plural(selRows.length, "part") + " from the draft?\n\nUndo last (Save tab) brings them back.\n\n" + list)) return;
    labRun(file, "mesh-strip", ["--remove", selIds.join(","), ...(selShared && S.stripForce ? ["--force"] : []), ...labParseFlags(S.stripExtra)], false, { opKey: "parts-delete" });
  };
  /* A deleted plate leaves its pocket's baked shadow: Gaps lifts it, with
     the pocket box set from the part's bounds (padded 10%). */
  const liftPocket = (p) => {
    put({ gapTool: "occlusion-patch", pocket: labBox(p.lo, p.hi, 0.1), focus: { pos: labCentre(p.lo, p.hi), size: labSize(p.lo, p.hi), label: p.label }, more: { ...S.more, pocket: true },
      say: { where: "gaps", ok: true, text: "Pocket box set from " + p.id + " (padded 10%). Check runs it as a dry run first." } });
    labSetTab("gaps");
  };
  return (
    <React.Fragment>
      <div className="c3t-actions">
        <input className="c3t-input" aria-label="Filter parts" value={S.stripFilter} onChange={(e) => put({ stripFilter: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !busy) labList(file); }} placeholder="name, material or #id…" />
        <button disabled={busy} onClick={() => labList(file)}>List</button>
      </div>
      {!strip && <p className="c3t-note">List the parts{last ? " of draft " + last.n : ""}, tap a name to pin it on the car, tick and delete.</p>}
      {strip && stripStale && (
        <p className="c3t-hint">The car changed since this list (the tools now read {last ? "draft " + last.n : "the shipped file"}), so its ids may point at other parts. List again.</p>
      )}
      {strip && !stripStale && (
        <div className="c3t-list">
          <div className="c3t-note">{rows.length === 0 ? "No part matches." : (shownRows.length < rows.length ? "Showing " + shownRows.length + " of " + rows.length : plural(rows.length, "part")) + (strip.total != null && strip.total !== rows.length ? " (" + strip.total + " in the file)" : "") + ", from " + (last ? "draft " + last.n : "the shipped file") + ". Tap a name to pin it."}</div>
          {/* Ticked by the row's exact id (#mesh.prim), never its name: names
              repeat (the Camry has four "Object_0" parts, one of them the red
              seat), and mesh-strip matches a name as a substring. */}
          {shownRows.map((r, i) => (
            <div key={r.id + ":" + i} className="c3t-rowline" data-focus={S.focus && S.focus.label === r.id ? "true" : undefined}>
              <input type="checkbox" aria-label={"select " + r.id} checked={!!S.stripSel[r.id]} onChange={(e) => put((b) => ({ stripSel: { ...b.stripSel, [r.id]: e.target.checked } }))} />
              <span>
                <button className="c3t-link" disabled={!r.lo} onClick={() => r.lo && focusOn(r.id, r.lo, r.hi)}>{r.label}</button>
                {" "}<i>({r.tris} tris, {r.material}, {r.id}{r.nodes > 1 ? ", shared ×" + r.nodes : ""})</i>
                {S.focus && S.focus.label === r.id && <i className="c3t-size"> size {S.focus.size}</i>}
              </span>
            </div>
          ))}
          {shownRows.length < rows.length && <div className="c3t-actions"><button onClick={() => put({ stripAll: true })}>Show all {rows.length}</button></div>}
        </div>
      )}
      {strip && !stripStale && selShared && (
        <label className="c3t-opt"><input type="checkbox" checked={S.stripForce} onChange={(e) => put({ stripForce: e.target.checked })} /><span>Delete every copy of the shared parts (--force)</span></label>
      )}
      <LabMore S={S} file={file} id="parts">
        <label className="c3t-row"><span>Extra flags</span><input className="c3t-input" value={S.stripExtra} onChange={(e) => put({ stripExtra: e.target.value })} placeholder="--force" /></label>
      </LabMore>
      {strip && !stripStale && (
        <div className="c3t-actions c3t-main">
          <button className="c3t-primary" disabled={busy || !selIds.length || (selShared && !S.stripForce)} onClick={del}>Delete ticked{selIds.length ? " (" + selIds.length + ")" : ""}</button>
        </div>
      )}
      {S.removed && S.removed.length > 0 && (
        <div className="c3t-list">
          <div className="c3t-note">Deleted. A plate that sat in a body pocket leaves its baked shadow behind:</div>
          {S.removed.map((p) => (
            <div key={p.id} className="c3t-rowline">
              <span>{p.label} <i>({p.id}, {labSize(p.lo, p.hi)})</i></span>
              <button className="c3t-mini" onClick={() => liftPocket(p)}>Lift pocket under it</button>
            </div>
          ))}
        </div>
      )}
      {S.focus && !S.pick && !S.focus.label.startsWith("cluster") && <p className="c3t-note">Pin: {S.focus.label} (size {S.focus.size}) <button className="c3t-link" onClick={() => put({ focus: null })}>clear</button></p>}
      <LabFeedback S={S} tab="parts" />
    </React.Fragment>
  );
}

/* ── Save ── */
function SaveTab({ D }) {
  const { S, file, put, st, drafts, last, busy, missingLook, previewN, cabin, covered, reg, look } = D;
  const regInterior = (reg && reg.slots && reg.slots.interior) || look.interior || [];
  const msg = S.msgs.save;
  return (
    <React.Fragment>
      <div className="c3t-kv"><span>{file}</span><output>{mb(st && st.bytes)}</output></div>
      <div className="c3t-kv c3t-dim"><span>Original backup</span><output>{st && st.original ? mb(st.original.bytes) : "not yet"}</output></div>
      {!st && <p className="c3t-msg">The lab server has no assets/{file}.</p>}
      <div className="c3t-group">Drafts</div>
      {st && drafts.length === 0 && <p className="c3t-note">No edits yet: the tools read the shipped file.</p>}
      {st && drafts.length > 0 && (
        <div className="c3t-drafts" role="radiogroup" aria-label="Show on the car">
          <label className="c3t-opt"><input type="radio" name={"c3t-prev-" + file} checked={previewN == null} onChange={() => labShowDraft(file, st, null)} /><span>shipped file</span><output>{mb(st.bytes)}</output></label>
          {drafts.map((d) => {
            const vr = d.meta && d.meta.variation;
            const brief = labVariantBrief(d.tool, vr && { ...vr, label: typeof vr.label === "string" ? vr.label : null });
            return (
              <label key={d.n} className="c3t-opt c3t-draft"><input type="radio" name={"c3t-prev-" + file} checked={previewN === d.n} onChange={() => labShowDraft(file, st, d.n)} />
                <span>{d.n}. {labDraftWhat(d)}{brief && <i>{brief}</i>}</span>
                <output>{mb(d.bytes)}</output></label>
            );
          })}
          {previewN != null && previewN !== last.n && <p className="c3t-note c3t-tip">Showing draft {previewN}; the tools still read draft {last.n}. Undo last drops the newest.</p>}
          <div className="c3t-actions">
            <button disabled={busy} onClick={() => labUndo(file)}>Undo last (drop {last.n})</button>
            <button disabled={busy} onClick={() => labDiscard(file)}>Discard all</button>
          </div>
        </div>
      )}
      <div className="c3t-group">Site</div>
      {missingLook.length > 0 && last && <p className="c3t-hint">The car's look in index.html names {missingLook.map((n) => "\"" + n + "\"").join(", ")}, which draft {last.n} does not have. Save will ask before shipping that.</p>}
      {cabin && last && !regInterior.includes(cabin) && <p className="c3t-note">Save adds {cabin} to this car's interior slot in index.html.</p>}
      {covered.length > 0 && last && <p className="c3t-note">{covered.map((n) => "\"" + n + "\"").join(", ")}: merged into the black cabin, so not in draft {last.n}. Save does not mind, and keeps {covered.length > 1 ? "them" : "it"} in the look for a Restore.</p>}
      <div className="c3t-actions c3t-main">
        <button className="c3t-primary" disabled={busy || !last} onClick={() => labInstall(file, "save")}>{S.op === "save" ? "Saving…" : last ? "Save draft " + last.n + " to site" : "Save to site"}</button>
      </div>
      {st && (st.original || (st.history || []).length > 0) && (
        <div className="c3t-actions">
          <select aria-label="Backup to restore" value={S.restoreFrom} onChange={(e) => put({ restoreFrom: e.target.value })}>
            {st.original && <option value="original">original ({mb(st.original.bytes)})</option>}
            {(st.history || []).map((h) => <option key={h.name} value={h.name}>{labHistLabel(st, h.name)} ({mb(h.bytes)})</option>)}
          </select>
          <button disabled={busy} onClick={() => labInstall(file, "restore")}>{S.op === "restore" ? "Restoring…" : "Restore"}</button>
        </div>
      )}
      {msg && <LabMsg msg={msg} />}
      {msg && msg.reload && <div className="c3t-actions"><button onClick={() => window.location.reload()}>Reload page</button></div>}
    </React.Fragment>
  );
}

/* ── the build host ─────────────────────────────────────────────────────────
   Mounted once a build tab is first opened, and kept mounted (rendering
   nothing) while the panel is collapsed or on Motion: its tap-to-pick
   listener and its pin must keep working with the panel out of the way --
   on a phone the open panel covers the whole car. */
function BuildHost({ car, viewerRef, tab, visible }) {
  useLabUi();
  const file = fileOfSrc(car && car.model && car.model.src);
  const S = labBag(file);
  const pinRef = useRef(null);

  useEffect(() => { labRefresh(file); }, [file]);

  /* Tap-to-pick. Capture phase on window, so it runs before React's root
     listener and the stage never starts a rotate for this press. Works with
     the panel collapsed: on a phone that is the only way to see the car. */
  useEffect(() => {
    const pick = S.pick;
    if (!pick) return;
    const mv = viewerRef && viewerRef.current;
    if (!mv) return;
    // The press that picks also produces a click; swallow that one click too.
    const swallowClick = (e) => { e.stopPropagation(); e.preventDefault(); window.removeEventListener("click", swallowClick, true); };
    const onDown = (e) => {
      if (e.target.closest && e.target.closest(".c3t")) return; // the panel's own buttons
      const r = mv.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.stopPropagation(); e.preventDefault();
      window.addEventListener("click", swallowClick, true);
      const hit = labHit(mv, e.clientX, e.clientY);
      const where = pick.for === "pocket" ? "gaps" : "seat";
      if (!hit) { labPut(file, { say: { where, text: "that tap missed the car — try again" } }); return; }
      const cur = labBag(file).pick;
      if (!cur) return;
      if (cur.for === "seat") { labPut(file, { picked: hit, pick: null, focus: null, say: { where, text: null } }); return; }
      if (!cur.a) { labPut(file, { pick: { ...cur, a: labVec(hit.pos) }, say: { where, text: null } }); return; }
      // Second corner: the box spans both taps, padded a little (see labBox).
      const box = labBox(cur.a, labVec(hit.pos), cur.for === "pocket" ? 0.1 : 0.05);
      labPut(file, cur.for === "pocket" ? { pocket: box, pick: null } : { seatBox: box, pick: null });
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("click", swallowClick, true); };
  }, [S.pick]);

  /* A red pin, as a slotted hotspot: model-viewer keeps any element whose
     slot starts with "hotspot" pinned to data-position, centred on it, and
     React leaves a child it did not create alone. It marks, in order: the
     first corner of a two-tap box, a listed part or cluster, the picked seat
     point. */
  const pin = S.pick && S.pick.a ? { pos: { x: S.pick.a[0], y: S.pick.a[1], z: S.pick.a[2] }, kind: "corner" }
    : S.focus ? { pos: S.focus.pos, kind: "focus" }
    : S.picked ? { pos: S.picked.pos, normal: S.picked.normal, kind: "seat" } : null;
  const pinKey = pin ? pin.kind + fmtPt(pin.pos) : "";
  useEffect(() => {
    const mv = viewerRef && viewerRef.current;
    if (pinRef.current) { pinRef.current.remove(); pinRef.current = null; }
    if (!mv || !pin) return;
    const el = document.createElement("div");
    el.className = "c3t-pin";
    el.dataset.kind = pin.kind;
    el.setAttribute("slot", "hotspot-lab-pick");
    el.setAttribute("data-position", `${pin.pos.x}m ${pin.pos.y}m ${pin.pos.z}m`);
    if (pin.normal) el.setAttribute("data-normal", `${pin.normal.x}m ${pin.normal.y}m ${pin.normal.z}m`);
    mv.appendChild(el);
    pinRef.current = el;
    return () => { el.remove(); };
  }, [pinKey]);

  if (!visible) return null;
  const retry = () => { labServer.state = "checking"; labUiNotify(); labRefresh(file); };
  if (labServer.state === "checking") return <div className="c3t-body"><p className="c3t-note">Looking for the lab server…</p></div>;
  if (labServer.state !== "ok") return <LabMissing onRetry={retry} />;
  const D = labDerive(car, file);
  const Tab = { export: ExportTab, seat: SeatTab, cabin: CabinTab, gaps: GapsTab, parts: PartsTab, save: SaveTab }[tab] || SaveTab;
  return <div className="c3t-body" data-tab-body={tab}><Tab D={D} /></div>;
}

/* The panel itself. Rendered by CarStage3D while the screen is open, through a
   portal to <body> — the stage has transformed ancestors, which would pin a
   position: fixed box to them instead of the viewport, and .car-swipe's
   touch-action: none would swallow the slider drags. The portal only moves
   the DOM, though: React still bubbles synthetic events up the component tree
   to .car-swipe's onPointerDown, which would read a slider drag as a rotate.
   Stopping pointerdown at the panel is what keeps the two apart.
   Motion dials replay the handover on release, and only when the value really
   changed — a Tab onto a slider, or a click that leaves it where it was, is
   not a change. Shadow dials apply live.
   Open/collapsed is kept in car3dTunerOpen, and the tab in car3dTunerTab,
   outside the component, because the panel unmounts each time the screen
   closes and would otherwise reopen expanded, on Motion, every time. Each
   tab keeps its own scroll position (car3dTunerScroll), so going back to a
   long part list finds it where it was. The head, the tabs and the strip
   sit above the scroller (.c3t-scroll), so they stay put while a tab
   scrolls -- position: sticky inside the blurred panel was painted scrolled
   away by Chromium now and then, though its layout said otherwise. The build host's state is per
   car outside React (labBag), so closing the screen loses nothing either. A
   different car turns the draft preview off; the same car coming back keeps
   it. */
let car3dTunerOpen = true;
let car3dBuildMounted = false;
const car3dTunerScroll = {};
function Car3DTuner({ car, viewerRef }) {
  const t = useCar3dTune();
  useLabUi();
  const file = fileOfSrc(car && car.model && car.model.src);
  useEffect(() => { if (labPreview && labPreview.file !== file) setLabPreview(null); }, [file]);
  const [open, setOpenState] = useState(car3dTunerOpen);
  const setOpen = (fn) => setOpenState((o) => (car3dTunerOpen = fn(o)));
  const tab = car3dTunerTab;
  const build = tab !== "motion";
  const panelRef = useRef(null);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (el && open) el.scrollTop = car3dTunerScroll[tab] || 0;
  }, [tab, open]);
  const onScroll = (e) => { if (open) car3dTunerScroll[tab] = e.currentTarget.scrollTop; };
  const [autoReplay, setAutoReplay] = useState(true);
  const [copied, setCopied] = useState(false);
  /* On a phone the panel covers half the car, so it goes see-through for the
     length of each replay — the cube's hold and fade, the car's delay and its
     whole arrival — and comes back once there is nothing left to watch. */
  const [watching, setWatching] = useState(false);
  const watchRef = useRef(0);
  useEffect(() => () => clearTimeout(watchRef.current), []);
  // The motion values the last replay used; a release that matches is no change.
  const playedRef = useRef(null);
  if (!playedRef.current) playedRef.current = car3dTuneValues();
  const replay = () => {
    playedRef.current = car3dTuneValues();
    setCar3dTune({ replay: car3dTune.replay + 1 });
    setWatching(true);
    clearTimeout(watchRef.current);
    const t = car3dTune;
    watchRef.current = setTimeout(() => setWatching(false),
      CAR3D_TUNE_REPLAY_HOLD_MS + Math.max(t.cubeFadeMs, t.revealLagMs) + t.arriveMs + 250);
  };
  const commit = (d) => {
    if (d.motion && autoReplay && car3dTune[d.key] !== playedRef.current[d.key]) replay();
  };
  const copy = () => {
    const text = JSON.stringify(car3dTuneValues(), null, 2);
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1400); };
    try { navigator.clipboard.writeText(text).then(done, () => window.prompt("Copy these values:", text)); }
    catch (e) { window.prompt("Copy these values:", text); }
  };
  const fmt = (d, v) => (d.step < 1 ? Number(v).toFixed(2) : String(v)) + (d.unit || "");
  const stop = (e) => e.stopPropagation();
  if (open && build) car3dBuildMounted = true;
  const S = labBag(file);
  const runningTab = Object.keys(S.jobs).find((k) => S.jobs[k] && S.jobs[k].state === "running");
  return ReactDOM.createPortal(
    <div className="c3t" data-open={open ? "true" : "false"} data-tab={tab} data-watching={watching ? "true" : "false"} dir="ltr" onPointerDown={stop} onClick={stop}>
      <div className="c3t-top">
        <div className="c3t-head">
          <button className="c3t-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "▾ Car lab" : "▸ Lab"}
            {!open && S.pick ? <span className="c3t-pilltip"> · tap the car</span> : null}
            {!open && runningTab ? <span className="c3t-pilltip"> · running</span> : null}
            {!open && labPreview && labPreview.file === file ? <span className="c3t-pilltip"> · draft {labPreview.n}</span> : null}
          </button>
          {open && tab === "motion" && <button className="c3t-replay" onClick={replay}>Replay</button>}
        </div>
        {open && (
          <div className="c3t-tabs" role="tablist" aria-label="Car lab">
            {LAB_TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} data-busy={runningTab === id ? "true" : undefined} onClick={() => labSetTab(id)}>{label}</button>
            ))}
          </div>
        )}
        {open && build && <LabStrip car={car} file={file} tab={tab} />}
      </div>
      <div className="c3t-scroll" ref={panelRef} onScroll={onScroll}>
      {car3dBuildMounted && <BuildHost key={file} car={car} viewerRef={viewerRef} tab={tab} visible={open && build} />}
      {open && tab === "motion" && (
        <div className="c3t-body">
          {CAR3D_DIALS.map((d) => d.group ? (
            <div className="c3t-group" key={d.group}>{d.group}</div>
          ) : d.options ? (
            <label className="c3t-row" key={d.key}>
              <span>{d.label}</span>
              <select value={t[d.key]} onChange={(e) => { setCar3dTune({ [d.key]: e.target.value }); commit(d); }}>
                {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          ) : (
            <label className="c3t-row" key={d.key}>
              <span>{d.label}<output>{fmt(d, t[d.key])}</output></span>
              <input
                type="range" min={d.min} max={d.max} step={d.step} value={t[d.key]}
                onChange={(e) => setCar3dTune({ [d.key]: Number(e.target.value) })}
                onPointerUp={() => commit(d)}
                onKeyUp={() => commit(d)}
              />
            </label>
          ))}
          <label className="c3t-auto">
            <input type="checkbox" checked={autoReplay} onChange={(e) => setAutoReplay(e.target.checked)} />
            Replay after each motion change
          </label>
          <div className="c3t-actions">
            <button onClick={() => { setCar3dTune({ ...CAR3D_TUNE_DEFAULTS }); replay(); }}>Reset</button>
            <button onClick={copy}>{copied ? "Copied" : "Copy values"}</button>
          </div>
        </div>
      )}
      </div>
    </div>,
    document.body
  );
}

/* The panel's styles. Injected from here, not kept in index.html, so the
   production stylesheet carries nothing for a tool it never loads. */
{
  const el = document.createElement("style");
  el.id = "car3d-lab-panel-css";
  el.textContent = `
/* ?tune=1's dial panel (Car3DTuner) — a developer tool, never shown without
   the flag. Top-left, just UNDER the car bar: at the very top it sat over
   the bar's cart button (the page is RTL, so the cart is the bar's leftmost
   item). Collapsible to a small pill. Its own
   scroll (pan-y) so a short phone can reach every dial; it sits in <body>,
   outside .car-swipe's touch-action: none, so the sliders drag natively. */
.c3t {
  position: fixed; z-index: 2000;
  top: calc(68px + env(safe-area-inset-top, 0px)); left: 8px;
  /* Ends above the parts sheet's 76px peek (plus 8px), so the panel never
     sits over the sheet's handle. */
  width: 240px; max-height: calc(100dvh - 68px - 76px - 8px - env(safe-area-inset-top, 0px));
  display: flex; flex-direction: column; overflow: hidden;
  touch-action: pan-y;
  padding: 6px 0 0;
  background: rgba(255, 255, 255, 0.95);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid var(--hairline); border-radius: 12px;
  box-shadow: var(--shadow-sm);
  font: 11.5px/1.3 system-ui, -apple-system, sans-serif; color: var(--text);
  text-align: left;
  transition: opacity 0.2s ease;
}
/* See-through while a replay plays (Car3DTuner's 'watching'); still
   tappable, so a dial can be grabbed straight away. */
.c3t[data-watching="true"] { opacity: 0.12; }
.c3t[data-open="false"] { width: auto; padding: 0 6px; }
.c3t-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.c3t-toggle {
  font: inherit; font-weight: 700; color: var(--text);
  background: none; border: 0; padding: 6px 0; cursor: pointer;
}
.c3t button { -webkit-tap-highlight-color: transparent; }
.c3t-replay, .c3t-actions button {
  font: inherit; font-weight: 600; cursor: pointer;
  padding: 5px 8px; border-radius: 8px;
  border: 1px solid var(--hairline); background: var(--white); color: var(--text);
}
.c3t-replay { background: var(--red); border-color: var(--red); color: #fff; }
.c3t-group {
  margin: 12px 0 2px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted);
}
.c3t-row { display: block; margin-top: 7px; }
.c3t-row > span { display: flex; justify-content: space-between; gap: 8px; }
.c3t-row output { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.c3t-row input[type="range"] { display: block; width: 100%; margin: 3px 0 0; accent-color: var(--red); }
.c3t-row select { display: block; width: 100%; margin-top: 3px; font: inherit; }
.c3t-auto { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--muted); }
.c3t-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
/* One width for every tab (the build tabs' rows carry file names, sizes and
   tool output): a panel that resized with its tab was one more thing moving. */
.c3t[data-open="true"] { width: min(300px, calc(100vw - 16px)); }
/* The head, the tabs and the strip stay put; the tab's body scrolls under
   them, with its own scroll (pan-y, so a short phone reaches every dial). A
   thin scrollbar, its gutter always kept: a tab that grows a scrollbar (a
   job result, a long list) does not shift its own content sideways. */
.c3t-top { flex: none; padding: 0 10px; }
.c3t-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; touch-action: pan-y; padding: 0 10px 10px; scrollbar-width: thin; scrollbar-gutter: stable; }
.c3t[data-open="false"] .c3t-top { padding: 0; }
.c3t[data-open="false"] .c3t-scroll { display: none; }
/* Seven short tabs on one underlined row: each shrinks to its label, so the
   row fits the 300px panel with room to spare (and a 250px one); the chosen
   one gets the page's red underline. */
.c3t-tabs { display: flex; border-bottom: 1px solid var(--hairline); }
.c3t-tabs button {
  flex: 1 1 auto; min-width: 0; position: relative; white-space: nowrap;
  font: inherit; font-weight: 600; cursor: pointer; padding: 6px 1px 5px; margin-bottom: -1px;
  border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted);
}
.c3t-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--red); }
/* A tab whose job is running. */
.c3t-tabs button[data-busy="true"]::after { content: ""; position: absolute; top: 4px; right: 1px; width: 5px; height: 5px; border-radius: 50%; background: #d97706; }
.c3t-actions button:disabled { opacity: 0.45; cursor: default; }
.c3t-actions .c3t-primary { background: var(--text); border-color: var(--text); color: #fff; }
.c3t-actions .c3t-on { border-color: var(--red); color: var(--red); }
.c3t-actions select, .c3t-input { font: inherit; padding: 4px 6px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--white); color: var(--text); min-width: 0; flex: 1; }
.c3t-row .c3t-input { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; }
.c3t-kv { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; }
.c3t-kv span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c3t-kv output { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.c3t-note { margin: 6px 0 0; color: var(--muted); }
.c3t-note code, .c3t-code { font: 10.5px/1.35 ui-monospace, Consolas, monospace; }
/* The log keeps its columns (mesh-strip's report is a table): no wrapping,
   no break-all through a number; it scrolls sideways instead. */
.c3t-code { margin: 6px 0 0; padding: 6px; background: #f4f4f5; border-radius: 6px; white-space: pre; overflow-x: auto; }
.c3t-msg { margin: 8px 0 0; padding: 6px 8px; border-radius: 6px; background: #fff7ed; color: #9a3412; overflow-wrap: anywhere; }
.c3t-log { margin-top: 6px; }
.c3t-log summary { cursor: pointer; color: var(--muted); font-size: 10.5px; }
.c3t-passed { margin-top: 3px; }
.c3t-ok { color: #15803d; }
.c3t-msg[data-ok="true"] { background: #f0fdf4; color: #166534; }
.c3t-msg[data-ok="info"] { background: #f4f4f5; color: var(--text); }
.c3t-hint { margin: 6px 0 0; padding: 5px 7px; border-radius: 6px; background: #fefce8; color: #854d0e; overflow-wrap: anywhere; }
.c3t-tip { color: var(--red); }
.c3t-dim { color: var(--muted); }
.c3t-fact { margin-top: 3px; font-size: 10.5px; overflow-wrap: anywhere; }
.c3t-sub { margin-top: 10px; font-weight: 600; color: var(--muted); }
.c3t-opt { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; color: var(--text); }
.c3t-opt input { margin: 1px 0 0; flex: none; }
.c3t-opt span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.c3t-opt output { color: var(--muted); font-variant-numeric: tabular-nums; }
.c3t-wide { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; }
.c3t-hints label { display: flex; align-items: center; gap: 4px; color: var(--muted); }
.c3t-hints select { flex: none; }
.c3t-ol { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
.c3t-ol li { margin-top: 4px; }
.c3t-rowline { display: flex; align-items: flex-start; gap: 6px; margin-top: 4px; }
.c3t-rowline > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.c3t-rowline[data-focus="true"] > span { color: var(--red); }
.c3t-link { font: inherit; padding: 0; border: 0; background: none; color: inherit; text-decoration: underline dotted; cursor: pointer; text-align: left; }
.c3t-link:disabled { text-decoration: none; cursor: default; }
.c3t-mini { font: inherit; font-size: 10.5px; padding: 2px 6px; border-radius: 6px; border: 1px solid var(--hairline); background: var(--white); color: var(--text); cursor: pointer; flex: none; }
.c3t-size { color: var(--red) !important; }
.c3t-pilltip { font-weight: 600; color: var(--red); }
.c3t-job { margin-top: 10px; padding: 6px 8px; border: 1px solid var(--hairline); border-radius: 8px; }
.c3t-job[data-state="failed"] { border-color: var(--red); }
.c3t-check { margin-top: 3px; font-size: 10.5px; }
.c3t-check[data-pass="true"] { color: #15803d; }
.c3t-check[data-pass="false"] { color: var(--red); }
.c3t-check[data-pass="warn"] { color: #a16207; }
.c3t-list { max-height: 220px; overflow-y: auto; margin-top: 4px; }
.c3t-list .c3t-auto { margin-top: 4px; align-items: flex-start; }
.c3t-list i { color: var(--muted); font-style: normal; }
/* The picked point on the car: a slotted model-viewer hotspot. No translate:
   model-viewer already centres a slotted hotspot on its point (a -50% shift
   drew it 7px up and left of the tap). A listed part or cluster gets a
   ring, a box corner a square. */
.c3t-pin { width: 14px; height: 14px; border-radius: 50%; background: var(--red); border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.3); pointer-events: none; }
.c3t-pin[data-kind="focus"] { background: transparent; border: 3px solid var(--red); box-shadow: 0 0 0 2px #fff; width: 18px; height: 18px; }
.c3t-pin[data-kind="corner"] { border-radius: 2px; }
/* The strip under the tabs: one quiet line -- a status dot, what the tools
   read (or what is running), and which file the car shows. */
.c3t-strip { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 10.5px; color: var(--muted); border-bottom: 1px solid var(--hairline); }
.c3t-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #16a34a; }
.c3t-strip[data-state="busy"] .c3t-dot, .c3t-strip[data-state="wait"] .c3t-dot { background: #d97706; }
.c3t-strip[data-state="off"] .c3t-dot { background: var(--red); }
@media (prefers-reduced-motion: no-preference) {
  .c3t-strip[data-state="busy"] .c3t-dot { animation: c3tPulse 0.9s ease-in-out infinite alternate; }
}
@keyframes c3tPulse { to { opacity: 0.25; } }
.c3t-striptext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.c3t-strip[data-state="busy"] .c3t-striptext { color: var(--text); }
.c3t-show { flex: none; display: flex; align-items: center; gap: 4px; }
.c3t-show select { font: inherit; color: var(--text); padding: 1px 2px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--white); }
.c3t-show[data-old="true"] select { color: var(--red); border-color: var(--red); }
/* The tab's main row: a little air above it. */
.c3t-actions.c3t-main { margin-top: 10px; }
/* How Seat finds the seat. */
.c3t-seg { display: flex; margin-top: 8px; border: 1px solid var(--hairline); border-radius: 8px; overflow: hidden; }
.c3t-seg button { flex: 1; font: inherit; font-weight: 600; padding: 5px 0; border: 0; border-left: 1px solid var(--hairline); background: var(--white); color: var(--muted); cursor: pointer; }
.c3t-seg button:first-child { border-left: 0; }
.c3t-seg button[aria-checked="true"] { background: #f1f1f3; color: var(--text); }
/* "More options": folded flags. */
.c3t-more { margin-top: 8px; }
.c3t-morehead { font: inherit; font-size: 10.5px; color: var(--muted); background: none; border: 0; padding: 2px 0; cursor: pointer; text-align: left; }
.c3t-morebody { margin-top: 2px; padding: 0 0 2px 9px; border-left: 2px solid var(--hairline); }
/* The variant on the car, and the seeds tried. */
.c3t-variant { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: #f6f6f7; }
.c3t-variant .c3t-kv { margin-top: 0; font-weight: 600; }
.c3t-params { display: flex; flex-wrap: wrap; gap: 1px 10px; margin-top: 3px; font-size: 10.5px; color: var(--muted); }
.c3t-params b { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.c3t-tried { margin-top: 8px; }
.c3t-tried .c3t-sub { margin: 0 0 2px; }
.c3t-try { display: flex; align-items: baseline; gap: 8px; width: 100%; margin-top: 1px; padding: 3px 6px; font: inherit; font-size: 10.5px; text-align: left; border: 0; border-radius: 6px; background: none; color: var(--text); cursor: pointer; }
.c3t-try:hover:not(:disabled) { background: #f4f4f5; }
.c3t-try:disabled { cursor: default; }
.c3t-try[data-on="true"] { background: #f4f4f5; box-shadow: inset 2px 0 0 var(--red); }
.c3t-try[data-ok="false"] { color: var(--muted); }
.c3t-tryseed { flex: none; font: 10.5px/1.3 ui-monospace, Consolas, monospace; }
.c3t-trywhat { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
/* Cabin: the --keep picker (a short scrolling list of ticks, sizes on the
   right) and the result card's lines. */
.c3t-keep { max-height: 150px; margin-top: 2px; }
.c3t-keep .c3t-opt { margin-top: 3px; }
.c3t-cabincard .c3t-fact { margin-top: 2px; }
.c3t-mlist { margin-top: 4px; font-size: 10.5px; }
.c3t-mrow { display: flex; align-items: baseline; gap: 8px; margin-top: 1px; }
.c3t-mrow span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.c3t-mrow span i { font-style: normal; color: var(--muted); }
.c3t-mrow output { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
/* The Save tab's drafts: the seed's drawn values under each. */
.c3t-draft span i { display: block; font-style: normal; font-size: 10.5px; color: var(--muted); overflow-wrap: anywhere; }
`;
  document.head.appendChild(el);
}

window.car3dLab = {
  values: car3dTune,
  subscribe(fn) { car3dTuneSubs.add(fn); return () => { car3dTuneSubs.delete(fn); }; },
  revealLagMs,
  loaderFadeMs,
  hotspotStaggerMs,
  applyMotionCss: car3dApplyTuneCss,
  REPLAY_HOLD_MS: CAR3D_TUNE_REPLAY_HOLD_MS,
  srcFor,
  carFor,
  previewing: () => !!labPreview,
  Panel: Car3DTuner,
};
})();
