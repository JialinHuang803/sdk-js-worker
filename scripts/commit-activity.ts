import type { PullRequestRecord } from "../src/data/contracts.ts";
import { matchesAuthorPattern, type PreviousSnapshot } from "./inbox.ts";

export interface CommitComparison {
  status: string;
  total_commits: number;
  commits: Array<{
    sha: string;
    author: { login: string } | null;
  }>;
}

export async function hasOnlyExcludedCommits(
  patterns: string[],
  getPage: (page: number) => Promise<CommitComparison>,
): Promise<boolean> {
  if (patterns.length === 0) return false;
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page += 1) {
    const comparison = await getPage(page);
    // Rewinds or an empty comparison are not proof of an excluded-author update.
    if (comparison.status !== "ahead" && comparison.status !== "diverged") return false;
    if (!Number.isInteger(comparison.total_commits) || comparison.total_commits <= 0) return false;
    if (total !== undefined && total !== comparison.total_commits) {
      throw new Error("Commit comparison changed between pages");
    }
    total = comparison.total_commits;
    const before = seen.size;
    for (const commit of comparison.commits) {
      if (!commit.sha) throw new Error("Commit comparison is missing a SHA");
      seen.add(commit.sha);
      const login = commit.author?.login;
      if (!login || !patterns.some((pattern) => matchesAuthorPattern(login, pattern))) {
        return false;
      }
    }
    if (seen.size === total) return true;
    if (seen.size > total || seen.size === before || comparison.commits.length < 100) {
      throw new Error("Commit comparison is incomplete");
    }
  }
}

export async function collectCommitExclusions({
  current,
  previous,
  patterns,
  getComparisonPage,
}: {
  current: PullRequestRecord[];
  previous: PreviousSnapshot | null;
  patterns: string[];
  getComparisonPage: (
    pull: PullRequestRecord, previousHead: string, page: number,
  ) => Promise<CommitComparison>;
}): Promise<{ excluded: Set<number>; warnings: Map<number, string> }> {
  const excluded = new Set<number>();
  const warnings = new Map<number, string>();
  if (!previous || patterns.length === 0) return { excluded, warnings };
  const priorByNumber = new Map(previous.pullRequests.map((pull) => [pull.number, pull]));
  for (const pull of current) {
    const prior = priorByNumber.get(pull.number);
    if (!prior || prior.headSha === pull.headSha) continue;
    try {
      if (await hasOnlyExcludedCommits(
        patterns, (page) => getComparisonPage(pull, prior.headSha, page),
      )) excluded.add(pull.number);
    } catch {
      warnings.set(
        pull.number,
        "Commit authors could not be determined; new-commit activity was retained.",
      );
    }
  }
  return { excluded, warnings };
}
