import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectEmitter } from "./emitter.ts";
import { isEmitterSnapshot } from "../src/data/emitter-contracts.ts";

const snapshot = await collectEmitter(
  process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetch,
  () => new Date(),
  process.env.EMITTER_NPM_REGISTRY,
);
if (!isEmitterSnapshot(snapshot)) throw new Error("Collected emitter snapshot is invalid");
const output = resolve(process.env.EMITTER_OUTPUT ?? "public/data/emitter.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Collected ${snapshot.issues.length} emitter issues and ${snapshot.pullRequests.length} PRs; latest package ${snapshot.package.version}.`);
