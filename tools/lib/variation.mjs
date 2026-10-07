/* Seeded variation for the lab's "Random cut" / "Random seams" buttons:
   a tool given --seed <uint32> draws its tunable parameters from a seeded
   PRNG instead of using its calibrated defaults, tries again with a new
   draw while its own self-checks fail, and writes the first variant that
   passes them. Used by vertex-shading, occlusion-patch and seat-split; kept
   free of any one tool's types so all three share it.

   The contract every caller keeps:
     - Without --seed nothing here runs: the tool takes its usual, calibrated
       path and writes what it always wrote (the CLI recipe and the shipped
       settings do not change).
     - A parameter the caller set with an explicit flag is FIXED: it is
       passed as `fixed` and comes back unchanged. Its draw is still
       consumed, so fixing one parameter never shifts the values the others
       get from the same seed.
     - Ranges are the caller's, bounded around its calibrated values, and
       documented where they are drawn. The hard safety gates (a seat's
       driver side, the seam checks) are never parameters.
     - Attempt 1 draws from the seed itself; attempt k > 1 from subSeed(seed,
       k), a 32-bit mix of the two, up to --tries (default 8, at most 20).
       The first attempt whose checks all pass is the result. None passing is
       a failure that names the closest attempt (fewest failed checks, the
       earliest on a tie) and those checks; the caller writes nothing (or,
       under its --force, writes the closest one with a warning).
     - Same seed + same input + same other flags = the same draws, the same
       attempts and the same output, byte for byte (mulberry32 is pure
       integer arithmetic; nothing here reads the clock or Math.random).
     - Dedupe: an attempt whose RESULT (the caller's fingerprint of the
       triangles it would cut, the colours or texels it would write) equals
       an earlier attempt's in this run is rejected as "duplicate" before its
       checks run, so the next draw is tried instead of the same output.

   What the caller reports (LAB_JSON summary.variation):
     { seed, attempt, subSeed, tries, params: {name: value}, ranges: {name:
       [lo, hi] or [choices]}, fixed: [names], perRun: [names],
       rejected: [{ attempt, subSeed, failed: [check names], params }] }
   attempt/subSeed/params describe the variant written (on failure: the
   closest one, with attempt null and `closest` set).

   Usage:
     import { parseSeed, parseTries, runVariants } from "./lib/variation.mjs";
     const seed = parseSeed(flags.seed, UsageError);          // uint32
     const res = await runVariants({ seed, tries, log: (s) => console.log(s),
       attempt: async (draw, info) => {
         const depth = draw.uniform("depth", 0.3, 0.6, { step: 0.01, fixed: flagOrUndefined });
         ...build the variant...
         if (info.duplicateOf(fingerprint(bytes))) return { duplicate: true };
         ...run the checks...
         return { failed: ["seam-depth"], value: whateverTheCallerKeeps };
       } });
     res.ok, res.chosen.value, res.summary  (see runVariants) */
import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_TRIES = 8;
export const MAX_TRIES = 20;
const UINT32_MAX = 4294967295;

/* mulberry32: a 32-bit-state PRNG, uniform floats in [0, 1). Small, fast and
   exactly reproducible across platforms (integer ops only). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* The seed of attempt k: the seed itself for k = 1 (so "--seed N" reproduces
   the first draw a user saw), else (seed, k) through the murmur3 finaliser --
   neighbouring k give unrelated streams. */
