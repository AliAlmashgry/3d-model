/* Headless render harness: node .render/shoot.mjs out.png "src1|src2" "orbit1|orbit2" [opts]
   opts: --fov 30deg --w 520 --h 400 --cols N --profile --looks '<json>' --gpu --timeout 180 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes("--" + name);
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i-1].startsWith("--") && !["profile","gpu"].includes(args[i-1].slice(2))));
const [outPng, srcs, orbits] = pos;

const PORT = Number(opt("port", 8765));
const qs = new URLSearchParams({ srcs, orbits: orbits || "90deg 80deg 110%", fov: opt("fov","30deg"), w: opt("w","520"), h: opt("h","400") });
if (opt("cols")) qs.set("cols", opt("cols"));
if (has("profile")) qs.set("profile", "1");
if (opt("looks")) qs.set("looks", opt("looks"));
if (has("droppaint")) qs.set("dropPaint", "1");
const url = `http://127.0.0.1:${PORT}/.render/index.html?` + qs.toString();

const profileDir = mkdtempSync(join(tmpdir(), "mvshoot-"));
const chromeArgs = [
  "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profileDir,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--hide-scrollbars", "--force-device-scale-factor=" + opt("dpr","2"),
];
if (has("gpu")) chromeArgs.push("--use-angle=default");
else chromeArgs.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
chromeArgs.push("about:blank");

const chrome = spawn(opt("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"), chromeArgs, { stdio: ["ignore","pipe","pipe"] });
let wsUrl = null;
const ready = new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m && !wsUrl) { wsUrl = m[0]; res(); }
  });
  setTimeout(() => rej(new Error("chrome did not start:\n" + buf)), 30000);
});
await ready;

let nextId = 1;
const pendingMsgs = new Map();
const listeners = [];
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pendingMsgs.has(msg.id)) { const { res, rej } = pendingMsgs.get(msg.id); pendingMsgs.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else listeners.forEach((f) => f(msg));
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pendingMsgs.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable"); await S("Runtime.enable"); await S("Log.enable"); await S("Console.enable");
const logs = [];
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  if (msg.method === "Log.entryAdded") logs.push("[log] " + msg.params.entry.text);
  if (msg.method === "Runtime.exceptionThrown") logs.push("[EXC] " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
});
await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await S("Page.navigate", { url });

const timeout = Number(opt("timeout", 240)) * 1000;
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < timeout) {
  const r = await S("Runtime.evaluate", { expression: "document.body.dataset.ready === 'true'", returnByValue: true });
  if (r.result.value) { ok = true; break; }
  await new Promise((r2) => setTimeout(r2, 1000));
}
await new Promise((r) => setTimeout(r, 1500));
const metrics = await S("Runtime.evaluate", { expression: "JSON.stringify({w: document.getElementById('wrap').scrollWidth, h: document.getElementById('wrap').scrollHeight})", returnByValue: true });
const rawMetrics = metrics?.result?.value;
const { w, h } = rawMetrics ? JSON.parse(rawMetrics) : { w: 1080, h: 1080 };
await S("Emulation.setDeviceMetricsOverride", { width: Math.max(w, 10), height: Math.max(h, 10), deviceScaleFactor: Number(opt("dpr", 2)), mobile: false });
await new Promise((r) => setTimeout(r, 800));
const shot = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log((ok ? "ready" : "TIMEOUT") + " -> " + outPng + " (" + (Date.now()-t0)/1000 + "s)");
for (const l of logs) console.log("  " + l.slice(0, 2000));
chrome.kill();
process.exit(ok ? 0 : 1);
