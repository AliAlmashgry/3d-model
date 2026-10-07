/* Command line and result plumbing shared by occlusion-patch and
   vertex-shading.

   Strict flags: an unknown flag is an error, not ignored. The old parsers took
   any "--name value" pair, so a typo (--seam-behnd) or a retired name
   (--seam-sideways, the unsigned guard that doubled every Maxima seam) was
   silently dropped and the tool shipped a file built without it. A retired
   flag now fails with the reason it was retired.

   LabRun collects what the lab server needs (see lib/gltf-io.mjs's
   printLabJson): summary, checks, warnings. finish() prints the LAB_JSON line
   last when --json is given and sets the exit code; a failed check makes the
   run fail (exit 3) and the tool must not have written, unless --force.
   Read-only modes (--report, occlusion-patch's --dry-run) run the same
   checks and finish ok with them listed: they are the verdict, not a
   refusal, since nothing is written either way.

   Also here: the skinned-export refusal both tools share (isSkinned). */
import { printLabJson, fileSize } from "./gltf-io.mjs";

export class UsageError extends Error {}

/* spec: { bool: [names], value: [names], negatable: [names that also take
   --no-<name>], retired: { name: "why" } }. Returns { flags, positional };
   a negatable flag reads true/false/undefined. */
export function parseArgs(argv, spec) {
  const bool = new Set(spec.bool || []), value = new Set(spec.value || []), neg = new Set(spec.negatable || []);
  const retired = spec.retired || {};
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    let key = a.slice(2), inline = null;
    const eq = key.indexOf("=");
    if (eq > 0) { inline = key.slice(eq + 1); key = key.slice(0, eq); }
    if (retired[key]) throw new UsageError("--" + key + " is retired: " + retired[key]);
    if (key.startsWith("no-") && neg.has(key.slice(3))) { flags[key.slice(3)] = false; continue; }
    if (bool.has(key) || neg.has(key)) { flags[key] = true; continue; }
    if (value.has(key)) {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined || (inline === null && v.startsWith("--") && !/^--?\d/.test(v))) throw new UsageError("--" + key + " needs a value");
      flags[key] = v;
      continue;
    }
    throw new UsageError("unknown flag --" + key);
  }
  return { flags, positional };
}

export function parseCurve(s, example) {
  const pts = s.split(",").map((p) => p.split(":").map(Number));
  if (pts.length < 2 || pts.some((p) => p.length !== 2 || p.some((n) => Number.isNaN(n))) || pts.some((p, i) => i && p[0] <= pts[i - 1][0])) {
    throw new UsageError("--curve wants increasing mm:factor pairs, e.g. " + example);
  }
  return pts;
}
/* Piecewise linear in mm, 1 beyond the last point. */
export function curveAt(curve, dmm) {
  const reach = curve[curve.length - 1][0];
  if (!(dmm < reach)) return 1;
  for (let i = 1; i < curve.length; i++) {
    const [d0, f0] = curve[i - 1], [d1, f1] = curve[i];
    if (dmm <= d1) return f0 + ((f1 - f0) * (dmm - d0)) / (d1 - d0);
  }
  return 1;
}

/* A skinned export is refused by both shading tools (and by seat-split).
   Both read every vertex through getWorldMatrix(), which is the node's own
   transform: a skinned mesh is drawn through its JOINTS instead, so a
   Sketchfab rig (a Z-up -> Y-up rotation on the joint, an identity skin)
   lies on its side in the tools' space while it stands upright on the page.
   AO would be traced against the wrong ground, --car-length-mm would take the
   car's HEIGHT as its length, and every --pocket box (read off the page)
   would miss. export-fix --unskin bakes an identity skin into the nodes;
   the recipe runs it first. Skinned = the file lists a skin AND some
   primitive carries JOINTS_0 (a skin nothing draws through changes nothing).
   Takes a gltf-transform Document or the raw glTF JSON (occlusion-patch
   reads the container itself). */
