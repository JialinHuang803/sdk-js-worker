import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicContainerLock } from "../api/container-lock.mjs";

const artifacts = "https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/";
describe("credential-free container dependency lock", () => {
  it("changes only the approved registry URL, preserving all locked versions and integrity hashes", () => {
    const source = JSON.parse(readFileSync(new URL("../api/package-lock.json", import.meta.url), "utf8"));
    const before = structuredClone(source);
    const result = publicContainerLock(source);
    expect(source).toEqual(before);
    for (const [path, entry] of Object.entries(source.packages) as [string, { resolved?: string }][]) {
      expect(result.packages[path]).toEqual({
        ...entry,
        ...(entry.resolved ? { resolved: entry.resolved.replace(artifacts, "https://registry.npmjs.org/") } : {}),
      });
      if (entry.resolved) {
        const resolved = result.packages[path].resolved;
        if (!resolved) throw new Error("A resolved dependency URL was removed.");
        expect(new URL(resolved).origin).toBe("https://registry.npmjs.org");
      }
    }
  });
  it.each([
    "https://private.example/package.tgz", "https://user:password@registry.npmjs.org/package.tgz",
    `${artifacts}package.tgz?token=sensitive`, "file:package.tgz",
  ])("rejects unapproved or credential-bearing sources: %s", (resolved) => {
    expect(() => publicContainerLock({ lockfileVersion: 3,
      packages: { "node_modules/example": { resolved, integrity: "sha512-test" } } })).toThrow("public registries");
  });
  it("requires a known lock format and integrity rather than silently re-resolving versions", () => {
    expect(() => publicContainerLock({ lockfileVersion: 1 })).toThrow("v3");
    expect(() => publicContainerLock({ lockfileVersion: 3,
      packages: { example: { resolved: `${artifacts}example/-/example-1.0.0.tgz` } } })).toThrow("integrity");
  });
});
