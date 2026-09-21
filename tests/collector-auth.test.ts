import { describe, expect, it, vi } from "vitest";
import { collectorCredential } from "../scripts/collector-auth";
import { sharedActivityClient } from "../scripts/shared-activity-client";
import { emitterActivityClient } from "../scripts/emitter-activity-client";
import type { EmitterSnapshot } from "../src/data/emitter-contracts";

const env = {
  ACTIVITY_COLLECTOR_AUTH: "github-oidc",
  ACTIVITY_API_URL: "https://dashboard.example/api",
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/job/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-credential",
};

describe("GitHub Actions collector credentials", () => {
  it("retains explicit legacy-key and standalone collection modes", () => {
    expect(collectorCredential({})).toBeUndefined();
    expect(collectorCredential({ ACTIVITY_INGEST_KEY: "legacy" })).toBe("legacy");
  });

  it.each([
    { ACTIVITY_COLLECTOR_AUTH: "unknown" },
    { ACTIVITY_INGEST_KEY: "old-key" },
    { ACTIVITY_API_URL: "" },
    { ACTIVITY_API_URL: "not-a-url" },
    { ACTIVITY_API_URL: "http://dashboard.example/api" },
    { ACTIVITY_API_URL: "https://dashboard.example/api?secret=value" },
    { ACTIVITY_API_URL: "https://dashboard.example/wrong" },
    { GITHUB_ACTIONS: "" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "not-a-url" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/idtoken" },
  ])("rejects invalid or ambiguous configuration %o", (override) => {
    expect(() => collectorCredential({ ...env, ...override })).toThrow();
  });

  it("requests a fresh token per API call with an exact audience and no redirects", async () => {
    const identity = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ value: `header.payload.signature${identity.mock.calls.length}` })));
    const credential = collectorCredential(env, identity);
    const api = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ snapshot: null, trackedPullRequests: [] })));
    const sdk = sharedActivityClient(env.ACTIVITY_API_URL, credential, api)!;
    const emitter = emitterActivityClient(env.ACTIVITY_API_URL, credential, api)!;
    await sdk.baseline();
    await emitter.baseline();
    const snapshot: EmitterSnapshot = {
      schemaVersion: 1, generatedAt: "2026-09-21T00:00:00Z",
      source: { repository: "Azure/typespec-azure", label: "emitter:typescript", fetchedAt: "2026-09-21T00:00:00Z" },
      package: { name: "@azure-tools/typespec-ts", version: "1.0.0", publishedAt: null, url: "https://www.npmjs.com/package/@azure-tools/typespec-ts" },
      issues: [], pullRequests: [],
    };
    await emitter.ingest({ snapshot });
    expect(identity).toHaveBeenCalledTimes(3);
    expect(new URL(String(identity.mock.calls[0][0])).searchParams.get("audience"))
      .toBe("https://dashboard.example/api/collector");
    expect(identity.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer runner-request-credential" }, redirect: "error",
    });
    for (const [index, [, options]] of api.mock.calls.entries()) {
      expect(options).toMatchObject({
        headers: { Authorization: `Bearer header.payload.signature${index + 1}` }, redirect: "error",
      });
      expect(options?.headers).not.toHaveProperty("x-functions-key");
    }
  });

  it("does not expose token issuer response bodies in errors", async () => {
    for (const response of [
      new Response("sensitive issuer response", { status: 403 }),
      new Response("sensitive malformed JSON"),
      new Response('{"value":"not a token"}'),
    ]) {
      const credential = collectorCredential(env, vi.fn<typeof fetch>().mockResolvedValue(response));
      if (typeof credential !== "function") throw new Error("Expected a token provider.");
      const error = await credential().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/sensitive|not a token/);
    }
  });
});
