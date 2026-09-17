import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSnapshot,
} from "../src/data/contracts";
import { fetchPublishedSnapshot } from "../scripts/published-snapshot";
import { ReviewInbox } from "../src/features/sdk-prs/ReviewInbox";

const snapshot: DashboardSnapshot = {
  schemaVersion: DASHBOARD_SCHEMA_VERSION,
  generatedAt: "2026-09-17T01:40:32Z",
  stale: false,
  source: {
    repository: "Azure/azure-sdk-for-js",
    query: "state:open title-prefix:[AutoPR",
    fetchedAt: "2026-09-17T01:40:32Z",
  },
  inbox: {
    comparisonFrom: "2026-09-16T03:50:38Z",
    generatedAt: "2026-09-17T01:40:32Z",
    baselineAvailable: true,
    defaultPlane: "management",
    items: [],
  },
  pullRequests: [],
};

describe("UI-only snapshot restoration", () => {
  it("preserves activity and stale state without rewriting any bytes", async () => {
    const text = JSON.stringify({
      ...snapshot,
      stale: true,
      collectionError: "Collection failed",
      inbox: {
        ...snapshot.inbox,
        items: [{
          repository: snapshot.source.repository,
          pullRequestNumber: 1,
          reasons: ["new-commit"],
          activityAt: snapshot.generatedAt,
          comments: [],
        }],
      },
    }, null, 2) + "\n";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
    expect(await fetchPublishedSnapshot("https://example.test/data.json", fetcher))
      .toBe(text);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain("cacheBust=");
    expect(options?.cache).toBe("no-store");
  });

  it("fails on HTTP and network errors instead of using checked-in data", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(fetchPublishedSnapshot("https://example.test/data.json", fetcher))
      .rejects.toThrow("HTTP 404");
    await expect(fetchPublishedSnapshot("https://example.test/data.json", fetcher))
      .rejects.toThrow("Network unavailable");
  });

  it.each([
    "{invalid JSON",
    JSON.stringify({ ...snapshot, schemaVersion: 0 }),
    JSON.stringify({ ...snapshot, generatedAt: "invalid" }),
    JSON.stringify({ ...snapshot, inbox: { ...snapshot.inbox, comparisonFrom: "invalid" } }),
    JSON.stringify({ ...snapshot, inbox: undefined }),
  ])("rejects malformed or incompatible data (%#)", async (text) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
    await expect(fetchPublishedSnapshot("https://example.test/data.json", fetcher))
      .rejects.toThrow();
  });
});

describe("inbox refresh timestamps", () => {
  it("distinguishes the comparison start from the most recent collection", () => {
    const html = renderToStaticMarkup(createElement(ReviewInbox, { snapshot }));
    expect(html).toContain(`Changes since ${new Date(snapshot.inbox.comparisonFrom!).toLocaleString()}`);
    expect(html).toContain(`Last refreshed ${new Date(snapshot.generatedAt).toLocaleString()}`);
  });

  it("shows last refreshed even when establishing the first baseline", () => {
    const html = renderToStaticMarkup(createElement(ReviewInbox, {
      snapshot: {
        ...snapshot,
        inbox: { ...snapshot.inbox, comparisonFrom: null, baselineAvailable: false },
      },
    }));
    expect(html).toContain("Baseline established");
    expect(html).not.toContain("Changes since");
    expect(html).toContain(`Last refreshed ${new Date(snapshot.generatedAt).toLocaleString()}`);
  });
});
