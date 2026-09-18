import type { EmitterActivityFeed } from "../../data/emitter-activity-contracts";
import type { EmitterIssue, EmitterPullRequest } from "../../data/emitter-contracts";

export type EmitterWorkItem = EmitterIssue | EmitterPullRequest;
export type EmitterInboxEvent = EmitterActivityFeed["events"][number];
export interface EmitterInboxEntry {
  item: EmitterWorkItem;
  signals: string[];
  unread: EmitterInboxEvent[];
  recentlyRead: EmitterInboxEvent[];
}

export const emitterActivityLabels = {
  "new-issue": "New issue",
  "new-pr": "New PR",
  "new-commit": "New commits",
  "new-comment": "New comment",
};

export function emitterInboxEntries(
  items: EmitterWorkItem[],
  events: EmitterInboxEvent[],
  excludedIssueNumbers: number[],
  now: number,
): { attention: EmitterInboxEntry[]; recentlyRead: EmitterInboxEntry[] } {
  const excluded = new Set(excludedIssueNumbers);
  const byNumber = new Map<number, EmitterInboxEvent[]>();
  for (const event of events) {
    const grouped = byNumber.get(event.number) ?? [];
    grouped.push(event);
    byNumber.set(event.number, grouped);
  }
  const attention: EmitterInboxEntry[] = [];
  const recentlyRead: EmitterInboxEntry[] = [];
  for (const item of items) {
    if (excluded.has(item.number)) continue;
    const draft = "draft" in item && item.draft;
    const activity = byNumber.get(item.number) ?? [];
    // Acknowledgement covers the whole card through its sequence, so a draft
    // surfaced by discussion must also display its other included event kinds.
    if (draft && !activity.some((event) => event.kind === "new-comment" &&
      (event.readAt === null || now - Date.parse(event.readAt) <= 3 * 86_400_000))) continue;
    const signals: string[] = [];
    if (!("draft" in item) && !item.assignees.length) signals.push("Unassigned");
    if ("draft" in item && !draft &&
      ((item.requestedReviewers?.length ?? 0) > 0 || (item.requestedTeams?.length ?? 0) > 0)) {
      signals.push("Review requested");
    }
    const entry: EmitterInboxEntry = {
      item, signals,
      unread: activity.filter((event) => event.readAt === null),
      recentlyRead: activity.filter((event) => event.readAt !== null &&
        now - Date.parse(event.readAt) <= 3 * 86_400_000),
    };
    if (signals.length || entry.unread.length) attention.push(entry);
    else if (entry.recentlyRead.length) recentlyRead.push(entry);
  }
  const latest = (entry: EmitterInboxEntry) => Math.max(
    Date.parse(entry.item.updatedAt),
    ...[...entry.unread, ...entry.recentlyRead].map((event) => Date.parse(event.occurredAt)),
  );
  const order = (a: EmitterInboxEntry, b: EmitterInboxEntry) =>
    latest(b) - latest(a) || b.item.number - a.item.number;
  return { attention: attention.sort(order), recentlyRead: recentlyRead.sort(order) };
}

export function emitterAcknowledgementIds(entry: EmitterInboxEntry): string[] {
  return [...new Set(entry.recentlyRead.flatMap((event) =>
    event.acknowledgementId ? [event.acknowledgementId] : []))];
}
