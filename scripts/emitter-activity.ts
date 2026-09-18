import type { EmitterActivity, EmitterSnapshot } from "../src/data/emitter-contracts.ts";
import { isExcludedCommentAuthor, type DashboardConfig } from "./inbox.ts";

export interface EmitterActivityOptions {
  previous: EmitterSnapshot | null;
  comments: DashboardConfig["activity"];
  excludedIssueNumbers: number[];
}

interface GitHubComment {
  id: number;
  user: { login: string } | null;
  html_url: string;
  created_at?: string;
  submitted_at?: string | null;
  state?: string;
  body?: string | null;
}

export async function collectEmitterActivity(
  snapshot: EmitterSnapshot,
  options: EmitterActivityOptions,
  get: (path: string) => Promise<Response>,
): Promise<void> {
  // Old inventory-only snapshots are not an activity baseline.
  const previous = options.previous?.activity ? options.previous : null;
  if (previous && (previous.source.repository !== snapshot.source.repository ||
    previous.source.label !== snapshot.source.label ||
    Date.parse(previous.generatedAt) >= Date.parse(snapshot.generatedAt))) {
    throw new Error("Emitter activity baseline is incompatible or newer than this collection");
  }
  const from = previous?.generatedAt ?? null;
  const events: EmitterActivity[] = [];
  snapshot.activity = { comparisonFrom: from, events, excludedIssueNumbers: options.excludedIssueNumbers };
  if (!from) return;
  const inWindow = (timestamp: string) =>
    Date.parse(timestamp) > Date.parse(from) && Date.parse(timestamp) <= Date.parse(snapshot.generatedAt);
  const priorPulls = new Map(previous!.pullRequests.map((pull) => [pull.number, pull]));
  const currentPulls = new Map(snapshot.pullRequests.map((pull) => [pull.number, pull]));
  const excluded = new Set(options.excludedIssueNumbers);
  const seen = new Set<string>();

  async function comments(number: number, kind: string, path: string, reviews = false) {
    for (let page = 1; ; page++) {
      const response = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const entries: GitHubComment[] = await response.json();
      if (!Array.isArray(entries)) throw new Error("Invalid emitter comment response");
      for (const comment of entries) {
        const timestamp = reviews ? comment.submitted_at : comment.created_at;
        if (reviews && (!["COMMENTED", "CHANGES_REQUESTED"].includes(comment.state ?? "") ||
          !comment.body?.trim())) continue;
        if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
          throw new Error(`Missing emitter comment timestamp on #${number}`);
        }
        if (!inWindow(timestamp)) continue;
        // A deleted account cannot reliably match configured author exclusions.
        const author = comment.user?.login ?? "deleted-user";
        if (isExcludedCommentAuthor(author, options.comments.excludedCommentAuthorPatterns)) continue;
        if (!Number.isSafeInteger(comment.id) || comment.id <= 0) throw new Error("Invalid emitter comment ID");
        const id = `${kind}:${number}:${comment.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        events.push({ id, number, kind: "new-comment", occurredAt: timestamp, url: comment.html_url, author });
      }
      if (!response.headers.get("link")?.includes('rel="next"') && entries.length < 100) break;
    }
  }

  for (const item of [...snapshot.issues, ...snapshot.pullRequests]) {
    const pull = currentPulls.get(item.number);
    const isPull = pull !== undefined;
    if (!isPull && excluded.has(item.number)) continue;
    if (inWindow(item.createdAt)) {
      events.push({
        id: `created:${item.number}`, number: item.number,
        kind: isPull ? "new-pr" : "new-issue",
        occurredAt: item.createdAt, url: item.url,
        ...(item.author ? { author: item.author } : {}),
      });
    }
    if (pull) {
      const prior = priorPulls.get(item.number);
      if (prior?.headSha && pull.headSha && prior.headSha !== pull.headSha) {
        events.push({
          id: `head:${item.number}:${prior.headSha}:${pull.headSha}:${from}`,
          number: item.number, kind: "new-commit", occurredAt: snapshot.generatedAt,
          url: `${item.url}/commits`,
        });
      }
    }
    const since = encodeURIComponent(from);
    if (options.comments.includeConversationComments) {
      await comments(item.number, "conversation", `/issues/${item.number}/comments?since=${since}`);
    }
    if (isPull && options.comments.includeReviewComments) {
      await comments(item.number, "review-comment", `/pulls/${item.number}/comments?since=${since}`);
    }
    if (isPull && options.comments.includeReviewSummaries) {
      await comments(item.number, "review-summary", `/pulls/${item.number}/reviews`, true);
    }
  }
  events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
}
