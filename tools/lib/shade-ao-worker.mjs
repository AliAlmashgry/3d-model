/* Worker for lib/shade-ao.mjs: takes chunks of vertices off a shared counter
   until none are left. Reads the shared BVH/positions, writes only its own
   chunks' slots of ao/sign, so results do not depend on scheduling. */
import { parentPort, workerData } from "node:worker_threads";
import { aoKernel } from "./shade-ao.mjs";

const { bvh, P, N, ao, sign, kern, chunks, progress } = workerData;
for (;;) {
  const c = Atomics.add(progress, 0, 1);
  if (c >= chunks.length) break;
  const [base, i0, i1] = chunks[c];
  aoKernel(bvh, P, N, base, i0, i1, ao, sign, kern);
  Atomics.add(progress, 1, i1 - i0);
}
parentPort.postMessage("done");
