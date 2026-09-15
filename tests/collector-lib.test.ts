import { describe, expect, it } from "vitest";
import {
  extractReleasePlanUrl,
  isNamedAutoPrPackage,
  isReleasePackageChange,
  packageRootsFromFiles,
  parsePackageMetadata,
  summarizeChecks,
  type CheckRun,
  type CommitStatus,
} from "../scripts/collector-lib.ts";

describe("extractReleasePlanUrl", () => {
  it("extracts markdown and bare release-plan URLs", () => {
    expect(
      extractReleasePlanUrl(
        "**Release plan link:** [plan](https://example.test/?releaseplan=36517)",
      ),
    ).toBe("https://example.test/?releaseplan=36517");
    expect(
      extractReleasePlanUrl("**Release plan:**\nhttps://example.test/plan/12"),
    ).toBe("https://example.test/plan/12");
    expect(
      extractReleasePlanUrl(
        "Source: https://github.com/Azure/specs **Release plan link:** [https://plans.example.test/?releaseplan=36517](https://plans.example.test/?releaseplan=36517) **Submitted by:** person@example.test",
      ),
    ).toBe("https://plans.example.test/?releaseplan=36517");
    expect(
      extractReleasePlanUrl(
        "Pipeline: https://dev.azure.com/example Release information: https://azsdk-releaseplan-dashboard-hveph5aqhhcfhtgu.westus-01.azurewebsites.net/?releaseplan=36401",
      ),
    ).toBe(
      "https://azsdk-releaseplan-dashboard-hveph5aqhhcfhtgu.westus-01.azurewebsites.net/?releaseplan=36401",
    );
  });

  it("does not collect unrelated links", () => {
    expect(extractReleasePlanUrl("Documentation: https://example.test")).toBeNull();
  });
});

describe("packageRootsFromFiles", () => {
  it("finds unchanged package roots and both sides of renames", () => {
    expect(
      packageRootsFromFiles([
        { filename: "sdk/iothub/arm-iothub/src/generated/client.ts" },
        {
          filename: "sdk/new/new-package/package.json",
          previous_filename: "sdk/old/old-package/package.json",
        },
        { filename: "eng/pipelines/templates/jobs.yml" },
      ]),
    ).toEqual([
      "sdk/iothub/arm-iothub",
      "sdk/new/new-package",
      "sdk/old/old-package",
    ]);
  });
});

describe("isReleasePackageChange", () => {
  it("includes version bumps and new packages", () => {
    expect(
      isReleasePackageChange(
        { name: "@azure/arm-storage", version: "20.1.1" },
        { name: "@azure/arm-storage", version: "20.2.0" },
      ),
    ).toBe(true);
    expect(
      isReleasePackageChange(null, {
        name: "@azure/new-package",
        version: "1.0.0",
      }),
    ).toBe(true);
  });

  it("excludes incidental edits without a version change", () => {
    expect(
      isReleasePackageChange(
        { name: "@azure/arm-eventhub", version: "6.0.0" },
        { name: "@azure/arm-eventhub", version: "6.0.0" },
      ),
    ).toBe(false);
  });
});

describe("isNamedAutoPrPackage", () => {
  it("matches canonical package names without including incidental packages", () => {
    const title =
      "[AutoPR @azure-arm-storage]-generated-from-SDK Generation - JS-6764466";
    expect(
      isNamedAutoPrPackage(title, {
        name: "@azure/arm-storage",
        version: "20.2.0",
      }),
    ).toBe(true);
    expect(
      isNamedAutoPrPackage(title, {
        name: "@azure/arm-eventhub",
        version: "6.0.0",
      }),
    ).toBe(false);
  });

  it("supports scoped Azure REST package names", () => {
    expect(
      isNamedAutoPrPackage(
        "[AutoPR @azure-rest-ai-content-safety]-generated-from-SDK Generation",
        { name: "@azure-rest/ai-content-safety", version: "1.0.3" },
      ),
    ).toBe(true);
  });
});

describe("parsePackageMetadata", () => {
  it("normalizes scalar and multiple API versions", () => {
    expect(
      parsePackageMetadata(
        "sdk/example/pkg",
        { name: "@azure/example", version: "2.0.0" },
        {
          apiVersions: {
            "Azure.Example": "2026-01-01",
            "Azure.Other": ["2025-01-01", "2026-01-01-preview"],
          },
        },
      ),
    ).toMatchObject({
      name: "@azure/example",
      version: "2.0.0",
      apiVersions: [
        { namespace: "Azure.Example", versions: ["2026-01-01"] },
        {
          namespace: "Azure.Other",
          versions: ["2025-01-01", "2026-01-01-preview"],
        },
      ],
    });
  });
});

describe("summarizeChecks", () => {
  const run = (partial: Partial<CheckRun>): CheckRun => ({
    id: 1,
    name: "test",
    head_sha: "head",
    status: "completed",
    conclusion: "success",
    details_url: null,
    external_id: null,
    app: { id: 1, slug: "actions" },
    ...partial,
  });
  const status = (partial: Partial<CommitStatus>): CommitStatus => ({
    id: 1,
    context: "Azure Pipelines",
    state: "success",
    target_url: null,
    creator: { id: 2, login: "azure-pipelines" },
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  });

  it("counts current failures and keeps independent generic check runs", () => {
    expect(
      summarizeChecks(
        "head",
        [
          run({ id: 1, name: "Analyze", conclusion: "failure" }),
          run({ id: 2, name: "Analyze", conclusion: "failure" }),
          run({ id: 3, head_sha: "test-merge", conclusion: "failure" }),
        ],
        [],
      ),
    ).toEqual({ failedCount: 2, qualification: "complete", observedCount: 2 });
  });

  it("keeps only the latest retry for a commit status identity", () => {
    expect(
      summarizeChecks(
        "head",
        [],
        [
          status({ id: 1, state: "failure", updated_at: "2026-01-01T00:00:00Z" }),
          status({ id: 2, state: "success", updated_at: "2026-01-02T00:00:00Z" }),
        ],
      ),
    ).toEqual({ failedCount: 0, qualification: "complete", observedCount: 1 });
  });

  it("qualifies zero without claiming all checks passed", () => {
    expect(summarizeChecks("head", [], [])).toEqual({
      failedCount: 0,
      qualification: "no-checks",
      observedCount: 0,
    });
    expect(
      summarizeChecks("head", [run({ status: "in_progress", conclusion: null })], []),
    ).toMatchObject({ failedCount: 0, qualification: "pending" });
    expect(
      summarizeChecks("head", [], [status({ state: "pending" })]),
    ).toMatchObject({ failedCount: 0, qualification: "pending" });
  });
});
