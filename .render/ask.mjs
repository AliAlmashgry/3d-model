/* node .render/ask.mjs "<src>" "<orbit>" "<expr>" [--fov 30deg]
   Loads one model in .render/probe.html and evaluates an expression in the page. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const [src, orbit, expr] = args;
const PORT = Number(opt("port", 8765));
const qp = { src, orbit, fov: opt("fov", "30deg") };
if (opt("look")) qp.look = opt("look");
const url = `http://127.0.0.1:${PORT}/.render/probe.html?` + new URLSearchParams(qp);
const dir = mkdtempSync(join(tmpdir(), "mvask-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new","--remote-debugging-port=0","--user-data-dir="+dir,"--no-first-run","--no-default-browser-check",
   "--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--hide-scrollbars","about:blank"], { stdio:["ignore","pipe","pipe"] });
let wsUrl = null;
await new Promise((res, rej) => { let b=""; chrome.stderr.on("data",(d)=>{b+=d; const m=b.match(/ws:\/\/[^\s]+/); if(m&&!wsUrl){wsUrl=m[0];res();}}); setTimeout(()=>rej(new Error(b)),30000); });
let id = 1; const pend = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r)=>ws.addEventListener("open", r));
ws.addEventListener("message",(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params,sessionId}));});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S=(m,p)=>send(m,p,sessionId);
await S("Page.enable"); await S("Runtime.enable");
await S("Page.navigate", { url });
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < Number(opt("timeout", 300)) * 1000) {
  const r = await S("Runtime.evaluate", { expression: "document.body.dataset.ready === 'true'", returnByValue: true });
  if (r.result.value) { ok = true; break; }
  await new Promise((r2)=>setTimeout(r2, 1000));
}
if (!ok) { console.log("TIMEOUT"); chrome.kill(); process.exit(1); }
const out = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(out.result.value ?? JSON.stringify(out.result));
if (out.exceptionDetails) console.log("EXC " + JSON.stringify(out.exceptionDetails).slice(0,500));
chrome.kill();
