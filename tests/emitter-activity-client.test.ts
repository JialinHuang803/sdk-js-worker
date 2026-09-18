import { describe, expect, it, vi } from "vitest";
import { emitterActivityClient } from "../scripts/emitter-activity-client";
import type { EmitterSnapshot } from "../src/data/emitter-contracts";

const snapshot: EmitterSnapshot = {
  schemaVersion: 1, generatedAt: "2026-09-18T00:00:00Z",
  source: { repository: "Azure/typespec", label: "emitter", fetchedAt: "2026-09-18T00:00:00Z" },
  package: { name: "emitter", version: "1.0.0", publishedAt: null, url: "https://npmjs.com/package/emitter" },
  issues: [], pullRequests: [], activity: { comparisonFrom: null, events: [], excludedIssueNumbers: [] },
};

describe("emitter activity collector client", () => {
  it("is disabled only when both configuration values are absent", () => {
    expect(emitterActivityClient(undefined, undefined)).toBeNull();
    expect(() => emitterActivityClient(undefined, "secret")).toThrow("ACTIVITY_API_URL");
    expect(() => emitterActivityClient("https://example.test/api", undefined)).toThrow("ACTIVITY_INGEST_KEY");
    expect(() => emitterActivityClient("http://example.test/api", "key")).toThrow("HTTPS");
    for (const suffix of ["?code=secret", "#secret"]) {
      expect(() => emitterActivityClient(`https://example.test/api${suffix}`, "key")).toThrow("credentials");
    }
    expect(() => emitterActivityClient("https://user:password@example.test/api", "key")).toThrow("credentials");
  });

  it("uses emitter routes with a server-only key header and no response caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"snapshot":null}'));
    const client = emitterActivityClient("https://example.test/api/", "private-key", fetcher)!;
    expect(await client.baseline()).toEqual({ snapshot: null });
    const request = { snapshot };
    await client.ingest(request);
    expect(fetcher.mock.calls[0][0]).toBe("https://example.test/api/emitter-activity/baseline");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET", cache: "no-store", headers: { "x-functions-key": "private-key" },
    });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls[1][0]).toBe("https://example.test/api/emitter-activity/ingest");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(request) });
  });

  it("accepts a valid authoritative baseline with its activity window", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ snapshot })));
    await expect(emitterActivityClient("https://example.test/api", "key", fetcher)!.baseline())
      .resolves.toEqual({ snapshot });
  });

  it("treats a valid legacy inventory without activity as no baseline", async () => {
    const { activity: _activity, ...inventoryOnly } = snapshot;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ snapshot: inventoryOnly })));
    await expect(emitterActivityClient("https://example.test/api", "key", fetcher)!.baseline())
      .resolves.toEqual({ snapshot: null });
  });

  it("fails closed for service errors and malformed baselines", async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response("private infrastructure", { status: 503 }));
    const client = emitterActivityClient("https://example.test/api", "key", failed)!;
    await expect(client.baseline()).rejects.toThrow("Shared emitter activity baseline failed (HTTP 503).");
    await expect(client.ingest({ snapshot: {} as EmitterSnapshot })).rejects.toThrow("ingest failed (HTTP 503)");
    for (const invalid of [null, {}, { snapshot: {} },
      { snapshot: { schemaVersion: 1, generatedAt: "invalid" } }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(invalid)));
      await expect(emitterActivityClient("https://example.test/api", "key", fetcher)!.baseline())
        .rejects.toThrow("baseline is invalid");
    }
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    await expect(emitterActivityClient("https://example.test/api", "key", network)!.baseline())
      .rejects.toThrow("network unavailable");
  });
});
