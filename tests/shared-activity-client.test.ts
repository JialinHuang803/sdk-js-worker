import { describe, expect, it, vi } from "vitest";
import { sharedActivityClient } from "../scripts/shared-activity-client";

describe("shared activity collector client", () => {
  it("keeps collection standalone when no service is configured", () => {
    expect(sharedActivityClient(undefined, undefined)).toBeNull();
    expect(() => sharedActivityClient(undefined, "secret")).toThrow("ACTIVITY_API_URL");
    expect(() => sharedActivityClient("https://example.test/api", undefined)).toThrow("ACTIVITY_INGEST_KEY");
    expect(() => sharedActivityClient("http://example.test/api", "secret")).toThrow("HTTPS");
    expect(() => sharedActivityClient("https://example.test/api?code=secret", "secret")).toThrow("credentials");
  });

  it("loads a baseline with key only in the server-side header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ snapshot: null, trackedPullRequests: [] }),
    ));
    const client = sharedActivityClient("https://example.test/api/", "private-key", fetcher)!;
    expect(await client.baseline()).toEqual({ snapshot: null, trackedPullRequests: [] });
    expect(fetcher.mock.calls[0][0]).toBe("https://example.test/api/activity/baseline");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "x-functions-key": "private-key" });
  });

  it("fails on unavailable or corrupt shared state instead of falling back to an old baseline", async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive", { status: 503 }));
    await expect(sharedActivityClient("https://example.test/api", "key", failed)!.baseline())
      .rejects.toThrow("Shared activity baseline failed (HTTP 503).");
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ snapshot: null, trackedPullRequests: [{ repository: "../bad", number: 1 }] }),
    ));
    await expect(sharedActivityClient("https://example.test/api", "key", invalid)!.baseline())
      .rejects.toThrow("baseline is invalid");
  });
});
