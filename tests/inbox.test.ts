import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";
import { PrTable } from "../src/features/sdk-prs/PrTable";
import { ReviewInbox } from "../src/features/sdk-prs/ReviewInbox";
import { collectCommitExclusions, type CommitComparison } from "../scripts/commit-activity";
import type {
  InboxCommentActivity,
  PullRequestRecord,
} from "../src/data/contracts";
import {
  buildReviewInbox,
  commentComparisonFrom,
  isExcludedCommentAuthor,
} from "../scripts/inbox";

function pull(
  number: number,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    repository: "Azure/azure-sdk-for-js",
    number,
    url: `https://example.test/pull/${number}`,
    title: `[AutoPR @azure-example-${number}]`,
    draft: false,
    holdOn: false,
    plane: "management",
    headSha: `head-${number}`,
    createdAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
    releasePlanUrl: null,
    reviewDecision: "approved",
    packages: [],
    checks: {
      failedCount: 0,
      qualification: "complete",
      observedCount: 1,
    },
    conflicts: false,
    completeness: {
      changedFiles: "complete",
      checks: "complete",
      metadata: "complete",
      reviews: "complete",
    },
    warnings: [],
    ...overrides,
  };
}

describe("breaking-change badges", () => {
  it.each([true, false, null, undefined])(
    "renders package and inbox badges only for confirmed changes (%s)",
    (breakingChanges) => {
      const now = "2026-09-17T00:00:00Z";
      const current = [pull(1, {
        reviewDecision: "review-required",
        packages: [{
          root: "sdk/example/example",
          name: "@azure/example",
          version: "2.0.0",
          state: "available",
          apiVersions: [],
          breakingChanges,
          changelogUrl: "https://example.test/head/CHANGELOG.md",
        }],
      })];
      const snapshot: DashboardSnapshot = {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        generatedAt: now,
        stale: false,
        source: { repository: current[0].repository, fetchedAt: now, query: "" },
        pullRequests: current,
        inbox: buildReviewInbox({
          current, previous: null, comments: new Map(),
          generatedAt: now, defaultPlane: "management",
        }),
      };
      const table = renderToStaticMarkup(createElement(PrTable, {
        rows: current, now: new Date(now),
      }));
      const inbox = renderToStaticMarkup(createElement(ReviewInbox, { snapshot }));
      expect(table.includes(">Breaking change</span>")).toBe(breakingChanges === true);
      expect(inbox.includes(">Breaking change</span>")).toBe(breakingChanges === true);
      expect(table.includes("https://example.test/head/CHANGELOG.md")).toBe(breakingChanges === true);
      expect(table.includes("Breaking-change status unavailable")).toBe(breakingChanges === null);
    },
  );
});

describe("comment author exclusion", () => {
  const patterns = [
    "JialinHuang803",
    "kazrael2119",
    "github-actions*",
    "azure-pipelines*",
    "*copilot*",
  ];

  it("matches exact and wildcard patterns case-insensitively", () => {
    expect(isExcludedCommentAuthor("jialinhuang803", patterns)).toBe(true);
    expect(isExcludedCommentAuthor("github-actions[bot]", patterns)).toBe(true);
    expect(isExcludedCommentAuthor("azure-pipelines[bot]", patterns)).toBe(true);
    expect(isExcludedCommentAuthor("copilot-pull-request-reviewer", patterns)).toBe(
      true,
    );
    expect(isExcludedCommentAuthor("service-team-user", patterns)).toBe(false);
  });
});

