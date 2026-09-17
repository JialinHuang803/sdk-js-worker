import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchPublishedSnapshot } from "./published-snapshot.ts";

const outputPath = resolve(
  process.env.SNAPSHOT_PATH ?? "public/data/sdk-prs.json",
);
const url =
  process.env.PREVIOUS_SNAPSHOT_URL ??
  "https://jialinhuang803.github.io/sdk-js-worker/data/sdk-prs.json";

const text = await fetchPublishedSnapshot(url);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, text, "utf8");
console.log("Restored published snapshot unchanged; no data collection performed.");
