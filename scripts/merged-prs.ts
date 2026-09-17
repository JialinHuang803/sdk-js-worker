import type { MergedPullRequestRecord } from "../src/data/contracts.ts";

export interface ClosedPull {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  merged_at: string | null;
  labels: Array<{ name: string }>;
  head: { sha: string };
}

export async function collectMergedPullRequests(
  repository: string,
  comparisonFrom: string | null,
  getPage: (page: number) => Promise<ClosedPull[]>,
): Promise<MergedPullRequestRecord[]> {
  if (comparisonFrom === null) return [];
  const since = Date.parse(comparisonFrom);
  if (!Number.isFinite(since)) throw new Error("Invalid merge comparison timestamp");
  const merged = new Map<number, MergedPullRequestRecord>();
  for (let page = 1; ; page += 1) {
    const pulls = await getPage(page);
    for (const pull of pulls) {
      if (
        !Number.isFinite(Date.parse(pull.updated_at)) ||
        (pull.merged_at !== null && !Number.isFinite(Date.parse(pull.merged_at)))
      ) {
        throw new Error(`Invalid merge timestamps for PR #${pull.number}`);
      }
      if (
        !pull.title.startsWith("[AutoPR") ||
        pull.merged_at === null ||
        Date.parse(pull.merged_at) <= since
      ) {
        continue;
      }
      merged.set(pull.number, {
        repository,
        number: pull.number,
        url: pull.html_url,
        title: pull.title,
        plane: pull.labels.some((label) => label.name.toLowerCase() === "mgmt")
          ? "management"
          : "data",
        holdOn: pull.labels.some((label) => label.name.toLowerCase() === "holdon"),
        headSha: pull.head.sha,
        mergedAt: pull.merged_at,
      });
    }
    // Pages are sorted by updated_at descending; merges always update the PR.
    if (
      pulls.length < 100 ||
      pulls.some((pull) => Date.parse(pull.updated_at) <= since)
    ) {
      break;
    }
  }
  return [...merged.values()];
}
