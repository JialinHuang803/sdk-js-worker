import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import viteConfig from "../vite.config";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(resolve("tests", ".azure-build-"));
  directories.push(directory);
  mkdirSync(resolve(directory, "assets"));
  writeFileSync(resolve(directory, "assets", "app.js"), "console.log('dashboard');");
  writeFileSync(resolve(directory, "assets", "app.css"), "body { color: black; }");
  writeFileSync(resolve(directory, "index.html"),
    '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">');
  writeFileSync(resolve(directory, "hosting.json"), JSON.stringify({ auth: "entra", api: "/api", base: "/" }));
  return directory;
}

function verify(directory: string) {
  return spawnSync(process.execPath, [resolve("scripts", "verify-azure-build.mjs"), directory],
    { encoding: "utf8" });
}

describe("Azure image frontend contract", () => {
  it("pins Entra compile-time settings even with incompatible preview environment variables", async () => {
    if (typeof viteConfig !== "function") throw new Error("Expected Vite factory.");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "github");
    vi.stubEnv("VITE_ACTIVITY_API_URL", "https://preview.example/api");
    vi.stubEnv("VITE_BASE_PATH", "/sdk-js-worker/");
    const config = await viteConfig({ command: "build", mode: "azure" });
    expect(config.base).toBe("/");
    expect(config.define).toMatchObject({
      "import.meta.env.VITE_ACTIVITY_AUTH": '"entra"',
      "import.meta.env.VITE_ACTIVITY_API_URL": '"/api"',
      "import.meta.env.VITE_BASE_PATH": '"/"',
    });
  });

  it("accepts only a complete root-hosted Entra frontend", () => {
    const result = verify(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Azure frontend verified");
  });

  it.each([
    { auth: "github", api: "/api", base: "/" },
    { auth: "entra", api: "https://external.example/api", base: "/" },
    { auth: "entra", api: "/api", base: "/sdk-js-worker/" },
  ])("rejects incompatible hosting settings: %j", (hosting) => {
    const directory = fixture();
    writeFileSync(resolve(directory, "hosting.json"), JSON.stringify(hosting));
    const result = verify(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Run npm run build:azure");
  });

  it("rejects the legacy build without hosting metadata and rejects stale or subpath entry assets", () => {
    const directory = fixture();
    rmSync(resolve(directory, "hosting.json"));
    expect(verify(directory).status).not.toBe(0);
    writeFileSync(resolve(directory, "hosting.json"), JSON.stringify({ auth: "entra", api: "/api", base: "/" }));
    writeFileSync(resolve(directory, "index.html"),
      '<script src="/sdk-js-worker/assets/app.js"></script><link href="/assets/app.css">');
    expect(verify(directory).status).not.toBe(0);
    writeFileSync(resolve(directory, "index.html"),
      '<script src="/assets/missing.js"></script><link href="/assets/app.css">');
    expect(verify(directory).status).not.toBe(0);
  });
});
