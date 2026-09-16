import { describe, expect, it } from "vitest";
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

describe("comment author exclusion", () => {
  const patterns = [
    "JialinHuang803",
    "kazrael2119",
    "github-actions*",
    "*copilot*",
  ];

  it("matches exact and wildcard patterns case-insensitively", () => {
    expect(isExcludedCommentAuthor("jialinhuang803", patterns)).toBe(true);
    expect(isExcludedCommentAuthor("github-actions[bot]", patterns)).toBe(true);
    expect(isExcludedCommentAuthor("copilot-pull-request-reviewer", patterns)).toBe(
      true,
    );
    expect(isExcludedCommentAuthor("service-team-user", patterns)).toBe(false);
  });
});

describe("buildReviewInbox", () => {
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
