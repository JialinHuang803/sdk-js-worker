import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { DashboardSnapshot } from "../src/data/contracts";

it("collects current workflow results, recorded approval and recomputed conflicts end to end", async () => {
  const repository = "Azure/azure-sdk-for-js";
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const date = "2026-09-24T00:00:00Z";
  let detailRequests = 0;
  const workflow = (id: number) => ({
    id, workflow_id: 10, head_sha: head, event: "pull_request_target",
    run_number: id, run_attempt: 1, created_at: `2026-09-24T00:0${id}:00Z`,
  });
  const checks = [1, 2].map((id) => ({
    id, name: "agent", head_sha: head, status: "completed",
    conclusion: id === 1 ? "failure" : "success",
    details_url: `https://github.com/${repository}/actions/runs/${id}/job/${id}`,
    external_id: null, app: { id: 1, slug: "github-actions" },
  }));
  const pull = {
    number: 39365, title: "[AutoPR @azure-arm-servicebus]", updated_at: date,
    created_at: date, html_url: `https://github.com/${repository}/pull/39365`,
    body: null, draft: false, changed_files: 1, state: "open", merged_at: null,
    labels: [{ name: "Mgmt" }], head: { sha: head, repo: { full_name: repository } },
    base: { sha: base, repo: { full_name: repository } },
  };
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const path = url.pathname.replace(`/repos/${repository}`, "");
    let result: unknown;
    if (path === "/graphql") {
      result = { data: { repository: { pr39365: { reviewDecision: null, headRefOid: head } } } };
    } else if (path === "/baseline") {
      result = { generatedAt: date, pullRequests: [{ number: 39365, headSha: head }] };
    } else if (path === "/pulls") {
      result = url.searchParams.get("state") === "open" ? [pull] : [];
    } else if (path === "/pulls/39365") {
      result = { ...pull, mergeable: ++detailRequests === 1 ? null : false };
    } else if (path === "/pulls/39365/files") {
      result = [{ filename: "sdk/servicebus/arm-servicebus/src/index.ts", status: "modified" }];
    } else if (path === "/pulls/39365/reviews") {
      result = [{ id: 1, user: { id: 1 }, state: "APPROVED", commit_id: head, submitted_at: date }];
    } else if (path.endsWith("/check-runs")) {
      result = { total_count: checks.length, check_runs: checks };
    } else if (path.endsWith("/statuses")) {
      result = [];
    } else if (path === "/actions/runs") {
      result = { total_count: 2, workflow_runs: [workflow(2), workflow(1)] };
    } else if (path.endsWith("/package.json")) {
      result = { name: "@azure/arm-servicebus", version: url.searchParams.get("ref") === base ? "7.0.0" : "8.0.0-beta.1" };
    } else if (path.endsWith("/metadata.json")) {
      result = { apiVersions: { "Microsoft.ServiceBus": "2026-07-01-preview" } };
    } else if (path.endsWith("/CHANGELOG.md")) {
      response.end("## 8.0.0-beta.1\n\n### Breaking Changes\n- Updated signature.\n");
      return;
    } else {
      unexpected.push(request.url!);
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "sdk-status-test-"));
  const output = join(directory, "snapshot.json");
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/collect-sdk-prs.ts"], {
      env: {
        ...process.env, GITHUB_TOKEN: "test-only", GH_TOKEN: "", SOURCE_REPOSITORY: repository,
        GITHUB_API_URL: origin, GITHUB_GRAPHQL_URL: `${origin}/graphql`,
        PREVIOUS_SNAPSHOT_URL: `${origin}/baseline`, DASHBOARD_OUTPUT: output,
        ACTIVITY_API_URL: "", RECOVER_HOLDON_COMMENTS: "false",
      },
      timeout: 20_000,
    });
    const snapshot = JSON.parse(await readFile(output, "utf8")) as DashboardSnapshot;
    expect(unexpected).toEqual([]);
    expect(detailRequests).toBe(2);
    expect(snapshot.pullRequests[0]).toMatchObject({
      reviewDecision: "unknown", recordedApproval: true, conflicts: true,
      checks: { failedCount: 0, qualification: "complete", observedCount: 1 },
    });
    expect(snapshot.inbox.items).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
