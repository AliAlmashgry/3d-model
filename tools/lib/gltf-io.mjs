/* Shared read/write for the car tools, so every tool re-saves a Draco file
   with the recipe's own settings rather than gltf-transform's defaults.

   Why this exists (measured 2026-09-30 on the shipped Altima, 2,033,632 B):
   a plain read + io.write with the default encoder options gave 1,972,468 B,
   and seat-split's output 1,973,560 B -- 3% "smaller" only because the
   default re-quantises NORMAL at 10 bits, not the --quantize-normal 12 every
   shipped car was built with. Every tool that wrote a Draco file was quietly
   coarsening the car's normals (the shading on the paint) on each edit. With
   the recipe's bits the same round trip gives 2,033,084 B: the geometry comes
   back as it went in, give or take the new edit.

   The bits below are the CLI's `draco --quantize-normal 12` with its other
   defaults (POSITION 14, COLOR 8, TEX_COORD 12, GENERIC 12). Textures are
   never touched: gltf-transform writes image bytes through unchanged.

   Usage:
     import { createIO, writeGlb, fileSize } from "./lib/gltf-io.mjs";
     const io = await createIO();              // decoder + encoder registered
     const doc = await io.read(inPath);
     ...edit...
     await writeGlb(io, doc, outPath);          // keeps Draco at recipe bits */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { statSync } from "node:fs";

export const RECIPE_DRACO_BITS = Object.freeze({ POSITION: 14, NORMAL: 12, COLOR: 8, TEX_COORD: 12, GENERIC: 12 });

export async function createIO({ encoder = true } = {}) {
  const deps = { "draco3d.decoder": await draco3d.createDecoderModule() };
  if (encoder) deps["draco3d.encoder"] = await draco3d.createEncoderModule();
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies(deps);
}

/* Writes `doc` to `outPath`. If the document is Draco-compressed (every
   shipped car is), the encoder is pinned to the recipe's quantisation first;
   an uncompressed intermediate (vertex-shading's input) is written as is. */
export async function writeGlb(io, doc, outPath) {
  const draco = doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === "KHR_draco_mesh_compression");
  if (draco) draco.setEncoderOptions({ quantizationBits: { ...RECIPE_DRACO_BITS } });
  await io.write(outPath, doc);
}

export function fileSize(path) {
  try { return statSync(path).size; } catch (e) { return null; }
}

/* One machine-readable result line for the lab server (tools/lab-server.mjs),
   printed last when a tool is run with --json. The server scans stdout for the
   LAST line starting with "LAB_JSON " and parses the rest. Shape:
     { ok, tool, input, output, bytesIn, bytesOut, summary, checks, warnings, error }
   checks: [{ name, pass, detail }] -- a tool's own verification of its result. */
export function printLabJson(result) {
  process.stdout.write("LAB_JSON " + JSON.stringify(result) + "\n");
}
