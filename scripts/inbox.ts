import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  InboxCommentActivity,
  InboxReason,
  Plane,
  PullRequestRecord,
  ReviewInbox,
} from "../src/data/contracts.ts";

export interface DashboardConfig {
  schemaVersion: 1;
  activity: {
    excludedCommentAuthorPatterns: string[];
    includeConversationComments: boolean;
    includeReviewComments: boolean;
    includeReviewSummaries: boolean;
    publishCommentBody: false;
  };
  inbox: {
    defaultPlane: Plane;
  };
}

export interface PreviousSnapshot {
  generatedAt: string;
  pullRequests: PullRequestRecord[];
}

export async function loadDashboardConfig(): Promise<DashboardConfig> {
  const path = resolve(
    process.env.DASHBOARD_CONFIG ?? ".github/dashboard-config.json",
  );
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isDashboardConfig(value)) {
    throw new Error(`Invalid dashboard configuration at ${path}`);
  }
  return value;
}

export function matchesAuthorPattern(author: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const expression = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(expression, "i").test(author);
}

export function isExcludedCommentAuthor(
  author: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => matchesAuthorPattern(author, pattern));
}

export function buildReviewInbox({
  current,
  previous,
  comments,
  generatedAt,
  defaultPlane,
}: {
  current: PullRequestRecord[];
  previous: PreviousSnapshot | null;
  comments: Map<number, InboxCommentActivity[]>;
  generatedAt: string;
  defaultPlane: Plane;
}): ReviewInbox {
  const previousByNumber = new Map(
    (previous?.pullRequests ?? []).map((pull) => [pull.number, pull]),
  );
  const items = current.flatMap((pull) => {
    if (pull.holdOn) return [];
    const prior = previousByNumber.get(pull.number);
    const pullComments = comments.get(pull.number) ?? [];
    const reasons: InboxReason[] = [];

    if (previous) {
      if (!prior) reasons.push("new-pr");
      else if (prior.headSha !== pull.headSha) reasons.push("new-commit");
      if (pullComments.length > 0) reasons.push("new-comment");
    }
    if (pull.reviewDecision === "review-required") {
      reasons.push("review-needed");
    }
    if ((pull.checks.failedCount ?? 0) > 0) reasons.push("ci-failure");
    if (reasons.length === 0) return [];

    const activityTimes = [
      pull.updatedAt,
      ...pullComments.map((comment) => comment.createdAt),
    ];
    return [
      {
        repository: pull.repository,
        pullRequestNumber: pull.number,
        reasons,
        activityAt: activityTimes.sort().at(-1) ?? generatedAt,
        comments: pullComments,
      },
    ];
  });

  return {
    comparisonFrom: previous?.generatedAt ?? null,
    generatedAt,
    baselineAvailable: previous !== null,
    defaultPlane,
    items,
  };
}

function isDashboardConfig(value: unknown): value is DashboardConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<DashboardConfig>;
  return (
    config.schemaVersion === 1 &&
    Array.isArray(config.activity?.excludedCommentAuthorPatterns) &&
    config.activity.excludedCommentAuthorPatterns.every(
      (pattern) => typeof pattern === "string" && pattern.length > 0,
    ) &&
    typeof config.activity.includeConversationComments === "boolean" &&
    typeof config.activity.includeReviewComments === "boolean" &&
    typeof config.activity.includeReviewSummaries === "boolean" &&
    config.activity.publishCommentBody === false &&
    (config.inbox?.defaultPlane === "management" ||
      config.inbox?.defaultPlane === "data")
  );
}
