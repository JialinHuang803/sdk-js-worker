import type { PullRequestRecord } from "../../data/contracts";

export type NextStepKind =
  | "draft"
  | "resolve"
  | "review"
  | "waiting"
  | "unknown"
  | "merge";

export interface NextStep {
  kind: NextStepKind;
  label: string;
  detail: string;
}

export function getNextStep(pr: PullRequestRecord): NextStep {
  if (pr.draft) {
    return {
      kind: "draft",
      label: "Draft in progress",
      detail: "Mark ready for review when authoring is complete.",
    };
  }

  const failures = pr.checks.failedCount ?? 0;
  if (
    failures > 0 ||
    pr.conflicts === true ||
    pr.reviewDecision === "changes-requested" ||
    pr.checks.qualification === "cancelled"
  ) {
    const reasons = [
      failures > 0
        ? `${failures} failed check${failures === 1 ? "" : "s"}`
        : null,
      pr.conflicts === true ? "merge conflicts" : null,
      pr.reviewDecision === "changes-requested" ? "changes requested" : null,
      pr.checks.qualification === "cancelled" ? "cancelled checks" : null,
    ].filter((reason): reason is string => reason !== null);
    return {
      kind: "resolve",
      label: "Needs resolution",
      detail: reasons.join(" · "),
    };
  }

  if (pr.reviewDecision === "review-required") {
    return {
      kind: "review",
      label: "Review needed",
      detail: "A qualifying approval is still required.",
    };
  }

  if (pr.checks.qualification === "pending") {
    return {
      kind: "waiting",
      label: "Waiting for checks",
      detail: "One or more checks are still running.",
    };
  }

  if (
    pr.checks.failedCount === null ||
    pr.conflicts === null ||
    pr.reviewDecision === "unknown" ||
    pr.checks.qualification === "no-checks" ||
    pr.checks.qualification === "partial" ||
    pr.checks.qualification === "unknown" ||
    pr.completeness.checks === "partial" ||
    pr.completeness.reviews === "partial"
  ) {
    return {
      kind: "unknown",
      label: "Status unavailable",
      detail: "Required merge signals are incomplete.",
    };
  }

  return {
    kind: "merge",
    label: "Wait to merge",
    detail:
      pr.reviewDecision === "approved"
        ? "Approved with no reported blockers."
        : "No approval requirement or reported blockers.",
  };
}
