import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "dist");
const instruction = "Run npm run build:azure before building the Azure image.";
try {
  const hosting = JSON.parse(readFileSync(resolve(directory, "hosting.json"), "utf8"));
  if (hosting.auth !== "entra" || hosting.api !== "/api" || hosting.base !== "/") {
    throw new Error("The frontend must use Entra authentication, same-origin /api and root assets.");
  }
  const html = readFileSync(resolve(directory, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const styles = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)].map((match) => match[1]);
  if (scripts.length === 0 || styles.length === 0) throw new Error("Frontend entry assets are missing.");
  for (const asset of [...scripts, ...styles]) {
    if (!/^\/assets\/[\w.-]+\.(?:js|css)$/.test(asset) ||
        !statSync(resolve(directory, asset.slice(1))).isFile()) {
      throw new Error(`Frontend asset is not a root-hosted build file: ${asset}`);
    }
  }
  console.log("Azure frontend verified: Entra, /api, root-hosted entry assets.");
} catch (error) {
  console.error(`Invalid Azure frontend build. ${instruction}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
