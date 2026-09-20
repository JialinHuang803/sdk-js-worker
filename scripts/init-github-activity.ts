import { readFile } from "node:fs/promises";
import { initialState } from "../api/src/github/initialize";
import { createGitHubClient } from "../api/src/github/client";
import { createGitHubState } from "../api/src/github/blob";
import { loadGitHubConfig } from "../api/src/github/config";

async function main() {
  const [source, mode, file, ...extra] = process.argv.slice(2);
  if ((source !== "sdk" && source !== "emitter") || extra.length ||
      !((mode === "--empty" && !file) || ((mode === "--import" || mode === "--snapshot") && file))) {
    throw new Error("Usage: npm run activity:github:init -- sdk|emitter --empty|--import <export.json>|--snapshot <snapshot.json>");
  }
  const config = loadGitHubConfig();
  const blob = createGitHubState(createGitHubClient(config.app), config.state).blob(source, true);
  if (await blob.read()) throw new Error("Activity state already exists. Refusing to replace it.");
  const value: unknown = file ? JSON.parse(await readFile(file, "utf8")) : undefined;
  const state = initialState(source, mode === "--empty" ? "empty" : mode === "--import" ? "import" : "snapshot", value);
  if (mode === "--snapshot") {
    if (source === "emitter") {
      console.log("Emitter snapshot initialization starts with inventory only; future collections discover new events.");
    }
    console.log("Starting NEW test history from one snapshot. Older activities/read markers cannot be recovered this way.");
  }
  await blob.write(JSON.stringify(state), null);
  console.log(`Initialized ${source} state. No GitHub collection or production configuration changes performed.`);
}
main().catch(() => {
  console.error("Activity initialization failed. Check arguments, local configuration, permissions and export validity. Existing state was not replaced.");
  process.exitCode = 1;
});
