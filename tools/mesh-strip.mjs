#!/usr/bin/env node
/* mesh-strip: delete whole parts (mesh primitives) from a GLB.

   Sketchfab exports keep small add-on parts as their own meshes, so anything
   the demo should not show -- the licence plates and the black backing panel
   behind a front plate -- can be dropped outright instead of carved out of a
   shared surface. Run --report first to read the parts, their triangle counts
   and world bounds, then pass the ones to delete.

   Usage:
     node tools/mesh-strip.mjs <in.glb> --report [--match <text>] [--remove <terms>] [--json]
     node tools/mesh-strip.mjs <in.glb> <out.glb> --remove <term>[,<term>...] [--force] [--json]

   --report lists ONE ROW PER PART: a primitive, by its id "#<mesh>.<prim>".
   A shipped file has been through dedup, so one mesh can sit under several
   nodes (the Accent's and the Optima's four wheels are one mesh each, drawn
   by four nodes). Listing per node gave the same id four times: the lab's list
   keyed its rows by id, so ticking one ticked all four, and React warned about
   duplicate keys. Now the copies are merged into one row with `nodes` (how
   many nodes draw it) and bounds that cover every copy. Each row carries:
     id        "#m.p", the exact handle --remove takes (see below)
     label     the mesh's name, else its first node's name, else "mesh m".
               Many exports leave meshes unnamed (the Accent's are all
               "Geom3D" nodes); "?" told the user nothing
     material  the primitive's material name ("(none)" if it has none)
     tris      triangles in ONE copy (0 for a point/line primitive, which also
               gets a `mode`)
     lo, hi    world-space bounds over every copy, the coordinate space of
               seat-split --pick and occlusion-patch --pocket
     nodes     how many nodes share the mesh (1 = a part of its own)
     remove    whether the --remove terms given would take it
   --match keeps the rows whose label, material or id contains the text,
   ignoring case. Names alone are meaningless on these exports (every Accent
   label is "Geom3D", the Camry's are Object_0..5), so the material is often
   the only way to find a part: --match grille, --match driver_seat. Rows a
   --remove term takes are always listed, filter or not.

   --remove takes comma-separated terms. A term is either
     "#<mesh>.<prim>"  the exact id --report printed: the one way to delete a
                       single part. Names are not unique (the Camry has four
                       different primitives under "Object_0", one of them the
                       red driver's seat; a substring delete took all four),
                       so the lab's tick list deletes by id. Ids are pinned
                       when the file is read, so removing #3.0 does not shift
                       #5.1 within the same run -- but the NEXT file numbers
                       its meshes afresh, so ids from an old list are stale.
     <substring>       matched against the mesh name and its node's name, the
                       recipe's `--remove plate`. This one stays CASE-SENSITIVE:
                       it deletes, and an unmatched term refuses the write, so
                       a wrong case fails safe instead of widening the cut.

   Self-checks (in --json; a failed one refuses the write unless --force):
     every-term-matched  every --remove term took something, or a typo in a
                         long Sketchfab name would ship an unchanged file;
     no-shared-meshes    a term that takes a primitive of a SHARED mesh takes
                         it from every node drawing that mesh -- all four
                         wheels, not the one you meant. --force deletes every
                         copy (that is the way to drop a repeated part).
   A plain list (--report with no --remove) runs no checks: there is nothing
   to check, and two green ticks for "all 0 terms matched" were noise. A
   --report WITH --remove is the dry run: it marks the rows and runs the checks
   but writes nothing, whatever they say.

   After the cut a node whose mesh ends up empty is detached, and the
   accessors, materials and textures that ONLY the removed primitives used are
   dropped, so a plate's own image does not ride along as dead weight. Nothing
   the removed parts did not reference is touched (an unused material that was
   already in the file stays), and texture bytes are never re-encoded. A
   material that disappears is named in warnings[]: a look slot in the
   registry (paint, seat, interior) that names it would stop matching, which
   is how a stale tick once deleted the Camry's red seat unnoticed.

   A plate that sat in a pocket pressed into the boot lid (both Nissans, rear)
   leaves the pocket's baked shadow behind as a black rectangle. The old
   --drop-occlusion cleared the whole occlusion map for that, and it is gone:
   that map is what greys the body and draws its seam lines, the Camry's look.
   Lift only the pocket with tools/occlusion-patch.mjs --pocket, using the
   deleted row's lo/hi (padded a little) as the box.

   Run it on the ORIGINAL export (root assets/) after the seat split, then
   compress into visual-search-standalone/assets/ as usual; the Camry has no
   original, so it is stripped in place and re-encoded. In the lab it runs on
   the car's newest draft. */
