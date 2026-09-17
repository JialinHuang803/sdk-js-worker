import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { collectMergedPullRequests, mergeHistoryStart, type ClosedPull } from "../scripts/merged-prs";
import { buildReviewInbox } from "../scripts/inbox";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";
import { ReviewInbox } from "../src/features/sdk-prs/ReviewInbox";
import { PrTable } from "../src/features/sdk-prs/PrTable";

const repository = "Azure/azure-sdk-for-js";
const since = "2026-09-16T00:00:00Z";
const now = "2026-09-17T00:00:00Z";

function closed(number: number, overrides: Partial<ClosedPull> = {}): ClosedPull {
  return {
    number,
    title: "[AutoPR @azure-arm-example] Generated SDK",
    html_url: `https://github.com/${repository}/pull/${number}`,
    updated_at: "2026-09-16T12:00:00Z",
    merged_at: "2026-09-16T11:00:00Z",
    labels: [{ name: "Mgmt" }],
    head: { sha: "head" },
    ...overrides,
  };
}

describe("recent SDK merges", () => {
  it("collects a full week even on the first run or after a recent refresh", () => {
    expect(mergeHistoryStart(null, now)).toBe("2026-09-10T00:00:00.000Z");
    expect(mergeHistoryStart(since, now)).toBe("2026-09-10T00:00:00.000Z");
    expect(mergeHistoryStart("2026-09-01T00:00:00Z", now))
      .toBe("2026-09-01T00:00:00.000Z");
    expect(() => mergeHistoryStart("invalid", now)).toThrow("Invalid merge history timestamp");
    expect(() => mergeHistoryStart(null, "invalid")).toThrow("Invalid merge history timestamp");
  });

  it("collects historical merges for the report without notifying them in the inbox", async () => {
    const merged = await collectMergedPullRequests(
      repository, mergeHistoryStart(null, now), async () => [
        closed(1, { merged_at: "2026-09-12T00:00:00Z" }),
        closed(2),
        closed(3, { merged_at: "2026-09-09T00:00:00Z" }),
      ],
    );
    expect(merged.map((pull) => pull.number)).toEqual([1, 2]);
    const input = {
      current: [], comments: new Map(), generatedAt: now,
      defaultPlane: "management" as const, merged,
    };
    expect(buildReviewInbox({ ...input, previous: null }).items).toEqual([]);
    expect(buildReviewInbox({
      ...input, previous: { generatedAt: since, pullRequests: [] },
    }).items.map((item) => item.pullRequestNumber)).toEqual([2]);
  });

  it("only selects AutoPR merges after the previous refresh, not closures or old merges", async () => {
    const getPage = vi.fn().mockResolvedValue([
      closed(1),
      closed(2, { merged_at: null }),
      closed(3, { title: "Manual SDK PR" }),
      closed(4, { merged_at: since }),
      closed(5, { merged_at: "2020-01-01T00:00:00Z" }),
      closed(6, { title: "[autopr example]" }),
    ]);
    const merged = await collectMergedPullRequests(repository, since, getPage);
    expect(merged.map((pull) => pull.number)).toEqual([1]);
    expect(merged[0]).toMatchObject({
      plane: "management", headSha: "head", mergedAt: "2026-09-16T11:00:00Z",
    });
  });

  it("paginates past 100 recently updated PRs, deduplicates, and stops at the time boundary", async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, n) => closed(n + 1)))
      .mockResolvedValueOnce([
        closed(1),
        closed(101, { labels: [] }),
        ...Array.from({ length: 98 }, (_, n) => closed(n + 102, {
          merged_at: null, updated_at: "2026-09-15T00:00:00Z",
        })),
      ]);
    const merged = await collectMergedPullRequests(repository, since, getPage);
    expect(merged).toHaveLength(101);
    expect(merged.at(-1)?.plane).toBe("data");
    expect(getPage.mock.calls).toEqual([[1], [2]]);
  });

  it("does not invent historical activity without a previous snapshot", async () => {
    const getPage = vi.fn();
    expect(await collectMergedPullRequests(repository, null, getPage)).toEqual([]);
    expect(getPage).not.toHaveBeenCalled();
  });

  it("propagates a page failure instead of publishing incomplete merge activity", async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, n) => closed(n)))
      .mockRejectedValueOnce(new Error("API unavailable"));
    await expect(collectMergedPullRequests(repository, since, getPage))
      .rejects.toThrow("API unavailable");
  });

  it("notifies for PRs created and merged between refreshes and keeps them out of the open table", async () => {
    const merged = await collectMergedPullRequests(repository, since, async () => [closed(42)]);
    const inbox = buildReviewInbox({
      current: [],
      previous: { generatedAt: since, pullRequests: [] },
      comments: new Map(),
      generatedAt: now,
      defaultPlane: "management",
      merged,
    });
    expect(inbox.items).toEqual([{
      repository,
      pullRequestNumber: 42,
      reasons: ["merged"],
      activityAt: merged[0].mergedAt,
      comments: [],
    }]);
    const snapshot: DashboardSnapshot = {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      generatedAt: now,
      stale: false,
      source: { repository, fetchedAt: now, query: "" },
      inbox,
      pullRequests: [],
      mergedPullRequests: merged,
    };
    const html = renderToStaticMarkup(createElement(ReviewInbox, { snapshot }));
    expect(html).toContain("New activity");
    expect(html).toContain(">Merged</span>");
    expect(html).toContain(merged[0].url);
    expect(html).not.toContain("Needs attention");
    expect(renderToStaticMarkup(createElement(PrTable, {
      rows: snapshot.pullRequests, now: new Date(now),
    }))).not.toContain("#42");

    const next = buildReviewInbox({
      current: [], previous: { generatedAt: now, pullRequests: [] },
      comments: new Map(), generatedAt: "2026-09-18T00:00:00Z",
      defaultPlane: "management", merged,
    });
    expect(next.items).toEqual([]);
  });

  it("retains HoldOn exclusion and does not notify merges outside the window", async () => {
    const merged = await collectMergedPullRequests(repository, since, async () => [
      closed(1, { labels: [{ name: "HoldOn" }] }),
      closed(2, { merged_at: "2026-09-18T00:00:00Z" }),
    ]);
    const inbox = buildReviewInbox({
      current: [], previous: { generatedAt: since, pullRequests: [] },
      comments: new Map(), generatedAt: now, defaultPlane: "management", merged,
    });
    expect(inbox.items).toEqual([]);
  });
});
