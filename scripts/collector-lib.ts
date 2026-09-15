import type {
  ApiVersion,
  CheckQualification,
  PackageMetadata,
} from "../src/data/contracts.ts";

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending";
  conclusion:
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "skipped"
    | "stale"
    | "startup_failure"
    | "success"
    | "timed_out"
    | null;
  details_url: string | null;
  external_id: string | null;
  app: { id: number; slug: string | null } | null;
}

export interface CommitStatus {
  id: number;
  context: string;
  state: "error" | "failure" | "pending" | "success";
  target_url: string | null;
  creator: { id: number; login: string } | null;
  updated_at: string;
}

export interface CheckSummary {
  failedCount: number;
  qualification: CheckQualification;
  observedCount: number;
}

const failedConclusions = new Set([
  "action_required",
  "failure",
  "startup_failure",
  "timed_out",
]);

export function summarizeChecks(
  headSha: string,
  checkRuns: CheckRun[],
  statuses: CommitStatus[],
): CheckSummary {
  // GitHub's check-runs endpoint is requested with filter=latest. Preserve each
  // returned run because generic names may represent independent workflow jobs.
  const currentRuns = checkRuns.filter((run) => run.head_sha === headSha);
  const latestStatuses = new Map<string, CommitStatus>();
  for (const status of statuses) {
    const identity = `${status.creator?.id ?? "unknown"}:${status.context}`;
    const previous = latestStatuses.get(identity);
    if (!previous || Date.parse(status.updated_at) > Date.parse(previous.updated_at)) {
      latestStatuses.set(identity, status);
    }
  }
  const currentStatuses = [...latestStatuses.values()];
  const failedCount =
    currentRuns.filter(
      (run) => run.conclusion && failedConclusions.has(run.conclusion),
    ).length +
    currentStatuses.filter(
      (status) => status.state === "failure" || status.state === "error",
    ).length;
  const pending =
    currentRuns.some((run) => run.status !== "completed") ||
    currentStatuses.some((status) => status.state === "pending");
  const cancelled = currentRuns.some(
    (run) => run.conclusion === "cancelled" || run.conclusion === "stale",
  );
  const observedCount = currentRuns.length + currentStatuses.length;
  const qualification: CheckQualification =
    observedCount === 0
      ? "no-checks"
      : pending
        ? "pending"
        : cancelled
          ? "cancelled"
          : "complete";
  return { failedCount, qualification, observedCount };
}

export function extractReleasePlanUrl(body: string | null): string | null {
  if (!body) return null;
  const knownDashboardUrl =
    /https:\/\/azsdk-releaseplan-dashboard-hveph5aqhhcfhtgu\.westus-01\.azurewebsites\.net\/[^\s<>)\]"']*/i;
  const knownMatch = body.match(knownDashboardUrl);
  if (knownMatch) return knownMatch[0].replace(/[.,;:]+$/, "");

  const lines = body.split(/\r?\n/);
  const label = /release[\s_-]*plan(?:\s+link)?/i;
  const url = /https:\/\/[^\s<>)\]"']+/i;
  for (let index = 0; index < lines.length; index += 1) {
    const labelMatch = label.exec(lines[index]);
    if (!labelMatch) continue;
    const nearby = [
      lines[index].slice(labelMatch.index + labelMatch[0].length),
      ...lines.slice(index + 1, index + 3),
    ].join(" ");
    const urlMatch = nearby.match(url);
    if (urlMatch) return urlMatch[0].replace(/[.,;:]+$/, "");
  }
  return null;
}

export function packageRootsFromFiles(
  files: Array<{ filename: string; previous_filename?: string }>,
): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename]) {
      if (!path) continue;
      const parts = path.split("/");
      if (parts[0] === "sdk" && parts.length >= 4) {
        roots.add(parts.slice(0, 3).join("/"));
      }
    }
  }
  return [...roots].sort();
}

export function isReleasePackageChange(
  basePackageJson: unknown,
  headPackageJson: unknown,
): boolean {
  const headVersion = asRecord(headPackageJson)?.version;
  if (typeof headVersion !== "string") return false;
  const baseVersion = asRecord(basePackageJson)?.version;
  return typeof baseVersion !== "string" || baseVersion !== headVersion;
}

export function isNamedAutoPrPackage(
  title: string,
  packageJson: unknown,
): boolean {
  const token = title.match(/^\[AutoPR\s+([^\]]+)\]/)?.[1];
  const packageName = asRecord(packageJson)?.name;
  return (
    typeof token === "string" &&
    typeof packageName === "string" &&
    token === packageName.replace("/", "-")
  );
}

export function parsePackageMetadata(
  root: string,
  packageJson: unknown,
  metadataJson: unknown,
): PackageMetadata {
  const pkg = asRecord(packageJson);
  const metadata = asRecord(metadataJson);
  const rawVersions = asRecord(metadata?.apiVersions);
  const apiVersions: ApiVersion[] = Object.entries(rawVersions ?? {})
    .flatMap(([namespace, rawValue]) => {
      const versions = Array.isArray(rawValue)
        ? rawValue.filter((value): value is string => typeof value === "string")
        : typeof rawValue === "string"
          ? [rawValue]
          : [];
      return versions.length > 0 ? [{ namespace, versions }] : [];
    })
    .sort((left, right) => left.namespace.localeCompare(right.namespace));
  return {
    root,
    name: typeof pkg?.name === "string" ? pkg.name : null,
    version: typeof pkg?.version === "string" ? pkg.version : null,
    apiVersions,
    state: "available",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
