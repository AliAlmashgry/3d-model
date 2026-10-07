/* seat-rename: seat-split --rename-seat, done on the GLB's bytes.

   A rename is a change to one string in the glTF JSON, so it is made there
   and nowhere else: the JSON chunk is rewritten (padded with spaces to a
   multiple of 4, as the GLB spec asks), the header's length is updated, and
   the BIN chunk -- and any chunk after it -- is copied byte for byte. Going
   through gltf-transform instead (read, setName, writeGlb) re-encodes every
   Draco primitive: harmless (the first verifier found identical attribute
   tuple sets and textures on the Corolla) but not "nothing else changed",
   and 3,634,020 -> 3,616,728 bytes on the Corolla says otherwise.

   The JSON text is edited in place when the old name's JSON string occurs
   exactly once in it; otherwise the parsed JSON is re-serialised (still a
   JSON-only rewrite). Either way the result is parsed back and compared
   with the intended document before anything is written.

   Which names are a NEAR-MISS of Driver_Seat (the only ones renamed):
   Driver_Seat with a Blender duplicate suffix (Driver_Seat.001, the
   Corolla's) or with different case or separators (driver seat,
   DRIVER-SEAT). A name that adds a word -- Driver_Seat_Red, the Camry's,
   which its registry entry expects -- is a different name, not a typo, and
   renaming it would take the Camry's red seat off the page. */

const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

export const isNearMiss = (name, target = "Driver_Seat") =>
  name !== target && norm(name.replace(/\.\d+$/, "")) === norm(target);
const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");

/* Split a GLB into header fields, the JSON object and its text, and the
   bytes after the JSON chunk. Throws on anything that is not a GLB v2. */
export function readGlbJson(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error("not a binary glTF (.glb) file");
  if (dv.getUint32(4, true) !== 2) throw new Error("not a glTF 2.0 GLB (version " + dv.getUint32(4, true) + ")");
  const total = dv.getUint32(8, true);
  if (total !== bytes.byteLength) throw new Error(`GLB header says ${total} bytes, the file has ${bytes.byteLength}`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK) throw new Error("the GLB's first chunk is not JSON");
  if (20 + jsonLen > total) throw new Error("the GLB's JSON chunk runs past the end of the file");
  const text = new TextDecoder("utf-8").decode(bytes.subarray(20, 20 + jsonLen));
  const rest = bytes.subarray(20 + jsonLen);
  if (rest.byteLength) {
    const rdv = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    if (rest.byteLength < 8 || rdv.getUint32(4, true) !== BIN_CHUNK) throw new Error("the chunk after the GLB's JSON is not BIN");
  }
  return { json: JSON.parse(text), text, rest };
}

/* Rename material `from` (by index `index`) to `to` in GLB `bytes`.
   Returns { bytes, method: "in-place" | "re-serialised", jsonBytes: [before, after] }. */
export function renameMaterialInGlb(bytes, index, from, to) {
  const { json, text, rest } = readGlbJson(bytes);
  const mat = (json.materials || [])[index];
  if (!mat || mat.name !== from) throw new Error(`material ${index} is not named ${from}`);
  const want = JSON.parse(text);
  want.materials[index].name = to;
  const needle = JSON.stringify(from);
  let out = null, method = "in-place";
  const at = text.indexOf(needle);
  if (at >= 0 && text.indexOf(needle, at + 1) < 0) out = text.slice(0, at) + JSON.stringify(to) + text.slice(at + needle.length);
  if (out === null || JSON.stringify(JSON.parse(out)) !== JSON.stringify(want)) { out = JSON.stringify(want); method = "re-serialised"; }
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(want)) throw new Error("the rewritten JSON does not parse back to the intended document");
  let jb = new TextEncoder().encode(out);
  const padded = (jb.byteLength + 3) & ~3;
  if (padded !== jb.byteLength) { const p = new Uint8Array(padded).fill(0x20); p.set(jb); jb = p; }
  const total = 12 + 8 + jb.byteLength + rest.byteLength;
  const res = new Uint8Array(total);
  const dv = new DataView(res.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jb.byteLength, true); dv.setUint32(16, JSON_CHUNK, true);
  res.set(jb, 20);
  res.set(rest, 20 + jb.byteLength);
  return { bytes: res, method, jsonBytes: [bytes.byteLength - rest.byteLength - 20, jb.byteLength] };
}
