import type { CheckRun } from "./collector-lib.ts";

export interface WorkflowRunInfo {
  id: number;
  workflow_id: number;
  head_sha: string;
  event: string;
  run_number: number;
  run_attempt: number;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function workflowRunId(repository: string, run: CheckRun): number | null {
  if (
    run.app?.slug !== "github-actions" ||
    !positiveInteger(run.app.id) ||
    !run.details_url
  ) {
    return null;
  }
  // Accept only the canonical Actions job URL for this repository, not arbitrary
  // check-provided links, redirects, credentials, or lookalike GitHub hosts.
  const match = run.details_url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/i,
  );
  if (
    !match ||
    match[1].toLowerCase() !== repository.toLowerCase() ||
    !positiveInteger(Number(match[2])) ||
    !positiveInteger(Number(match[3]))
  ) {
    return null;
  }
  return Number(match[2]);
}

/**
 * Select workflow executions, never jobs by name. Input should already use
 * GitHub's filter=latest so partial reruns retain untouched jobs in the suite.
 * Unidentifiable checks are retained; loader failures intentionally propagate.
 */
export async function selectCurrentCheckRuns(
  repository: string,
  headSha: string,
  runs: CheckRun[],
  loadRun: (id: number) => Promise<WorkflowRunInfo>,
): Promise<CheckRun[]> {
  const current = runs.filter((run) => run.head_sha === headSha);
  const metadata = new Map<number, WorkflowRunInfo>();
  const identities = new Map<CheckRun, { key: string; number: number }>();
  const latest = new Map<string, number>();

  for (const run of current) {
    const id = workflowRunId(repository, run);
    if (id === null) continue;
    let info = metadata.get(id);
    if (!info) {
      info = await loadRun(id);
      metadata.set(id, info);
    }
    // Incomplete or inconsistent identity cannot justify deleting a check.
    // In particular, pull_request_target metadata can refer to a base SHA.
    if (
      !info ||
      info.id !== id ||
      info.head_sha !== headSha ||
      !positiveInteger(info.workflow_id) ||
      !positiveInteger(info.run_number) ||
      !positiveInteger(info.run_attempt) ||
      typeof info.event !== "string" ||
      !info.event.trim()
    ) {
      continue;
    }
    const key = JSON.stringify([
      run.app!.id,
      run.app!.slug,
      info.workflow_id,
      info.event,
      info.head_sha,
    ]);
    identities.set(run, { key, number: info.run_number });
    latest.set(key, Math.max(latest.get(key) ?? 0, info.run_number));
  }

  // A rerun keeps its run ID/number. Keep all returned jobs across attempts:
  // selecting by attempt would erase successful jobs not rerun. Equal numbers
  // with different IDs are ambiguous, so retain both rather than guessing.
  return current.filter((run) => {
    const identity = identities.get(run);
    return !identity || identity.number === latest.get(identity.key);
  });
}
