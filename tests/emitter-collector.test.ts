import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { collectEmitter, EMITTER_PACKAGE } from "../scripts/emitter";
import { fetchPublishedEmitter } from "../scripts/published-emitter";

const timestamp = "2026-09-18T00:00:00Z";
const issue = {
  number: 1, title: "Emitter issue", html_url: "https://github.com/Azure/typespec-azure/issues/1",
  created_at: timestamp, updated_at: timestamp,
  user: { login: "contributor", email: "private@example.test" },
  assignees: [{ login: "owner" }], labels: [{ name: "emitter:typescript" }],
  comments: 2, body: "Do not publish this body",
};
const npm = {
  name: EMITTER_PACKAGE,
  "dist-tags": { latest: "0.57.0", next: "0.58.0-dev.1" },
  versions: { "0.57.0": { name: EMITTER_PACKAGE, version: "0.57.0" } },
  time: { "0.57.0": timestamp },
};
const json = (value: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { headers });

describe("emitter collection", () => {
  it("paginates, separates PRs from issues and allowlists public fields", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([issue], { link: '<https://api.github.com/next>; rel="next"' }))
      .mockResolvedValueOnce(json([
        issue,
        { ...issue, number: 2, draft: true, pull_request: { url: "unused" }, user: null },
      ]))
      .mockResolvedValueOnce(json(npm));
    const snapshot = await collectEmitter("test-token", fetcher, () => new Date(timestamp));
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.pullRequests).toHaveLength(1);
    expect(snapshot.pullRequests[0]).toMatchObject({ number: 2, draft: true, author: null });
    expect(snapshot.package.version).toBe("0.57.0");
    expect(snapshot.source.repository).toBe("Azure/typespec-azure");
    expect(String(fetcher.mock.calls[1][0])).toContain("page=2");
    expect(fetcher.mock.calls[2][1]?.headers).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toMatch(/Do not publish|private@example|test-token|"body"|"email"/);
    expect(snapshot.generatedAt).toBe(new Date(timestamp).toISOString());
  });

  it("does not replace a collection failure with empty results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(collectEmitter(undefined, fetcher)).rejects.toThrow("HTTP 403");
  });

  it("continues beyond a full page even without a Link header", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, number) => ({
        ...issue, number: number + 1,
      }))))
      .mockResolvedValueOnce(json([{ ...issue, number: 101 }]))
      .mockResolvedValueOnce(json(npm));
    const snapshot = await collectEmitter(undefined, fetcher);
    expect(snapshot.issues).toHaveLength(101);
    expect(snapshot.issues.at(-1)?.number).toBe(101);
  });

  it("rejects missing draft state rather than treating unknown as ready", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([
      { ...issue, pull_request: { url: "unused" } },
    ]));
    await expect(collectEmitter(undefined, fetcher)).rejects.toThrow("Missing draft state");
  });

  it("fails if the latest release cannot be determined", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ ...npm, "dist-tags": {} }));
    await expect(collectEmitter(undefined, fetcher)).rejects.toThrow("latest tag");
  });

  it("allows a configured registry without sending GitHub authorization", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(npm));
    await collectEmitter("test-token", fetcher, () => new Date(timestamp), "https://feed.example.test/registry/");
    expect(String(fetcher.mock.calls[1][0])).toBe(
      "https://feed.example.test/registry/%40azure-tools%2Ftypespec-ts",
    );
    expect(fetcher.mock.calls[1][1]?.headers).toBeUndefined();
  });

  it("allows a genuinely empty open work list", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(npm));
    const snapshot = await collectEmitter(undefined, fetcher);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.pullRequests).toEqual([]);
  });
});

describe("independent emitter preservation", () => {
  it("serializes every Pages publisher and restores the other data source", () => {
    const workflow = (name: string) => readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8",
    ).replace(/\r\n/g, "\n");
    const emitter = workflow("collect-emitter");
    const sdk = workflow("collect-and-deploy");
    const ui = workflow("deploy-ui");
    for (const text of [emitter, sdk, ui]) {
      expect(text).toContain("group: pages");
      expect(text).toContain("cancel-in-progress: false");
      expect(text).not.toContain("pull_request:");
    }
    expect(emitter).toContain("run: npm run data:restore\n");
    expect(emitter).toContain("run: npm run collect:emitter");
    expect(emitter).not.toContain("ACTIVITY_INGEST_KEY");
    expect(sdk).toContain("run: npm run data:restore-emitter");
    expect(ui).toContain("run: npm run data:restore-emitter");
    expect(ui).not.toContain("run: npm run collect");
  });

  it("preserves the snapshot byte-for-byte and handles only initial 404 as absent", async () => {
    const collector = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(npm));
    const text = JSON.stringify(await collectEmitter(undefined, collector), null, 2) + "\n";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(text))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ schemaVersion: 1 }))
      .mockRejectedValueOnce(new Error("Network unavailable"));
    expect(await fetchPublishedEmitter("https://example.test/emitter.json", fetcher)).toBe(text);
    expect(await fetchPublishedEmitter("https://example.test/emitter.json", fetcher)).toBeNull();
    await expect(fetchPublishedEmitter("https://example.test/emitter.json", fetcher)).rejects.toThrow("503");
    await expect(fetchPublishedEmitter("https://example.test/emitter.json", fetcher)).rejects.toThrow("invalid");
    await expect(fetchPublishedEmitter("https://example.test/emitter.json", fetcher)).rejects.toThrow("Network");
  });
});
