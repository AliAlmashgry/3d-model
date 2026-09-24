/* Loads visual-search-standalone/index.html, picks a car by id, opens the 3D
   screen, waits for the model, screenshots. node .render/page.mjs <outPng> <carId> [--orbit ...] */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const [outPng, carId] = args;
const PORT = Number(opt("port", 8765));
const dir = mkdtempSync(join(tmpdir(), "page-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new","--remote-debugging-port=0","--user-data-dir="+dir,"--no-first-run","--no-default-browser-check",
   "--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--hide-scrollbars","about:blank"], {stdio:["ignore","pipe","pipe"]});
let wsUrl = null;
await new Promise((res, rej) => { let b=""; chrome.stderr.on("data",(d)=>{b+=d;const m=b.match(/ws:\/\/[^\s]+/);if(m&&!wsUrl){wsUrl=m[0];res();}}); setTimeout(()=>rej(new Error(b)),30000); });
let id = 1; const pend = new Map(); const subs = [];
const ws = new WebSocket(wsUrl);
await new Promise((r)=>ws.addEventListener("open", r));
ws.addEventListener("message",(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);} else subs.forEach((f)=>f(m));});
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params,sessionId}));});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S=(m,p)=>send(m,p,sessionId);
await S("Page.enable"); await S("Runtime.enable"); await S("Log.enable");
const logs = [];
subs.push((m)=>{ if (m.sessionId!==sessionId) return;
  if (m.method==="Runtime.consoleAPICalled") logs.push(m.params.type + ": " + m.params.args.map((a)=>a.value??a.description??"").join(" "));
  if (m.method==="Log.entryAdded") logs.push("[log] " + m.params.entry.text);
  if (m.method==="Runtime.exceptionThrown") logs.push("[EXC] " + (m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text));
});
await S("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/visual-search-standalone/index.html` });
const evalJs = async (expr) => (await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const waitFor = async (expr, ms = 240000, label = expr) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await new Promise((r)=>setTimeout(r, 700)); }
  console.log("TIMEOUT waiting for " + label); return false;
};
await waitFor("!!document.querySelector('#vss-car')", 60000, "picker");
if (carId) {
  await evalJs(`(() => { const s = document.querySelector('#vss-car'); s.value = ${JSON.stringify(carId)};
    s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  await new Promise((r)=>setTimeout(r, 400));
}
const picked = await evalJs("document.querySelector('#vss-car').value");
const names = await evalJs("[...document.querySelectorAll('#vss-car option')].map(o=>o.value+' | '+o.textContent).join(' ;; ')");
await evalJs("document.querySelectorAll('.vss-card')[1].click()");
const ok = await waitFor("!!document.querySelector('.locate-screen.is-open .car-stage-3d[data-model-ready=\"true\"]')", 300000, "model");
await new Promise((r)=>setTimeout(r, 2500));
const shot = await S("Page.captureScreenshot", { format: "png" });
writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log((ok ? "ok " : "TIMEOUT ") + picked + " -> " + outPng);
if (!carId) console.log(names);
for (const l of logs) if (!/BABEL|exceeds the max/.test(l)) console.log("  " + l.slice(0, 400));
chrome.kill();
