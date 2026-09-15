import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSnapshot,
  type PackageMetadata,
  type PullRequestRecord,
  type ReviewDecision,
} from "../src/data/contracts.ts";
import {
  extractReleasePlanUrl,
  packageRootsFromFiles,
  parsePackageMetadata,
  summarizeChecks,
  type CheckRun,
  type CommitStatus,
} from "./collector-lib.ts";

const repository = process.env.SOURCE_REPOSITORY ?? "Azure/azure-sdk-for-js";
const outputPath = resolve(
  process.env.DASHBOARD_OUTPUT ?? "public/data/sdk-prs.json",
);
const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
const graphqlUrl =
  process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "sdk-js-worker-collector",
};
if (token) headers.Authorization = `Bearer ${token}`;

interface PullListItem {
  number: number;
  title: string;
}

interface PullDetails extends PullListItem {
  html_url: string;
  body: string | null;
  draft: boolean;
  created_at: string;
  changed_files: number;
  mergeable: boolean | null;
  labels: Array<{ name: string }>;
  head: {
    sha: string;
    repo: { full_name: string } | null;
  };
  base: {
    sha: string;
    repo: { full_name: string };
  };
}

interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "changed" | "modified" | "removed" | "renamed";
}

interface CheckRunsResponse {
  total_count: number;
  check_runs: CheckRun[];
}

interface ReviewDecisionResult {
  decisions: Map<number, ReviewDecision>;
  complete: boolean;
}

async function request<T>(path: string): Promise<{
  data: T;
  headers: Headers;
}> {
  const response = await fetch(`${apiRoot}${path}`, { headers });
  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    throw new Error(
      `GitHub API ${response.status} for ${path}${requestId ? ` (${requestId})` : ""}`,
    );
  }
  return { data: (await response.json()) as T, headers: response.headers };
}

async function collectReviewDecisions(
  pulls: PullListItem[],
): Promise<ReviewDecisionResult> {
  if (!token) {
    console.warn(
      "Review decisions require GITHUB_TOKEN or GH_TOKEN; marking them unknown.",
    );
    return {
      decisions: new Map(pulls.map((pull) => [pull.number, "unknown"])),
      complete: false,
    };
  }
  const [owner, name] = repository.split("/");
  const fields = pulls
    .map(
      (pull) =>
        `pr${pull.number}: pullRequest(number: ${pull.number}) { reviewDecision }`,
    )
    .join("\n");
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          ${fields}
        }
      }`,
      variables: { owner, name },
    }),
  });
  if (!response.ok) {
    console.warn(
      `Review decision query failed (${response.status}); marking reviews unknown.`,
    );
    return {
      decisions: new Map(pulls.map((pull) => [pull.number, "unknown"])),
      complete: false,
    };
  }
  const payload = (await response.json()) as {
    data?: {
      repository?: Record<
        string,
        {
          reviewDecision:
            | "APPROVED"
            | "CHANGES_REQUESTED"
            | "REVIEW_REQUIRED"
            | null;
        }
      >;
    };
    errors?: unknown[];
  };
  const decisions = new Map<number, ReviewDecision>();
  for (const pull of pulls) {
    const value = payload.data?.repository?.[`pr${pull.number}`]?.reviewDecision;
    decisions.set(
      pull.number,
      value === "APPROVED"
        ? "approved"
        : value === "CHANGES_REQUESTED"
          ? "changes-requested"
          : value === "REVIEW_REQUIRED"
            ? "review-required"
            : value === null
              ? "not-required"
              : "unknown",
    );
  }
  return {
    decisions,
    complete:
      (payload.errors?.length ?? 0) === 0 &&
      [...decisions.values()].every((value) => value !== "unknown"),
  };
}

async function paginate<T>(path: string): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const results: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request<T[]>(
      `${path}${separator}per_page=100&page=${page}`,
    );
    results.push(...response.data);
    if (!hasNext(response.headers) && response.data.length < 100) break;
  }
  return results;
}

function hasNext(responseHeaders: Headers): boolean {
  return responseHeaders.get("link")?.includes('rel="next"') ?? false;
}

async function collectChangedFiles(
  pullNumber: number,
  expectedCount: number,
): Promise<{ files: ChangedFile[]; partial: boolean }> {
  const files = await paginate<ChangedFile>(
    `/repos/${repository}/pulls/${pullNumber}/files`,
  );
  // GitHub caps this endpoint at 3,000 files even when the PR reports more.
  return {
    files,
    partial: files.length < expectedCount || (files.length === 3000 && expectedCount >= 3000),
  };
}

async function collectCheckRuns(sha: string): Promise<CheckRun[]> {
  const all: CheckRun[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request<CheckRunsResponse>(
      `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
    );
    all.push(...response.data.check_runs);
    if (!hasNext(response.headers) && response.data.check_runs.length < 100) break;
  }
  return all;
}

const fileCache = new Map<string, unknown | null>();

