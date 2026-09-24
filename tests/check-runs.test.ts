import { describe, expect, it, vi } from "vitest";
import {
  selectCurrentCheckRuns,
  type WorkflowRunInfo,
} from "../scripts/check-runs.ts";
import { summarizeChecks, type CheckRun } from "../scripts/collector-lib.ts";

const repository = "Azure/azure-sdk-for-js";
const headSha = "158c943cb8fd087a66691d4aae3b880f36f27cc8";

function check(
  id: number,
  workflowRun: number,
  overrides: Partial<CheckRun> = {},
): CheckRun {
  return {
    id,
    name: "agent",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    details_url: `https://github.com/${repository}/actions/runs/${workflowRun}/job/${id}`,
    external_id: null,
    app: { id: 15368, slug: "github-actions" },
    ...overrides,
  };
}

function workflow(
  id: number,
  run_number: number,
  overrides: Partial<WorkflowRunInfo> = {},
): WorkflowRunInfo {
  return {
    id,
    workflow_id: 247523117,
    head_sha: headSha,
    event: "pull_request_target",
    run_number,
    run_attempt: 1,
    ...overrides,
  };
}

function loader(...runs: WorkflowRunInfo[]) {
  return vi.fn(async (id: number) => {
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Missing workflow run ${id}`);
    return run;
  });
}

describe("selectCurrentCheckRuns", () => {
  it.each([
    [headSha, 92788981017, 31153711058, 92792231198, 31154785378],
    [
      "f57f7b9cd9da7c0b88fbe513690bcab85786d97e",
      94358691675,
      31672047402,
      94370673493,
      31675963512,
    ],
  ])("supersedes old agent failures on %s", async (sha, oldId, oldRun, newId, newRun) => {
    const old = check(oldId, oldRun, { head_sha: sha, conclusion: "failure" });
    const current = check(newId, newRun, { head_sha: sha });
    const load = loader(
      workflow(oldRun, 10, { head_sha: sha }),
      workflow(newRun, 11, { head_sha: sha }),
    );
    expect(
      await selectCurrentCheckRuns(repository, sha, [current, old], load),
    ).toEqual([current]);
  });

  it.each([
    ["in_progress", null, "pending", 0],
    ["queued", null, "pending", 0],
    ["completed", "cancelled", "cancelled", 0],
    ["completed", "failure", "complete", 1],
  ] as const)(
    "keeps the latest %s/%s execution regardless of its result",
    async (status, conclusion, qualification, failedCount) => {
      const old = check(1, 100, { conclusion: "failure" });
      const current = check(2, 200, { status, conclusion });
      const selected = await selectCurrentCheckRuns(
        repository,
        headSha,
        [old, current],
        loader(workflow(100, 1), workflow(200, 2)),
      );
      expect(selected).toEqual([current]);
      expect(summarizeChecks(headSha, selected, [])).toEqual({
        failedCount,
        qualification,
        observedCount: 1,
      });
    },
  );

  it("keeps unrelated same-name workflows and every job in the selected execution", async () => {
    const old = check(1, 100, { conclusion: "failure" });
    const independent = check(2, 300, { conclusion: "failure" });
    const first = check(3, 200);
    const second = check(4, 200, { conclusion: "failure" });
    const matrix = check(5, 200, { name: "test (linux, node22)" });
    const load = loader(
      workflow(100, 1),
      workflow(200, 2),
      workflow(300, 100, { workflow_id: 999 }),
    );
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, [old, independent, first, second, matrix], load,
      ),
    ).toEqual([independent, first, second, matrix]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("retains different events and apps, including non-Actions checks", async () => {
    const checks = [
      check(1, 100),
      check(2, 200),
      check(3, 300, { app: { id: 999, slug: "github-actions" } }),
      check(4, 400, { app: { id: 123, slug: "other-ci" } }),
      check(5, 500, { app: null }),
    ];
    const load = loader(
      workflow(100, 1),
      workflow(200, 2, { event: "pull_request" }),
      workflow(300, 3),
    );
    expect(
      await selectCurrentCheckRuns(repository, headSha, checks, load),
    ).toEqual(checks);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("preserves untouched jobs in a partial rerun of the current execution", async () => {
    const checks = [
      check(1, 100, { name: "test (windows)", conclusion: "failure" }),
      check(2, 200, { name: "test (linux)" }),
      check(3, 200, { name: "test (windows)" }),
      check(4, 200, { name: "agent" }),
      check(5, 200, { name: "agent", conclusion: "failure" }),
    ];
    const load = loader(
      workflow(100, 1, { run_attempt: 20 }),
      workflow(200, 2, { run_attempt: 2 }),
    );
    expect(
      await selectCurrentCheckRuns(repository, headSha, checks, load),
    ).toEqual(checks.slice(1));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("selects workflows even when their job names change", async () => {
    const old = check(1, 100, { name: "old job", conclusion: "failure" });
    const current = check(2, 200, { name: "new job" });
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, [old, current],
        loader(workflow(100, 1), workflow(200, 2)),
      ),
    ).toEqual([current]);
  });

  it("uses workflow run number rather than check ID, input order, or rerun attempt", async () => {
    const current = check(1, 100);
    const old = check(999, 200, { conclusion: "failure" });
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, [current, old],
        loader(workflow(100, 2), workflow(200, 1, { run_attempt: 10 })),
      ),
    ).toEqual([current]);
  });

  it("conservatively retains distinct IDs with equal workflow run numbers", async () => {
    const checks = [check(1, 100), check(2, 200, { conclusion: "failure" })];
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, checks,
        loader(workflow(100, 1), workflow(200, 1, { run_attempt: 2 })),
      ),
    ).toEqual(checks);
  });

  it("excludes foreign check SHAs without loading their metadata", async () => {
    const load = loader();
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, [check(1, 100, { head_sha: "foreign" })], load,
      ),
    ).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    null,
    "https://github.com/Azure/other/actions/runs/100/job/1",
    "https://github.com.evil.test/Azure/azure-sdk-for-js/actions/runs/100/job/1",
    "https://github.com@evil.test/Azure/azure-sdk-for-js/actions/runs/100/job/1",
    "http://github.com/Azure/azure-sdk-for-js/actions/runs/100/job/1",
    "https://github.com/Azure/azure-sdk-for-js/actions/runs/100",
    "https://github.com/Azure/azure-sdk-for-js/actions/runs/100/job/1?redirect=evil",
    "https://github.com/Azure/azure-sdk-for-js/actions/runs/9007199254740993/job/1",
    "https://github.com/Azure/azure-sdk-for-js/actions/runs/100/job/0",
  ])("retains checks with unverifiable URL %s", async (details_url) => {
    const unknown = check(1, 100, { details_url, conclusion: "failure" });
    const current = check(2, 200);
    const load = loader(workflow(200, 2));
    expect(
      await selectCurrentCheckRuns(repository, headSha, [unknown, current], load),
    ).toEqual([unknown, current]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(200);
  });

  it.each([
    { id: 999 },
    { head_sha: "base-sha" },
    { workflow_id: 0 },
    { event: "" },
    { run_number: 0 },
    { run_attempt: 0 },
    { workflow_id: undefined },
  ])("retains checks with unproven metadata identity %j", async (metadata) => {
    const checks = [check(1, 100, { conclusion: "failure" }), check(2, 200)];
    const load = vi.fn(async (id: number) =>
      id === 100 ? workflow(100, 1, metadata) : workflow(200, 2),
    );
    expect(
      await selectCurrentCheckRuns(
        repository, headSha, checks, load,
      ),
    ).toEqual(checks);
  });

  it("propagates metadata failures instead of returning a misleading healthy selection", async () => {
    const load = vi.fn(async (): Promise<WorkflowRunInfo> => {
      throw new Error("GitHub rate limit");
    });
    await expect(
      selectCurrentCheckRuns(repository, headSha, [check(1, 100)], load),
    ).rejects.toThrow("GitHub rate limit");
  });

  it("only caches lookups within one invocation", async () => {
    const checks = [check(1, 100), check(2, 100)];
    const load = loader(workflow(100, 1));
    await selectCurrentCheckRuns(repository, headSha, checks, load);
    await selectCurrentCheckRuns(repository, headSha, checks, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("matches repository identity case-insensitively and accepts job IDs distinct from check IDs", async () => {
    const current = check(9, 100, {
      details_url: "https://github.com/azure/AZURE-SDK-FOR-JS/actions/runs/100/job/123",
    });
    const load = loader(workflow(100, 1));
    expect(
      await selectCurrentCheckRuns(repository, headSha, [current], load),
    ).toEqual([current]);
    expect(load).toHaveBeenCalledWith(100);
  });
});