import path from "node:path";
import { Primitive } from "@gltf-transform/core";
import { createIO, writeGlb, fileSize } from "./lib/gltf-io.mjs";
import { parseArgs, runTool, UsageError } from "./lib/shade-cli.mjs";

const TOOL = "mesh-strip";
const USAGE = "usage: mesh-strip <in.glb> --report [--match <text>] [--remove <terms>] [--json]\n" +
  "       mesh-strip <in.glb> <out.glb> --remove <term>[,<term>...] [--force] [--json]\n" +
  "  a term is a part id from --report (#<mesh>.<prim>) or a case-sensitive name substring";
/* Every exit, a usage error included, goes through runTool/LabRun.finish, so
   a --json run always ends with a LAB_JSON line the lab can show instead of
   "the tool failed -- see its log". */
const SPEC = {
  bool: ["report", "json", "force"],
  value: ["match", "remove"],
  retired: {
    "drop-occlusion": "the occlusion map carries the body's shading and seam lines. Lift only the plate pocket with tools/occlusion-patch.mjs --pocket.",
  },
};
const MODE_NAMES = { 0: "points", 1: "lines", 2: "line-loop", 3: "line-strip", 4: "triangles", 5: "triangle-strip", 6: "triangle-fan" };
const LIST_CAP = 60; // text output only; the JSON rows are never capped

const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const f3 = (v) => "[" + v.map((n) => n.toFixed(3)).join(", ") + "]";
const r4 = (n) => +n.toFixed(4);
const base = (p) => (p ? path.basename(p) : p);
const plural = (n, word, many = word + "s") => n + " " + (n === 1 ? word : many);