async function getJsonFile(
  sourceRepository: string,
  path: string,
  sha: string,
): Promise<unknown | null> {
  const key = `${sourceRepository}@${sha}:${path}`;
  if (fileCache.has(key)) return fileCache.get(key) ?? null;
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(
    `${apiRoot}/repos/${sourceRepository}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`,
    { headers },
  );
  if (response.status === 404) {
    fileCache.set(key, null);
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} reading ${path} at ${sha}`);
  }
  const payload = (await response.json()) as {
    content?: string;
    encoding?: string;
  };
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`Unexpected content response for ${path} at ${sha}`);
  }
  const parsed: unknown = JSON.parse(
    Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8"),
  );
  fileCache.set(key, parsed);
  return parsed;
}

async function collectPackage(
  root: string,
  pull: PullDetails,
): Promise<PackageMetadata> {
  const headRepository = pull.head.repo?.full_name;
  if (!headRepository) {
    return {
      root,
      name: null,
      version: null,
      apiVersions: [],
      state: "missing",
      note: "Head repository is unavailable.",
    };
  }
  const packageJson = await getJsonFile(
    headRepository,
    `${root}/package.json`,
    pull.head.sha,
  );
  if (!packageJson) {
    const basePackage = await getJsonFile(
      pull.base.repo.full_name,
      `${root}/package.json`,
      pull.base.sha,
    );
    const baseMetadata = await getJsonFile(
      pull.base.repo.full_name,
      `${root}/metadata.json`,
      pull.base.sha,
    );
    if (basePackage) {
      return {
        ...parsePackageMetadata(root, basePackage, baseMetadata),
        state: "removed",
        note: "Package is removed or renamed by this pull request.",
      };
    }
    return {
      root,
      name: null,
      version: null,
      apiVersions: [],
      state: "missing",
      note: "No package.json found at the pull request head.",
    };
  }
  const metadataJson = await getJsonFile(
    headRepository,
    `${root}/metadata.json`,
    pull.head.sha,
  );
  const parsed = parsePackageMetadata(root, packageJson, metadataJson);
  return metadataJson
    ? parsed
    : {
        ...parsed,
        state: "metadata-missing",
        note: "No metadata.json found at the pull request head.",
      };
}

async function collectPull(
  pullItem: PullListItem,
  reviewDecision: ReviewDecision,
  reviewsComplete: boolean,
): Promise<PullRequestRecord> {
  const pull = (
    await request<PullDetails>(`/repos/${repository}/pulls/${pullItem.number}`)
  ).data;
  const warnings: string[] = [];
  const changed = await collectChangedFiles(pull.number, pull.changed_files);
  if (changed.partial) {
    warnings.push(
      `Changed files are incomplete (${changed.files.length} of ${pull.changed_files}).`,
    );
  }
  const roots = packageRootsFromFiles(changed.files);
  const packages: PackageMetadata[] = [];
  for (const root of roots) {
    try {
      packages.push(await collectPackage(root, pull));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown metadata error";
      packages.push({
        root,
        name: null,
        version: null,
        apiVersions: [],
        state: "missing",
        note: message,
      });
      warnings.push(`Metadata unavailable for ${root}.`);
    }
  }
  if (roots.length === 0) warnings.push("No SDK package roots were identified.");
  if (!reviewsComplete || reviewDecision === "unknown") {
    warnings.push("Required review status could not be collected.");
  }

  let checks: PullRequestRecord["checks"];
  let checksComplete = true;
  try {
    const [checkRuns, statuses] = await Promise.all([
      collectCheckRuns(pull.head.sha),
      paginate<CommitStatus>(
        `/repos/${repository}/commits/${pull.head.sha}/statuses`,
      ),
    ]);
    checks = summarizeChecks(pull.head.sha, checkRuns, statuses);
  } catch {
    checks = { failedCount: null, qualification: "partial", observedCount: 0 };
    checksComplete = false;
    warnings.push("Check results could not be collected completely.");
  }

  return {
    repository,
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    draft: pull.draft,
    plane: pull.labels.some((label) => label.name.toLowerCase() === "mgmt")
      ? "management"
      : "data",
    headSha: pull.head.sha,
    createdAt: pull.created_at,
    releasePlanUrl: extractReleasePlanUrl(pull.body),
    reviewDecision,
    packages,
    checks,
    conflicts: pull.mergeable === null ? null : !pull.mergeable,
    completeness: {
      changedFiles: changed.partial ? "partial" : "complete",
      checks: checksComplete ? "complete" : "partial",
      metadata: packages.some(
        (pkg) => pkg.state === "missing" || pkg.state === "metadata-missing",
      )
        ? "partial"
        : "complete",
      reviews:
        reviewsComplete && reviewDecision !== "unknown" ? "complete" : "partial",
    },
    warnings,
  };
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await work(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function writeSnapshot(snapshot: DashboardSnapshot) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function preserveStaleSnapshot(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown collection failure";
  try {
    const prior = JSON.parse(await readFile(outputPath, "utf8")) as DashboardSnapshot;
    await writeSnapshot({
      ...prior,
      stale: true,
      collectionError: message,
    });
  } catch {
    // There is no valid prior snapshot to preserve. The original failure remains fatal.
  }
  throw error;
}

async function main() {
  const pulls = await paginate<PullListItem>(
    `/repos/${repository}/pulls?state=open&sort=updated&direction=desc`,
  );
  const autoPulls = pulls.filter((pull) => pull.title.startsWith("[AutoPR"));
  const reviewDecisions = await collectReviewDecisions(autoPulls);
  const pullRequests = await mapLimit(autoPulls, 4, (pull) =>
    collectPull(
      pull,
      reviewDecisions.decisions.get(pull.number) ?? "unknown",
      reviewDecisions.complete,
    ),
  );
  const fetchedAt = new Date().toISOString();
  await writeSnapshot({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: fetchedAt,
    stale: false,
    source: {
      repository,
      query: "state:open title-prefix:[AutoPR",
      fetchedAt,
    },
    pullRequests,
  });
  console.log(`Collected ${pullRequests.length} AutoPRs from ${repository}.`);
}

main().catch(async (error: unknown) => {
  try {
    await preserveStaleSnapshot(error);
  } catch (fatal) {
    console.error(fatal instanceof Error ? fatal.message : fatal);
    process.exitCode = 1;
  }
});
