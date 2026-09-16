import { describe, expect, it } from "vitest";
import type { PullRequestRecord } from "../src/data/contracts";
import { getNextStep } from "../src/features/sdk-prs/nextStep";
import {
  filterPullRequests,
  type SdkPrFilters,
} from "../src/features/sdk-prs/useSdkPrFilters";

function pull(
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    repository: "Azure/azure-sdk-for-js",
    number: 1,
    url: "https://example.test/pull/1",
    title: "[AutoPR example]",
    draft: false,
    holdOn: false,
    plane: "data",
    headSha: "abc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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

describe("getNextStep", () => {
  it("prioritizes the HoldOn label over actionable states", () => {
    expect(
      getNextStep(
        pull({
          holdOn: true,
          reviewDecision: "review-required",
          conflicts: true,
        }),
      ),
    ).toMatchObject({ kind: "hold", label: "HoldOn" });
  });

  it("prioritizes resolution before required review", () => {
    expect(
      getNextStep(
        pull({
          reviewDecision: "review-required",
          checks: {
            failedCount: 2,
            qualification: "complete",
            observedCount: 4,
          },
        }),
      ),
    ).toMatchObject({ kind: "resolve", label: "Needs resolution" });
  });

  it("requests review after failures are resolved", () => {
    expect(
      getNextStep(pull({ reviewDecision: "review-required" })),
    ).toMatchObject({ kind: "review", label: "Review needed" });
  });

  it("does not claim merge readiness for incomplete signals", () => {
    expect(
      getNextStep(
        pull({
          reviewDecision: "unknown",
          completeness: {
            changedFiles: "complete",
            checks: "complete",
            metadata: "complete",
            reviews: "partial",
          },
        }),
      ),
    ).toMatchObject({ kind: "unknown", label: "Status unavailable" });
  });

  it("waits to merge only when every gate is clear", () => {
    expect(getNextStep(pull())).toMatchObject({
      kind: "merge",
      label: "Wait to merge",
    });
  });

  describe("filterPullRequests", () => {
    const filters: SdkPrFilters = {
      search: "",
      plane: "all",
      nextStep: "resolve",
      sort: "newest",
    };

    it("filters by the derived next step, including conflicts", () => {
      const conflicted = pull({ number: 1, conflicts: true });
      const reviewNeeded = pull({
        number: 2,
        reviewDecision: "review-required",
      });
      expect(filterPullRequests([conflicted, reviewNeeded], filters)).toEqual([
        conflicted,
      ]);
    });
  });
});