export function subSeed(seed, k) {
  if (k <= 1) return seed >>> 0;
  let h = ((seed >>> 0) ^ Math.imul(k, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* A fresh seed for a caller that wants one (the page makes its own with
   crypto.getRandomValues; this is the CLI's equivalent). */
export const randomSeed = () => randomBytes(4).readUInt32LE(0);

/* --seed: a whole number 0..4294967295, decimal or 0x hex. Err is the
   caller's usage-error class, so a bad value exits as a usage error. */
export function parseSeed(s, Err = Error) {
  const t = String(s).trim();
  const v = /^0x[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : /^\d{1,10}$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(v) || v < 0 || v > UINT32_MAX) throw new Err("--seed wants a whole number 0-" + UINT32_MAX + " (got " + JSON.stringify(s) + ")");
  return v >>> 0;
}
/* --tries: 1..MAX_TRIES, default DEFAULT_TRIES. */
export function parseTries(s, Err = Error) {
  if (s === undefined || s === null) return DEFAULT_TRIES;
  const v = Number(s);
  if (!Number.isInteger(v) || v < 1 || v > MAX_TRIES) throw new Err("--tries wants a whole number 1-" + MAX_TRIES + " (got " + JSON.stringify(s) + ")");
  return v;
}

/* Hex SHA-1 of any mix of strings, numbers and typed arrays: the dedupe key
   of an attempt's result (cut triangle ids, baked colours, patched texels). */
export function fingerprint(...parts) {
  const h = createHash("sha1");
  for (const p of parts) {
    if (p === null || p === undefined) h.update("\u0000");
    else if (ArrayBuffer.isView(p)) h.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    else h.update(String(p) + "\u0001");
  }
  return h.digest("hex");
}

const decimalsOf = (step) => { const s = String(step); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };

/* One attempt's draws. Each call consumes exactly ONE number from the stream,
   whether the parameter is fixed, sticky, unused or drawn, so the values a
   seed gives never depend on which flags were set or which branch ran.
   Options on every call:
     fixed   the caller's explicit flag value: returned as is, listed in `fixed`
     unused  the parameter does not apply to this run (no seams, no pocket):
             the draw is consumed and nothing is recorded
     sticky  drawn by the first attempt only and kept for the later ones (a
             parameter whose change costs a full recompute, e.g. the AO reach) */
export class Draw {
  constructor(seed, sticky = null) {
    this.seed = seed >>> 0;
    this.next = mulberry32(seed);
    this.params = {}; this.ranges = {}; this.fixed = []; this.perRun = [];
    this._sticky = sticky || new Map();
  }
  _take(name, range, make, opts) {
    const r = this.next();
    if (opts.unused) return opts.fixed !== undefined ? opts.fixed : undefined;
    if (opts.fixed !== undefined && opts.fixed !== null) { this.params[name] = opts.fixed; this.fixed.push(name); return opts.fixed; }
    let v;
    if (opts.sticky && this._sticky.has(name)) v = this._sticky.get(name);
    else { v = make(r); if (opts.sticky) this._sticky.set(name, v); }
    if (opts.sticky) this.perRun.push(name);
    this.params[name] = v; this.ranges[name] = range;
    return v;
  }
  /* A number in [lo, hi], rounded to `step` (readable logs, exact replays). */
  uniform(name, lo, hi, opts = {}) {
    const step = opts.step || 0;
    return this._take(name, [lo, hi], (r) => {
      let v = lo + (hi - lo) * r;
      if (step) v = +(Math.round(v / step) * step).toFixed(decimalsOf(step));
      return Math.min(hi, Math.max(lo, v));
    }, opts);
  }
  /* A whole number in [lo, hi], both ends included. */
  int(name, lo, hi, opts = {}) {
    return this._take(name, [lo, hi], (r) => Math.min(hi, lo + Math.floor(r * (hi - lo + 1))), opts);
  }
  /* One of `list`, uniformly. */
  choice(name, list, opts = {}) {
    return this._take(name, list.slice(), (r) => list[Math.min(list.length - 1, Math.floor(r * list.length))], opts);
  }
  /* true with probability p. */
  chance(name, p, opts = {}) {
    return this._take(name, [false, true], (r) => r < p, opts);
  }
}

/* "name=value name=value" for the one log line per attempt. */
export function describeParams(params) {
  return Object.entries(params).map(([k, v]) => k + "=" + (Array.isArray(v) ? v.join(",") : typeof v === "object" && v ? JSON.stringify(v) : v)).join(" ");
}

/* Runs up to `tries` attempts until one passes.
     attempt(draw, info) -> { failed: [check names] } (empty = pass), plus
       anything else the caller wants back (it is kept as res.chosen.result);
       or { duplicate: true } after info.duplicateOf(fp) said so.
     info: { k, subSeed, tries, duplicateOf(fp) -> earlier attempt k or 0
       (and remembers fp) }
     log(line): one line per attempt.
   Returns { ok, chosen: { k, subSeed, draw, result, failed } | null,
     closest: same shape | null, summary } -- summary is what goes to
   LAB_JSON summary.variation. */
export async function runVariants({ seed, tries = DEFAULT_TRIES, attempt, log = () => {}, label = "variant" }) {
  seed = seed >>> 0;
  const sticky = new Map();
  const seen = new Map();
  const rejected = [];
  let chosen = null, closest = null;
  for (let k = 1; k <= tries; k++) {
    const sub = subSeed(seed, k);
    const draw = new Draw(sub, sticky);
    const info = {
      k, subSeed: sub, tries,
      duplicateOf: (fp) => { if (seen.has(fp)) return seen.get(fp); seen.set(fp, k); return 0; },
    };
    const result = (await attempt(draw, info)) || {};
    const head = label + " " + k + "/" + tries + " (seed " + sub + "): " + describeParams(draw.params);
    if (result.duplicate) {
      const of = typeof result.duplicate === "number" ? result.duplicate : null;
      rejected.push({ attempt: k, subSeed: sub, failed: ["duplicate"], params: draw.params, ...(of ? { duplicateOf: of } : {}) });
      log(head + " -> same result as an earlier attempt" + (of ? " (" + of + ")" : "") + ", drawing again");
      continue;
    }
    const failed = result.failed || [];
    const entry = { k, subSeed: sub, draw, result, failed };
    if (!failed.length) { log(head + " -> PASS"); chosen = entry; break; }
    log(head + " -> FAIL " + failed.join(", "));
    rejected.push({ attempt: k, subSeed: sub, failed: failed.slice(), params: draw.params });
    if (!closest || failed.length < closest.failed.length) closest = entry;
  }
  const pick = chosen || closest;
  const summary = {
    seed, attempt: chosen ? chosen.k : null, subSeed: pick ? pick.subSeed : null, tries,
    params: pick ? pick.draw.params : {}, ranges: pick ? pick.draw.ranges : {}, fixed: pick ? pick.draw.fixed : [], perRun: pick ? pick.draw.perRun : [],
    rejected,
    ...(chosen ? {} : { closest: closest ? { attempt: closest.k, subSeed: closest.subSeed, failed: closest.failed } : null }),
  };
  return { ok: !!chosen, chosen, closest, summary };
}

/* The failure message when no attempt passed. */
export function noVariantMessage(res, seed, tries) {
  const c = res.closest;
  return "no variant passed its checks in " + tries + " tr" + (tries === 1 ? "y" : "ies") + " (seed " + seed + ")" +
    (c ? "; the closest was attempt " + c.k + " (seed " + c.subSeed + "), failing " + c.failed.join(", ") : "; every attempt repeated an earlier result") +
    ". Nothing written: try another seed, or Calibrated.";
}