await runTool(TOOL, USAGE, async (run) => {
  const { flags, positional } = parseArgs(process.argv.slice(2), SPEC);
  const [inPath, outPath] = positional;
  run.input = inPath || null;
  if (!inPath) throw new UsageError("give <in.glb>");
  if (positional.length > 2) throw new UsageError("too many paths: " + positional.slice(2).join(" ") + " (a name with spaces needs quotes)");
  if (!flags.report && !outPath) throw new UsageError("give <out.glb> with --remove, or --report to list the parts");
  run.bytesIn = fileSize(inPath);
  if (run.bytesIn === null) throw new Error("cannot read " + base(inPath));

  const removes = [...new Set((flags.remove || "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (flags.remove !== undefined && !removes.length) throw new UsageError("--remove needs at least one term");
  if (!flags.report && !removes.length) throw new UsageError("give --remove <term>[,<term>...] (ids from --report, e.g. #4.2)");
  const badId = removes.find((t) => t.startsWith("#") && !/^#\d+\.\d+$/.test(t));
  if (badId) throw new UsageError("bad part id " + badId + ": ids look like #<mesh>.<prim>, e.g. #4.2, as --report prints them");
  if (flags.report && outPath) run.warn("--report writes nothing; " + base(outPath) + " ignored");
  const matchFilter = flags.match !== undefined && flags.match !== "" ? flags.match.toLowerCase() : null;

  // Recipe Draco bits on write -- see lib/gltf-io.mjs for what the default did.
  const io = await createIO();
  const doc = await io.read(inPath);
  const root = doc.getRoot();
  const graph = doc.getGraph();

  /* One entry per primitive, with every node that draws it. Ids are pinned
     here, before anything is removed. */
  const parts = new Map(); // prim -> part
  const meshes = root.listMeshes();
  meshes.forEach((mesh, mi) => mesh.listPrimitives().forEach((prim, pi) => {
    parts.set(prim, { prim, mesh, mi, id: "#" + mi + "." + pi, nodes: [] });
  }));
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) parts.get(prim).nodes.push(node);
  }
  const instances = [...parts.values()].reduce((s, p) => s + p.nodes.length, 0);
  const labelOf = (part) => part.mesh.getName() || (part.nodes.find((n) => n.getName()) || { getName: () => "" }).getName() || "mesh " + part.mi;
  const sharedNote = (part) => (part.nodes.length > 1 ? " (" + part.nodes.length + " nodes)" : "");

  /* A term takes a part when it is the part's id, or (a substring term) when
     the mesh name or ANY node drawing it contains it -- removing a primitive
     takes it from every node, so a node-name hit on one copy takes them all
     (the no-shared-meshes check catches that). A part no node draws is still
     listed and can be removed by id; a name term only sees its mesh name. */
  const takes = (part, term) => (term.startsWith("#")
    ? part.id === term
    : (part.mesh.getName() || "").includes(term) || part.nodes.some((n) => (n.getName() || "").includes(term)));

  // ---- rows -------------------------------------------------------------------
  const all = [];
  for (const part of parts.values()) {
    const { prim } = part;
    const mode = prim.getMode();
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices();
    const arr = idx ? idx.getArray() : null;
    const n = pos ? (arr ? arr.length : pos.getCount()) : 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const v = [0, 0, 0];
    for (const node of part.nodes) {
      const m = node.getWorldMatrix();
      for (let i = 0; i < n; i++) {
        const p = xform(m, pos.getElement(arr ? arr[i] : i, v));
        for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
      }
    }
    const tris = mode === Primitive.Mode.TRIANGLES ? n / 3 : mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN ? Math.max(0, n - 2) : 0;
    const placed = Number.isFinite(lo[0]);
    const mat = prim.getMaterial();
    const row = {
      id: part.id, label: labelOf(part), material: mat ? mat.getName() || "(unnamed)" : "(none)", tris,
      lo: placed ? lo.map(r4) : null, hi: placed ? hi.map(r4) : null, nodes: part.nodes.length,
      remove: removes.some((t) => takes(part, t)),
    };
    if (mode !== Primitive.Mode.TRIANGLES) row.mode = MODE_NAMES[mode] || String(mode);
    part.row = row;
    all.push(row);
  }
  all.sort((a, b) => (b.remove - a.remove) || (b.tris - a.tris) || (a.id < b.id ? -1 : 1));
  const rows = matchFilter
    ? all.filter((r) => r.remove || [r.label, r.material, r.id].some((s) => s.toLowerCase().includes(matchFilter)))
    : all;

  const where = (r) => (r.lo ? f3(r.lo) + " -> " + f3(r.hi) : "(not placed: no node draws it)");
  const line = (r) => "  " + (r.remove ? "REMOVE  " : "        ") + r.id.padEnd(8) + " tris=" + String(r.tris).padStart(6) +
    (r.nodes > 1 ? "  x" + r.nodes : "    ") + "  " + where(r) + "  mat=" + r.material.padEnd(14) + "  " + r.label + (r.mode ? "  [" + r.mode + "]" : "");
  run.log(base(inPath) + ": " + plural(parts.size, "part") + " drawn " + instances + " times, " +
    plural(meshes.length, "mesh", "meshes") + ", " + plural(root.listMaterials().length, "material"));
  if (removes.length) run.log("remove terms: " + removes.join(", "));
  if (flags.report) {
    const capped = !matchFilter && !removes.length && rows.length > LIST_CAP;
    for (const r of capped ? rows.slice(0, LIST_CAP) : rows) run.log(line(r));
    if (capped) run.log("  ... " + (rows.length - LIST_CAP) + " more (use --match to filter)");
    if (matchFilter && !rows.length) run.log("  no part's name, material or id contains \"" + flags.match + "\"");
  } else {
    for (const r of rows.filter((x) => x.remove)) run.log(line(r));
  }

  const summary = { total: all.length, shown: rows.length, parts: parts.size, instances, meshes: meshes.length, materials: root.listMaterials().length };

  // A plain list: nothing to check, nothing to write.
  if (!removes.length) {
    run.summary = { ...summary, rows };
    return run.finish(true);
  }

  // ---- plan + checks ----------------------------------------------------------
  const doomed = [...parts.values()].filter((p) => p.row.remove);
  const unmatched = removes.filter((t) => !doomed.some((p) => takes(p, t)));
  const shared = doomed.filter((p) => p.nodes.length > 1);
  const sharedText = shared.map((p) => p.id + " " + p.row.label + sharedNote(p)).join(", ");
  run.check("every-term-matched", !unmatched.length, unmatched.length ? "no part matches: " + unmatched.join(", ") : "all " + plural(removes.length, "term") + " matched (" + plural(doomed.length, "part") + ")");
  run.check("no-shared-meshes", !shared.length, shared.length
    ? "would delete every copy of: " + sharedText + (flags.force ? " (--force: deleting them all)" : " -- --force deletes every copy")
    : "every part to remove is drawn by one node");

  /* Materials that only the doomed parts use disappear with them. Say so: the
     page's look registry names materials, and a missing one breaks its slot
     silently (the lab's Save refuses it, but the list is the place to see it). */
  const doomedSet = new Set(doomed.map((p) => p.prim));
  const lostMaterials = [...new Set(doomed.map((p) => p.prim.getMaterial()).filter(Boolean))]
    .filter((mat) => graph.listParents(mat).every((x) => x.propertyType === "Root" || doomedSet.has(x)))
    .map((mat) => mat.getName() || "(unnamed)");
  if (lostMaterials.length) run.warn("removes the last use of material" + (lostMaterials.length > 1 ? "s " : " ") + lostMaterials.join(", ") + " -- a look slot naming it would stop matching");
  const removedList = doomed.map((p) => ({ id: p.id, label: p.row.label, material: p.row.material, tris: p.row.tris, nodes: p.row.nodes, lo: p.row.lo, hi: p.row.hi }));

  if (flags.report) {
    // The dry run: the checks are information here, nothing is written.
    run.summary = { ...summary, rows, wouldRemove: removedList, wouldFreeMaterials: lostMaterials };
    return run.finish(true);
  }
  run.summary = { ...summary, removed: removedList };
  // --force pushes past a check, never past an empty cut: that is an unchanged file re-encoded.
  if (!doomed.length) return run.finish(false, "nothing to remove: no part matches " + removes.join(", ") + "; nothing written", 3);
  if (run.failed.length && !flags.force) {
    return run.finish(false, "checks failed (" + run.failed.map((c) => c.name).join(", ") + "): " +
      (unmatched.length ? "no part matches " + unmatched.join(", ") : "shared mesh " + sharedText) + "; nothing written" +
      (unmatched.length ? "" : ". Pass --force to delete every copy."), 3);
  }
  if (run.failed.length) run.warn("writing despite failed checks (--force): " + run.failed.map((c) => c.name).join(", "));

  // ---- strip ------------------------------------------------------------------
  /* Everything the doomed primitives reference, collected BEFORE they go:
     accessors (attributes, indices, morph targets), the material, and below
     it textures and extension properties (a clearcoat's own textures hang off
     one). Buffers are never candidates. */
  const candidates = new Set();
  const walk = (prop) => {
    for (const child of graph.listChildren(prop)) {
      if (child.propertyType === "Buffer" || child.propertyType === "Root" || candidates.has(child)) continue;
      candidates.add(child);
      walk(child);
    }
  };
  let removedTris = 0;
  const touched = new Set();
  for (const part of doomed) {
    walk(part.prim);
    removedTris += part.row.tris;
    part.mesh.removePrimitive(part.prim);
    part.prim.dispose();
    touched.add(part.mesh);
    run.log("removed " + part.id + " " + part.row.label + " (" + part.row.material + ")" + sharedNote(part));
  }
  let detached = 0;
  for (const mesh of touched) {
    if (mesh.listPrimitives().length) continue;
    for (const node of root.listNodes()) if (node.getMesh() === mesh) { node.setMesh(null); detached++; }
    mesh.dispose();
  }
  /* Drop the candidates nothing else uses any more, until it settles: a
     material goes first, which orphans its textures and extension
     properties, which can orphan more textures. Root holds every accessor,
     material and texture, so "orphaned" = no parent but Root. */
  const freed = { Accessor: 0, Material: 0, Texture: 0 };
  for (let changed = true; changed;) {
    changed = false;
    for (const prop of candidates) {
      if (prop.isDisposed()) continue;
      if (!graph.listParents(prop).every((x) => x.propertyType === "Root")) continue;
      if (freed[prop.propertyType] !== undefined) freed[prop.propertyType]++;
      prop.dispose();
      changed = true;
    }
  }
  await writeGlb(io, doc, outPath);
  run.output = outPath;
  run.log("wrote " + base(outPath) + ": removed " + plural(doomed.length, "primitive") + " (" + removedTris + " triangles), emptied " +
    plural(detached, "node") + ", freed " + freed.Accessor + " accessors / " + freed.Material + " materials / " + freed.Texture + " textures");
  run.summary = {
    ...summary, removed: removedList, removedPrimitives: doomed.length, removedTriangles: removedTris, emptiedNodes: detached,
    freedAccessors: freed.Accessor, freedMaterials: freed.Material, freedTextures: freed.Texture, freedMaterialNames: lostMaterials,
  };
  return run.finish(true);
});