export const SKINNED_ERROR = "skinned export: run Export fixes → --unskin first (export-fix --unskin bakes the identity skin into the nodes; a skinned car lies on its side in this tool's space)";
export function isSkinned(docOrJson) {
  if (docOrJson && typeof docOrJson.getRoot === "function") {
    const root = docOrJson.getRoot();
    return root.listSkins().length > 0 && root.listMeshes().some((m) => m.listPrimitives().some((p) => !!p.getAttribute("JOINTS_0")));
  }
  const j = docOrJson || {};
  return !!(j.skins && j.skins.length) && (j.meshes || []).some((m) => (m.primitives || []).some((p) => p.attributes && p.attributes.JOINTS_0 !== undefined));
}

export class LabRun {
  constructor(tool, json) {
    this.tool = tool; this.json = !!json;
    this.input = null; this.output = null; this.bytesIn = null; this.bytesOut = null;
    this.summary = {}; this.checks = []; this.warnings = [];
    this.t0 = Date.now();
    this._held = null; // set while collect() runs: what it holds back
  }
  log(msg) { if (this._held) this._held.lines.push(msg); else console.log(msg); }
  warn(msg) { if (this._held) { this._held.warnings.push(msg); return; } this.warnings.push(msg); console.warn("warning: " + msg); }
  check(name, pass, detail) {
    this.checks.push({ name, pass: !!pass, detail });
    this.log("  check " + (pass ? "PASS" : "FAIL") + "  " + name + "  " + detail);
    return pass;
  }
  get failed() { return this.checks.filter((c) => !c.pass); }
  /* A --seed attempt (lib/variation.mjs) runs the same code a plain run does,
     inside collect(): its checks, log lines and warnings are held back
     instead of printed or added to the result, and come back as
     { checks, lines, warnings, failed }. Only the variant that is written
     reaches the result, through replay(); the rejected ones print one line
     each (the variation runner's). */
  async collect(fn) {
    const saved = this.checks, savedHeld = this._held;
    const held = { checks: [], lines: [], warnings: [] };
    this.checks = held.checks; this._held = held;
    let value;
    try { value = await fn(); } finally { this.checks = saved; this._held = savedHeld; }
    return { value, checks: held.checks, lines: held.lines, warnings: held.warnings, failed: held.checks.filter((c) => !c.pass).map((c) => c.name) };
  }
  /* Prints and records what collect() held back, in its original order
     (check lines sit among the log lines where they were made). */
  replay(held) {
    for (const line of held.lines) console.log(line);
    for (const c of held.checks) this.checks.push(c);
    for (const w of held.warnings) this.warn(w);
  }
  result(ok, error) {
    return { ok, tool: this.tool, input: this.input, output: this.output, bytesIn: this.bytesIn, bytesOut: this.bytesOut,
      summary: { ...this.summary, seconds: +((Date.now() - this.t0) / 1000).toFixed(1) }, checks: this.checks, warnings: this.warnings, error: error || null };
  }
  /* Ends the run. ok=false with an error message exits `code` (default 1). */
  finish(ok = true, error = null, code = null) {
    if (this.output) this.bytesOut = fileSize(this.output);
    if (ok && this.bytesIn && this.bytesOut) console.log("bytes " + this.bytesIn + " -> " + this.bytesOut + " (" + fmtDelta(this.bytesOut - this.bytesIn) + ")");
    if (error) console.error(this.tool + ": " + error);
    if (this.json) printLabJson(this.result(ok, error));
    process.exit(ok ? 0 : code || 1);
  }
}
export const fmtDelta = (d) => (d >= 0 ? "+" : "") + (Math.abs(d) >= 1e5 ? (d / 1e6).toFixed(2) + " MB" : (d / 1e3).toFixed(1) + " KB");

/* Runs main(run) and turns any throw into a clean failure: exit 2 with the
   usage for a UsageError, 1 otherwise, and the LAB_JSON line either way. */
export async function runTool(tool, usage, main) {
  const run = new LabRun(tool, process.argv.includes("--json"));
  try {
    await main(run);
    // finish() exits, so reaching here means a path forgot it: still answer
    // the lab with a result line rather than ending silently.
    run.finish(false, "ended without a result (a bug in " + tool + ")", 1);
  } catch (e) {
    if (e instanceof UsageError) { console.error(usage); run.finish(false, e.message, 2); }
    if (process.env.SHADE_DEBUG) console.error(e && e.stack);
    run.finish(false, e && e.stack ? String(e.message) : String(e), 1);
  }
}
