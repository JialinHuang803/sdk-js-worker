import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";
import { PrTable } from "../src/features/sdk-prs/PrTable";
import { ReviewInbox } from "../src/features/sdk-prs/ReviewInbox";
import type {
  InboxCommentActivity,
  PullRequestRecord,
} from "../src/data/contracts";
import {
  buildReviewInbox,
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

describe("buildReviewInbox", () => {
  it("excludes PRs carrying the HoldOn label", () => {
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
      previous: null,
      comments: new Map(),
      generatedAt: "2026-09-16T00:07:00Z",
      defaultPlane: "management",
    });
    expect(inbox.items).toEqual([]);
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
