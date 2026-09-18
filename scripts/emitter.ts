import type {
  EmitterIssue,
  EmitterPullRequest,
  EmitterSnapshot,
} from "../src/data/emitter-contracts.ts";
import { parseSpectorReport } from "./spector.ts";
import { collectEmitterActivity, type EmitterActivityOptions } from "./emitter-activity.ts";

export const EMITTER_REPOSITORY = "Azure/typespec-azure";
export const EMITTER_LABEL = "emitter:typescript";
export const EMITTER_PACKAGE = "@azure-tools/typespec-ts";

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  assignees: { login: string }[];
  labels: { name: string }[];
  comments: number;
  pull_request?: { url: string };
  draft?: boolean;
}

export async function collectEmitter(
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  registry = "https://registry.npmjs.org",
  activityOptions?: EmitterActivityOptions,
): Promise<EmitterSnapshot> {
  const generatedAt = now().toISOString();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sdk-js-worker-emitter-collector",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const issues: EmitterIssue[] = [];
  const pullRequests: EmitterPullRequest[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page++) {
    // The issues endpoint includes both issues and PRs, without Search's 1,000-item limit.
    const url = `https://api.github.com/repos/${EMITTER_REPOSITORY}/issues?state=open&labels=${encodeURIComponent(EMITTER_LABEL)}&sort=created&direction=asc&per_page=100&page=${page}`;
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Emitter GitHub collection failed: HTTP ${response.status}`);
    }
    const entries: GitHubIssue[] = await response.json();
    for (const entry of entries) {
      if (seen.has(entry.number)) continue;
      seen.add(entry.number);
      const record: EmitterIssue = {
        number: entry.number,
        title: entry.title,
        url: entry.html_url,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        author: entry.user?.login ?? null,
        assignees: entry.assignees.map((user) => user.login),
        labels: entry.labels.map((label) => label.name),
        comments: entry.comments,
      };
      if (entry.pull_request) {
        if (typeof entry.draft !== "boolean") {
          throw new Error(`Missing draft state for emitter PR ${entry.number}`);
        }
        pullRequests.push({ ...record, draft: entry.draft });
      } else {
        issues.push(record);
      }
    }
    if (!response.headers.get("link")?.includes('rel="next"') && entries.length < 100) {
      break;
    }
  }

  async function get(path: string): Promise<Response> {
    const response = await fetcher(`https://api.github.com/repos/${EMITTER_REPOSITORY}${path}`, {
      headers, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Emitter activity lookup failed (${path.split("?")[0]}): HTTP ${response.status}`);
    return response;
  }
  if (activityOptions) {
    for (let index = pullRequests.length - 1; index >= 0; index--) {
      const pull = pullRequests[index];
      const detail: {
        state: string; draft: boolean; head: { sha: string };
        requested_reviewers: { login: string }[]; requested_teams: { slug: string }[];
      } = await (await get(`/pulls/${pull.number}`)).json();
      if (detail.state === "closed") {
        pullRequests.splice(index, 1);
        continue;
      }
      if (detail.state !== "open" || typeof detail.draft !== "boolean" ||
        !detail.head?.sha || !Array.isArray(detail.requested_reviewers) ||
        !Array.isArray(detail.requested_teams) ||
        !detail.requested_reviewers.every((reviewer) => typeof reviewer.login === "string" && reviewer.login.length > 0) ||
        !detail.requested_teams.every((team) => typeof team.slug === "string" && team.slug.length > 0)) {
        throw new Error(`Incomplete emitter review state for PR ${pull.number}`);
      }
      pull.draft = detail.draft;
      pull.headSha = detail.head.sha;
      pull.requestedReviewers = detail.requested_reviewers.map((reviewer) => reviewer.login);
      pull.requestedTeams = detail.requested_teams.map((team) => team.slug);
    }
  }

  // Never send the GitHub credential to the public npm registry.
  const response = await fetcher(
    `${registry.replace(/\/$/, "")}/${encodeURIComponent(EMITTER_PACKAGE)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    throw new Error(`Emitter package lookup failed: HTTP ${response.status}`);
  }
  const metadata: {
    name: string;
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, { name: string; version: string }>;
    time?: Record<string, string>;
  } = await response.json();
  const version = metadata["dist-tags"]?.latest;
  if (
    !version ||
    metadata.name !== EMITTER_PACKAGE ||
    metadata.versions?.[version]?.version !== version ||
    metadata.versions[version].name !== EMITTER_PACKAGE
  ) {
    throw new Error("Emitter npm latest tag does not resolve to a published package version");
  }
  const publishedAt = metadata.time?.[version] ?? null;
  const reportResponse = await fetcher(
    `https://api.github.com/repos/${EMITTER_REPOSITORY}/issues/5313`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!reportResponse.ok) {
    throw new Error(`Spector report lookup failed: HTTP ${reportResponse.status}`);
  }
  const report: { body: string; updated_at: string } = await reportResponse.json();
  const coverage = parseSpectorReport(report.body, report.updated_at);
  const snapshot: EmitterSnapshot = {
    schemaVersion: 1,
    generatedAt,
    source: { repository: EMITTER_REPOSITORY, label: EMITTER_LABEL, fetchedAt: generatedAt },
    package: {
      name: EMITTER_PACKAGE,
      version,
      publishedAt,
      url: `https://www.npmjs.com/package/${EMITTER_PACKAGE}/v/${version}`,
    },
    issues,
    pullRequests,
    coverage,
  };
  if (activityOptions) await collectEmitterActivity(snapshot, activityOptions, get);
  return snapshot;
}
