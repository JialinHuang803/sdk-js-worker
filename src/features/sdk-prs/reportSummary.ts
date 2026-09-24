import type { DashboardSnapshot, Plane } from "../../data/contracts";

export interface PlaneReport {
  plane: Plane;
  open: number;
  awaitingReview: number;
  approved: number;
  approvedWithConflicts: number;
  recordedApprovalOnly: number;
  reviewUnknown: number;
  drafts: number;
  held: number;
  mergedLastWeek: number | null;
}

export function buildPlaneReports(snapshot: DashboardSnapshot): PlaneReport[] {
  const asOf = Date.parse(snapshot.generatedAt);
  const weekStart = asOf - 7 * 24 * 60 * 60 * 1_000;
  const window = snapshot.mergeHistoryWindow;
  const historyComplete = Number.isFinite(asOf) &&
    snapshot.mergedPullRequests !== undefined &&
    window !== undefined &&
    Date.parse(window.from) <= weekStart &&
    Date.parse(window.through) >= asOf;
  const planes: Plane[] = ["management", "data"];

  return planes.map((plane) => {
    const pulls = snapshot.pullRequests.filter((pull) => pull.plane === plane);
    const knownReviews = pulls.filter(
      (pull) => pull.completeness.reviews === "complete" &&
        pull.reviewDecision !== "unknown",
    );
    const approved = knownReviews.filter((pull) => pull.reviewDecision === "approved");
    const recentMerges = (snapshot.mergedPullRequests ?? []).filter(
      (pull) => pull.plane === plane &&
        Date.parse(pull.mergedAt) > weekStart &&
        Date.parse(pull.mergedAt) <= asOf,
    );
    return {
      plane,
      open: pulls.length,
      awaitingReview: knownReviews.filter(
        (pull) => pull.reviewDecision === "review-required",
      ).length,
      approved: approved.length,
      approvedWithConflicts: approved.filter((pull) => pull.conflicts === true).length,
      recordedApprovalOnly: pulls.filter((pull) =>
        pull.recordedApproval === true && !approved.includes(pull)).length,
      reviewUnknown: pulls.length - knownReviews.length,
      drafts: pulls.filter((pull) => pull.draft).length,
      held: pulls.filter((pull) => pull.holdOn).length,
      mergedLastWeek: historyComplete
        ? new Set(recentMerges.map((pull) => `${pull.repository}#${pull.number}`)).size
        : null,
    };
  });
}