describe("draft inbox visibility", () => {
  function snapshot(current: PullRequestRecord[]): DashboardSnapshot {
    const now = "2026-09-18T00:00:00Z";
    return {
      schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: now, stale: false,
      source: { repository: current[0].repository, fetchedAt: now, query: "" },
      pullRequests: current,
      inbox: buildReviewInbox({
        current, previous: null, comments: new Map(),
        generatedAt: now, defaultPlane: current[0].plane,
      }),
    };
  }

  it.each(["management", "data"] as const)(
    "hides draft review/CI attention and excludes it from the %s tab count",
    (plane) => {
      const current = [
        pull(39501, {
          plane, draft: true, reviewDecision: "review-required",
          checks: { failedCount: 2, qualification: "complete", observedCount: 3 },
        }),
        pull(2, { plane, reviewDecision: "review-required" }),
        pull(3, {
          plane: plane === "management" ? "data" : "management",
          draft: true, reviewDecision: "review-required",
        }),
      ];
      const data = snapshot(current);
      const html = renderToStaticMarkup(createElement(ReviewInbox, { snapshot: data }));
      expect(html).not.toContain("#39501");
      expect(html).not.toContain("#3");
      expect(html).toContain("#2");
      expect(html).toContain("Needs attention");
      expect(html).toContain(`${plane === "management" ? "Management" : "Data plane"} <span>1</span>`);
      expect(html).toContain(`${plane === "management" ? "Data plane" : "Management"} <span>0</span>`);
      expect(data.inbox.items).toHaveLength(3);
      expect(renderToStaticMarkup(createElement(PrTable, {
        rows: current, now: new Date(data.generatedAt),
      }))).toContain("#39501");
    },
  );

  it.each(["new-pr", "new-commit", "new-comment"] as const)(
    "retains %s activity for drafts without duplicating attention",
    (reason) => {
      const data = snapshot([pull(39501, { draft: true, reviewDecision: "review-required" })]);
      data.inbox.items[0].reasons.unshift(reason);
      const html = renderToStaticMarkup(createElement(ReviewInbox, { snapshot: data }));
      expect(html).toContain("New activity");
      expect(html).toContain("#39501");
      expect(html).toContain("Management <span>1</span>");
      expect(html).not.toContain("Needs attention");
    },
  );

  it("shows the empty state when only draft attention remains", () => {
    const data = snapshot([pull(39501, { draft: true, reviewDecision: "review-required" })]);
    const html = renderToStaticMarkup(createElement(ReviewInbox, { snapshot: data }));
    expect(html).toContain("No SDK-team attention is needed");
    expect(html).toContain("Management <span>0</span>");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("New activity");
  });
});

describe("HoldOn comment recovery", () => {
  const now = new Date("2026-09-22T01:00:00Z");
  it("only widens the comment window for explicitly requested HoldOn recovery", () => {
    const recent = "2026-09-21T22:00:00Z";
    expect(commentComparisonFrom(recent, true, true, now)).toBe("2026-09-21T01:00:00.000Z");
    expect(commentComparisonFrom(recent, true, false, now)).toBe(recent);
    expect(commentComparisonFrom(recent, false, true, now)).toBe(recent);
    expect(commentComparisonFrom("2026-09-19T00:00:00Z", true, true, now))
      .toBe("2026-09-19T00:00:00.000Z");
  });
});

