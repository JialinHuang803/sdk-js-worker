import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchPublishedEmitter } from "./published-emitter.ts";

const output = resolve("public/data/emitter.json");
const text = await fetchPublishedEmitter(
  "https://jialinhuang803.github.io/sdk-js-worker/data/emitter.json",
);
if (text === null) {
  await rm(output, { force: true });
  console.warn("No published emitter snapshot (404). Run Collect JS emitter explicitly to initialize this view.");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, "utf8");
  console.log("Restored published emitter data unchanged.");
}
