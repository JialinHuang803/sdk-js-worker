import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectEmitter } from "./emitter.ts";
import { isEmitterSnapshot } from "../src/data/emitter-contracts.ts";
import { loadDashboardConfig } from "./inbox.ts";
import { emitterActivityClient } from "./emitter-activity-client.ts";

const output = resolve(process.env.EMITTER_OUTPUT ?? "public/data/emitter.json");
const client = emitterActivityClient(process.env.ACTIVITY_API_URL, process.env.ACTIVITY_INGEST_KEY);
let previous = null;
if (client) previous = (await client.baseline()).snapshot;
else {
  let text: string | null;
  try { text = await readFile(output, "utf8"); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    text = null;
  }
  if (text !== null) {
    const value: unknown = JSON.parse(text);
    if (!isEmitterSnapshot(value)) throw new Error("Previous emitter snapshot is invalid");
    previous = value;
  }
}
const config = await loadDashboardConfig();
const emitterConfig: unknown = JSON.parse(await readFile(
  resolve(process.env.EMITTER_CONFIG ?? ".github/emitter-config.json"), "utf8",
));
if (!emitterConfig || typeof emitterConfig !== "object" ||
  !("excludedIssueNumbers" in emitterConfig) || !Array.isArray(emitterConfig.excludedIssueNumbers) ||
  !emitterConfig.excludedIssueNumbers.every((number: unknown) =>
    typeof number === "number" && Number.isSafeInteger(number) && number > 0)) {
  throw new Error("Emitter config must contain a valid excludedIssueNumbers array");
}
const snapshot = await collectEmitter(
  process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetch,
  () => new Date(),
  process.env.EMITTER_NPM_REGISTRY,
  { previous, comments: config.activity, excludedIssueNumbers: emitterConfig.excludedIssueNumbers },
);
if (!isEmitterSnapshot(snapshot)) throw new Error("Collected emitter snapshot is invalid");
// Ingest before publishing: a failed deployment resumes from this durable baseline.
if (client) await client.ingest({ snapshot });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Collected ${snapshot.issues.length} emitter issues and ${snapshot.pullRequests.length} PRs; latest package ${snapshot.package.version}.`);
console.log(snapshot.activity?.comparisonFrom
  ? `Collected ${snapshot.activity.events.length} emitter events since ${snapshot.activity.comparisonFrom}.`
  : "Emitter activity baseline established; no historical notifications were invented.");
console.log(client ? "Saved emitter activity to the shared service." : "Shared emitter activity is not configured; comparison uses the local snapshot.");