describe("buildReviewInbox", () => {
  it("excludes only new-commit activity while keeping other reasons and the new baseline SHA", async () => {
    const current = [pull(1, {
      headSha: "new-head", reviewDecision: "review-required", holdOn: true,
      checks: { failedCount: 2, qualification: "complete", observedCount: 3 },
    }), pull(2, { headSha: "mixed-head" }), pull(3, { headSha: "unreachable-head" })];
    const previous = {
      generatedAt: "2026-09-15T00:07:00Z",
      pullRequests: [pull(1), pull(2), pull(3)],
    };
    const comparison = async (pr: PullRequestRecord): Promise<CommitComparison> => {
      if (pr.number === 3) throw new Error("Previous SHA unreachable");
      return {
        status: "ahead", total_commits: 1,
        commits: [{ sha: pr.headSha, author: { login: pr.number === 1 ? "kazrael2119" : "service-team" } }],
      };
    };
    const result = await collectCommitExclusions({
      current, previous, patterns: ["kazrael2119"], getComparisonPage: comparison,
    });
    expect([...result.excluded]).toEqual([1]);
    expect(result.warnings.get(3)).toContain("activity was retained");
    const inbox = buildReviewInbox({
      current, previous,
      comments: new Map([[1, [{
        id: "conversation:1", kind: "conversation", author: "service-team",
        createdAt: "2026-09-16T00:05:00Z", url: "https://example.test/comment/1",
      }]]]),
      generatedAt: "2026-09-16T00:07:00Z", defaultPlane: "management",
      excludedCommitPulls: result.excluded,
    });
    expect(inbox.items.find((item) => item.pullRequestNumber === 1)?.reasons)
      .toEqual(["new-comment", "review-needed", "ci-failure"]);
    expect(inbox.items.find((item) => item.pullRequestNumber === 2)?.reasons).toEqual(["new-commit"]);
    expect(inbox.items.find((item) => item.pullRequestNumber === 3)?.reasons).toEqual(["new-commit"]);
    expect(current[0].headSha).toBe("new-head");
    const nextComparison = async (): Promise<CommitComparison> => {
      throw new Error("Unchanged heads should not be compared");
    };
    expect(await collectCommitExclusions({
      current, previous: { generatedAt: inbox.generatedAt, pullRequests: current },
      patterns: ["kazrael2119"], getComparisonPage: nextComparison,
    })).toEqual({ excluded: new Set(), warnings: new Map() });
  });

  it("keeps new PRs and skips attribution only for baseline or unchanged PRs", async () => {
    let requests = 0;
    const getComparisonPage = async (): Promise<CommitComparison> => {
      requests += 1;
      throw new Error("Unexpected comparison");
    };
    const current = [pull(1), pull(2, { holdOn: true }), pull(3, { holdOn: true })];
    const previous = { generatedAt: "2026-09-15T00:07:00Z", pullRequests: [pull(1), pull(3)] };
    for (const baseline of [null, previous]) {
      const result = await collectCommitExclusions({
        current, previous: baseline, patterns: ["kazrael2119"], getComparisonPage,
      });
      expect(result.excluded.size).toBe(0);
    }
    expect(requests).toBe(0);
    const inbox = buildReviewInbox({
      current, previous, comments: new Map(), generatedAt: "2026-09-16T00:07:00Z",
      defaultPlane: "management", excludedCommitPulls: new Set([2]),
    });
    expect(inbox.items.map((item) => [item.pullRequestNumber, item.reasons])).toEqual([[2, ["new-pr"]]]);
  });

  it("includes activity and attention for PRs carrying the HoldOn label", () => {
    const inbox = buildReviewInbox({
      current: [
        pull(1, {
          holdOn: true,
          reviewDecision: "review-required",
          checks: {
            failedCount: 2,
            qualification: "complete",
            observedCount: 3,
          },
        }),
      ],
      previous: { generatedAt: "2026-09-15T00:00:00Z", pullRequests: [pull(1, { headSha: "old" })] },
      comments: new Map([[1, [{
        id: "conversation:1", kind: "conversation", author: "service-team",
        createdAt: "2026-09-16T00:00:00Z", url: "https://example.test/comment/1",
      }]]]),
      generatedAt: "2026-09-16T00:07:00Z",
      defaultPlane: "management",
    });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].reasons).toEqual(["new-commit", "new-comment", "review-needed", "ci-failure"]);
  });

  it("combines activity and persistent attention without duplicating PRs", () => {
    const current = [
      pull(1, {
        headSha: "new-head",
        reviewDecision: "review-required",
        checks: {
          failedCount: 2,
          qualification: "complete",
          observedCount: 3,
        },
      }),
    ];
    const comment: InboxCommentActivity = {
      id: "conversation:1",
      kind: "conversation",
      author: "service-team-user",
      createdAt: "2026-09-16T00:05:00Z",
      url: "https://example.test/comment/1",
    };
    const inbox = buildReviewInbox({
      current,
      previous: {
        generatedAt: "2026-09-15T00:07:00Z",
        pullRequests: [pull(1, { headSha: "old-head" })],
      },
      comments: new Map([[1, [comment]]]),
      generatedAt: "2026-09-16T00:07:00Z",
      defaultPlane: "management",
    });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].reasons).toEqual([
      "new-commit",
      "new-comment",
      "review-needed",
      "ci-failure",
    ]);
  });

  it("does not label existing PRs new when establishing a baseline", () => {
    const inbox = buildReviewInbox({
      current: [pull(1, { reviewDecision: "review-required" })],
      previous: null,
      comments: new Map(),
      generatedAt: "2026-09-16T00:07:00Z",
      defaultPlane: "management",
    });
    expect(inbox.baselineAvailable).toBe(false);
    expect(inbox.items[0].reasons).toEqual(["review-needed"]);
  });
});
