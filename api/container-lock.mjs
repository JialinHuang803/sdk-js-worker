import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const artifactRegistry = "https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/";
const publicRegistry = "https://registry.npmjs.org/";

export function publicContainerLock(source) {
  const lock = structuredClone(source);
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("Expected an npm v3 dependency lock.");
  for (const entry of Object.values(lock.packages)) {
    if (!entry.resolved) continue;
    const url = new URL(entry.resolved);
    if (url.username || url.password || url.search || url.hash ||
      !(entry.resolved.startsWith(artifactRegistry) || entry.resolved.startsWith(publicRegistry))) {
      throw new Error("Container dependencies must resolve from the known public registries without credentials.");
    }
    if (!entry.integrity) throw new Error("Container dependency integrity is required.");
    if (entry.resolved.startsWith(artifactRegistry)) {
      entry.resolved = `${publicRegistry}${entry.resolved.slice(artifactRegistry.length)}`;
    }
  }
  return lock;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lock = publicContainerLock(JSON.parse(readFileSync("package-lock.json", "utf8")));
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}
