import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSnapshot,
  type MergedPullRequestRecord,
  type PullRequestRecord,
} from "../src/data/contracts";
import { buildPlaneReports } from "../src/features/sdk-prs/reportSummary";
import { SdkPrReport } from "../src/features/sdk-prs/SdkPrReport";
import { PrTable } from "../src/features/sdk-prs/PrTable";
import { attentionEntries } from "../src/features/sdk-prs/sharedActivity";

const now = "2026-09-17T20:00:00Z";
const weekStart = "2026-09-10T20:00:00Z";
const repository = "Azure/azure-sdk-for-js";

function pull(number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repository, number, url: `https://example.test/pull/${number}`,
    title: "[AutoPR example]", draft: false, holdOn: false, plane: "management",
    headSha: "head", createdAt: now, updatedAt: now, releasePlanUrl: null,
    reviewDecision: "approved", packages: [],
    checks: { failedCount: 0, qualification: "complete", observedCount: 1 },
    conflicts: false,
    completeness: {
      changedFiles: "complete", checks: "complete", metadata: "complete", reviews: "complete",
    },
    warnings: [],
    ...overrides,
  };
}

function merged(number: number, overrides: Partial<MergedPullRequestRecord> = {}): MergedPullRequestRecord {
  return {
    repository, number, url: `https://example.test/pull/${number}`,
    title: "[AutoPR example]", plane: "management", holdOn: false,
    headSha: "head", mergedAt: "2026-09-15T20:00:00Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: now, stale: false,
    source: { repository, fetchedAt: now, query: "" },
    inbox: {
      comparisonFrom: "2026-09-16T20:00:00Z", generatedAt: now,
      baselineAvailable: true, defaultPlane: "management", items: [],
    },
    pullRequests: [],
    mergedPullRequests: [],
    mergeHistoryWindow: { from: weekStart, through: now },
    ...overrides,
  };
}

