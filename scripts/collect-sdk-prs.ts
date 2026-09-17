import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardSnapshot,
  type InboxCommentActivity,
  type PackageMetadata,
  type PullRequestRecord,
  type ReviewDecision,
} from "../src/data/contracts.ts";
import {
  extractReleasePlanUrl,
  isNamedAutoPrPackage,
  isReleasePackageChange,
  packageRootsFromFiles,
  parsePackageMetadata,
  summarizeChecks,
  type CheckRun,
  type CommitStatus,
} from "./collector-lib.ts";
import {
  buildReviewInbox,
  isExcludedCommentAuthor,
  loadDashboardConfig,
  type DashboardConfig,
  type PreviousSnapshot,
} from "./inbox.ts";
import { collectMergedPullRequests, mergeHistoryStart, type ClosedPull } from "./merged-prs.ts";
import { detectBreakingChanges } from "./changelog.ts";
import { collectCommitExclusions, type CommitComparison } from "./commit-activity.ts";

const repository = process.env.SOURCE_REPOSITORY ?? "Azure/azure-sdk-for-js";
const outputPath = resolve(
  process.env.DASHBOARD_OUTPUT ?? "public/data/sdk-prs.json",
);
const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
const graphqlUrl =
  process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
const previousSnapshotUrl =
  process.env.PREVIOUS_SNAPSHOT_URL ??
  "https://jialinhuang803.github.io/sdk-js-worker/data/sdk-prs.json";
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
  updated_at: string;
}

interface PullDetails extends PullListItem {
  html_url: string;
  body: string | null;
  draft: boolean;
  created_at: string;
  updated_at: string;
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

interface GitHubComment {
  id: number;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

interface GitHubReview {
  id: number;
  user: { login: string } | null;
  submitted_at: string | null;
  html_url: string;
  state: string;
  body: string | null;
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

async function loadPreviousSnapshot(): Promise<PreviousSnapshot | null> {
  const parse = (value: unknown): PreviousSnapshot | null => {
    if (!value || typeof value !== "object") return null;
    const snapshot = value as Partial<PreviousSnapshot>;
    return typeof snapshot.generatedAt === "string" &&
      Array.isArray(snapshot.pullRequests)
      ? {
          generatedAt: snapshot.generatedAt,
          pullRequests: snapshot.pullRequests,
        }
      : null;
  };
  try {
    const response = await fetch(previousSnapshotUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const remote = parse(await response.json());
      if (remote) return remote;
    }
  } catch {
    console.warn("The deployed snapshot could not be loaded as an activity baseline.");
  }
  try {
    return parse(JSON.parse(await readFile(outputPath, "utf8")));
  } catch {
    return null;
  }
}

function normalizeComment(
  comment: GitHubComment,
  kind: InboxCommentActivity["kind"],
  config: DashboardConfig,
): InboxCommentActivity | null {
  const author = comment.user?.login;
  if (
    !author ||
    isExcludedCommentAuthor(
      author,
      config.activity.excludedCommentAuthorPatterns,
    )
  ) {
    return null;
  }
  return {
    id: `${kind}:${comment.id}`,
    kind,
    author,
    createdAt: comment.created_at,
    url: comment.html_url,
  };
}

async function collectRecentComments(
  pulls: PullListItem[],
  comparisonFrom: string | null,
  config: DashboardConfig,
): Promise<Map<number, InboxCommentActivity[]>> {
  const commentsByPull = new Map<number, InboxCommentActivity[]>();
  if (!comparisonFrom) return commentsByPull;
  const candidates = pulls.filter(
    (pull) => Date.parse(pull.updated_at) > Date.parse(comparisonFrom),
  );
  const entries = await mapLimit(candidates, 3, async (pull) => {
    const since = encodeURIComponent(comparisonFrom);
    const [conversationComments, reviewComments, reviews] = await Promise.all([
      config.activity.includeConversationComments
        ? paginate<GitHubComment>(
            `/repos/${repository}/issues/${pull.number}/comments?since=${since}`,
          )
        : [],
      config.activity.includeReviewComments
        ? paginate<GitHubComment>(
            `/repos/${repository}/pulls/${pull.number}/comments?since=${since}`,
          )
        : [],
      config.activity.includeReviewSummaries
        ? paginate<GitHubReview>(
            `/repos/${repository}/pulls/${pull.number}/reviews`,
          )
        : [],
    ]);
    const normalized = [
      ...conversationComments.map((comment) =>
        normalizeComment(comment, "conversation", config),
      ),
      ...reviewComments.map((comment) =>
        normalizeComment(comment, "review-comment", config),
      ),
      ...reviews.flatMap((review) => {
        if (
          review.state === "APPROVED" ||
          !review.body?.trim() ||
          !review.submitted_at ||
          Date.parse(review.submitted_at) <= Date.parse(comparisonFrom)
        ) {
          return [];
        }
        return [
          normalizeComment(
            {
              id: review.id,
              user: review.user,
              created_at: review.submitted_at,
              html_url: review.html_url,
            },
            "review-summary",
            config,
          ),
        ];
      }),
    ]
      .filter((comment): comment is InboxCommentActivity => comment !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [pull.number, normalized] as const;
  });
  for (const [number, comments] of entries) {
    if (comments.length > 0) commentsByPull.set(number, comments);
  }
  return commentsByPull;
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

const fileCache = new Map<string, string | null>();

async function getTextFile(
  sourceRepository: string,
  path: string,
  sha: string,
): Promise<string | null> {
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
  const text = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  fileCache.set(key, text);
  return text;
}

async function getJsonFile(
  sourceRepository: string,
  path: string,
  sha: string,
): Promise<unknown | null> {
  const text = await getTextFile(sourceRepository, path, sha);
  return text === null ? null : JSON.parse(text);
}

async function collectBreakingChanges(
  pkg: PackageMetadata,
  pull: PullDetails,
): Promise<void> {
  pkg.breakingChanges = null;
  const headRepository = pull.head.repo?.full_name;
  if (!headRepository) return;
  // Most SDK packages use CHANGELOG.md; also support lowercase filenames.
  for (const filename of ["CHANGELOG.md", "changelog.md"]) {
    const path = `${pkg.root}/${filename}`;
    const head = await getTextFile(headRepository, path, pull.head.sha);
    if (head === null) continue;
    const base = await getTextFile(pull.base.repo.full_name, path, pull.base.sha) ??
      await getTextFile(
        pull.base.repo.full_name,
        `${pkg.root}/${filename === "CHANGELOG.md" ? "changelog.md" : "CHANGELOG.md"}`,
        pull.base.sha,
      );
    pkg.breakingChanges = detectBreakingChanges(head, base, pkg.version);
    pkg.changelogUrl = `https://github.com/${headRepository}/blob/${pull.head.sha}/${path}`;
    return;
  }
}

async function collectPackage(
  root: string,
  pull: PullDetails,
): Promise<{ metadata: PackageMetadata; isRelease: boolean }> {
  const headRepository = pull.head.repo?.full_name;
  if (!headRepository) {
    return {
      isRelease: false,
      metadata: {
        root,
        name: null,
        version: null,
        apiVersions: [],
        state: "missing",
        note: "Head repository is unavailable.",
      },
    };
  }
  const [packageJson, basePackage] = await Promise.all([
    getJsonFile(headRepository, `${root}/package.json`, pull.head.sha),
    getJsonFile(
      pull.base.repo.full_name,
      `${root}/package.json`,
      pull.base.sha,
    ),
  ]);
  if (!packageJson) {
    const baseMetadata = await getJsonFile(
      pull.base.repo.full_name,
      `${root}/metadata.json`,
      pull.base.sha,
    );
    if (basePackage) {
      return {
        isRelease: false,
        metadata: {
          ...parsePackageMetadata(root, basePackage, baseMetadata),
          state: "removed",
          note: "Package is removed or renamed by this pull request.",
        },
      };
    }
    return {
      isRelease: false,
      metadata: {
        root,
        name: null,
        version: null,
        apiVersions: [],
        state: "missing",
        note: "No package.json found at the pull request head.",
      },
    };
  }
  const metadataJson = await getJsonFile(
    headRepository,
    `${root}/metadata.json`,
    pull.head.sha,
  );
  const parsed = parsePackageMetadata(root, packageJson, metadataJson);
  return {
    isRelease:
      isReleasePackageChange(basePackage, packageJson) ||
      isNamedAutoPrPackage(pull.title, packageJson),
    metadata: metadataJson
      ? parsed
      : {
          ...parsed,
          state: "metadata-missing",
          note: "No metadata.json found at the pull request head.",
        },
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
      const collected = await collectPackage(root, pull);
      if (collected.isRelease) packages.push(collected.metadata);
    } catch {
      warnings.push(`Metadata unavailable for ${root}.`);
    }
  }
  if (roots.length === 0) warnings.push("No SDK package roots were identified.");
  if (roots.length > 0 && packages.length === 0) {
    warnings.push("No version-bumped SDK packages were identified.");
  }
  for (const pkg of packages) {
    try {
      await collectBreakingChanges(pkg, pull);
    } catch {
      pkg.breakingChanges = null;
      warnings.push(`Changelog could not be collected for ${pkg.root}.`);
    }
  }
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
    holdOn: pull.labels.some(
      (label) => label.name.toLowerCase() === "holdon",
    ),
    plane: pull.labels.some((label) => label.name.toLowerCase() === "mgmt")
      ? "management"
      : "data",
    headSha: pull.head.sha,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
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
  const config = await loadDashboardConfig();
  const previous = await loadPreviousSnapshot();
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
  const comments = await collectRecentComments(
    autoPulls,
    previous?.generatedAt ?? null,
    config,
  );
  const mergeHistoryFrom = mergeHistoryStart(
    previous?.generatedAt ?? null,
    new Date().toISOString(),
  );
  const mergedPullRequests = await collectMergedPullRequests(
    repository,
    mergeHistoryFrom,
    async (page) => (await request<ClosedPull[]>(
      `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    )).data,
  );
  const mergedNumbers = new Set(mergedPullRequests.map((pull) => pull.number));
  const openPullRequests = pullRequests.filter((pull) => !mergedNumbers.has(pull.number));
  const commitActivity = await collectCommitExclusions({
    current: openPullRequests,
    previous,
    patterns: config.activity.excludedCommitAuthorPatterns ?? [],
    getComparisonPage: async (pull, previousHead, page) =>
      (await request<CommitComparison>(
        `/repos/${pull.repository}/compare/${encodeURIComponent(previousHead)}...${encodeURIComponent(pull.headSha)}?per_page=100&page=${page}`,
      )).data,
  });
  for (const pull of openPullRequests) {
    const warning = commitActivity.warnings.get(pull.number);
    if (warning) {
      pull.warnings.push(warning);
      console.warn(`PR #${pull.number}: ${warning}`);
    }
  }
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
    inbox: buildReviewInbox({
      current: openPullRequests,
      previous,
      comments,
      generatedAt: fetchedAt,
      defaultPlane: config.inbox.defaultPlane,
      merged: mergedPullRequests,
      excludedCommitPulls: commitActivity.excluded,
    }),
    pullRequests: openPullRequests,
    mergedPullRequests,
    mergeHistoryWindow: { from: mergeHistoryFrom, through: fetchedAt },
  });
  console.log(`Collected ${openPullRequests.length} open AutoPRs and ${mergedPullRequests.length} recent merges from ${repository}.`);
}

main().catch(async (error: unknown) => {
  try {
    await preserveStaleSnapshot(error);
  } catch (fatal) {
    console.error(fatal instanceof Error ? fatal.message : fatal);
    process.exitCode = 1;
  }
});