describe("per-plane delivery report", () => {
  it("counts required reviews and approvals independently of prioritized next steps", () => {
    const data = snapshot({
      pullRequests: [
        pull(1, { reviewDecision: "review-required", conflicts: true }),
        pull(2, { reviewDecision: "review-required", draft: true, holdOn: true }),
        pull(3, { conflicts: true, checks: { failedCount: 2, qualification: "complete", observedCount: 2 } }),
        pull(4, { draft: true, holdOn: true }),
        pull(5, { reviewDecision: "not-required" }),
        pull(6, { reviewDecision: "changes-requested" }),
        pull(7, { plane: "data", reviewDecision: "review-required" }),
        pull(8, { plane: "data", conflicts: true }),
      ],
    });
    expect(buildPlaneReports(data)).toEqual([
      { plane: "management", open: 6, awaitingReview: 2, approved: 2, approvedWithConflicts: 1,
        recordedApprovalOnly: 0, reviewUnknown: 0, drafts: 2, held: 2, mergedLastWeek: 0 },
      { plane: "data", open: 2, awaitingReview: 1, approved: 1, approvedWithConflicts: 1,
        recordedApprovalOnly: 0, reviewUnknown: 0, drafts: 0, held: 0, mergedLastWeek: 0 },
    ]);
  });

  it("shows recorded approvals without claiming unknown requirements are satisfied", () => {
    const data = snapshot({ pullRequests: [
      pull(39365, { reviewDecision: "unknown", recordedApproval: true, conflicts: true }),
      pull(39565, { recordedApproval: true }),
    ] });
    expect(buildPlaneReports(data)[0]).toMatchObject({
      approved: 1, recordedApprovalOnly: 1, reviewUnknown: 1,
    });
    const report = renderToStaticMarkup(createElement(SdkPrReport, { snapshot: data }));
    expect(report).toContain("1 additional PR with an approval recorded");
    const table = renderToStaticMarkup(createElement(PrTable, { rows: data.pullRequests, now: new Date(now) }));
    expect(table).toContain(">Approval recorded</span>");
    expect(table).toContain(">Approved</span>");
    expect(table).toContain(">Conflicts</span>");
    expect(table).toContain("Wait to merge");
    expect(table).not.toContain("1 failed");
    expect(attentionEntries(data)).toEqual([]);
  });

  it("qualifies unknown or partial review states instead of treating them as zero work", () => {
    const data = snapshot({ pullRequests: [
      pull(1, { reviewDecision: "unknown" }),
      pull(2, { completeness: {
        changedFiles: "complete", checks: "complete", metadata: "complete", reviews: "partial",
      } }),
    ] });
    expect(buildPlaneReports(data)[0]).toMatchObject({ approved: 0, awaitingReview: 0, reviewUnknown: 2 });
    const html = renderToStaticMarkup(createElement(SdkPrReport, { snapshot: data }));
    expect(html).toContain("No PRs are confirmed as waiting");
    expect(html).toContain("No open PRs are confirmed as approved");
    expect(html).toContain("Review status is unavailable for 2 PRs");
    data.pullRequests.push(pull(3), pull(4, { reviewDecision: "review-required" }));
    const known = renderToStaticMarkup(createElement(SdkPrReport, { snapshot: data }));
    expect(known).toContain("At least 1 approved PR");
    expect(known).toContain("At least 1 PR");
  });

  it("counts a rolling seven-day window at the snapshot time, not the inbox window", () => {
    const data = snapshot({ mergedPullRequests: [
      merged(1), merged(1),
      merged(2, { mergedAt: weekStart }),
      merged(3, { mergedAt: "2026-09-10T20:00:01Z", holdOn: true }),
      merged(4, { mergedAt: now }),
      merged(5, { mergedAt: "2026-09-17T20:00:01Z" }),
      merged(6, { plane: "data" }),
      merged(1, { repository: "example/another-repo" }),
    ] });
    expect(buildPlaneReports(data).map((report) => report.mergedLastWeek)).toEqual([4, 1]);
    expect(buildPlaneReports({ ...data, stale: true })).toEqual(buildPlaneReports(data));
  });

  it.each([
    { mergeHistoryWindow: undefined },
    { mergedPullRequests: undefined },
    { mergeHistoryWindow: { from: "2026-09-16T00:00:00Z", through: now } },
    { mergeHistoryWindow: { from: weekStart, through: "2026-09-16T00:00:00Z" } },
    { mergeHistoryWindow: { from: "invalid", through: now } },
  ])("does not infer zero merges from missing or incomplete history: %j", (overrides) => {
    const data = snapshot(overrides);
    expect(buildPlaneReports(data).map((report) => report.mergedLastWeek)).toEqual([null, null]);
    const html = renderToStaticMarkup(createElement(SdkPrReport, { snapshot: data }));
    expect(html).toContain("merge history are not available");
    expect(html).not.toContain("No AutoPRs merged");
  });

  it("renders readable plane blocks with approvals, conflicts, and weekly delivery", () => {
    const data = snapshot({
      pullRequests: [pull(1, { conflicts: true }), pull(2, { reviewDecision: "review-required" })],
      mergedPullRequests: [merged(3)],
    });
    const html = renderToStaticMarkup(createElement(SdkPrReport, { snapshot: data }));
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain("Management plane");
    expect(html).toContain("Data plane");
    expect(html).toContain("2 open AutoPRs");
    expect(html).toContain("1 PR</strong> is waiting for required approval");
    expect(html).toContain("1 approved PR</strong> is still open, awaiting service-team action");
    expect(html).toContain("Including 1 with merge conflicts to resolve");
    expect(html).toContain("1 AutoPR merged</strong> in the past 7 days");
    expect(html).toContain("No open AutoPRs right now");
    expect(html).toContain("No AutoPRs merged in the past 7 days");
    expect(html).toContain("independent of table filters");
  });
});
