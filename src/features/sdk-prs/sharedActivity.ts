import type {
  ActivityAcknowledgeRequest,
  ActivityMutationResponse,
  SharedActivityEvent,
  SharedActivityFeed,
  SharedActivityPull,
} from "../../data/activity-contracts";
import type { DashboardSnapshot, InboxReason, ReviewInboxItem } from "../../data/contracts";

export const pullKey = (repository: string, number: number) => `${repository}:${number}`;

export interface ActivityGroup {
  pull: SharedActivityPull;
  events: SharedActivityEvent[];
  firstAt: string;
  latestAt: string;
  throughSequence: number;
  acknowledgementIds: string[];
}

export function groupActivities(feed: SharedActivityFeed, read: boolean): ActivityGroup[] {
  const pulls = new Map(feed.pullRequests.map((pull) => [pullKey(pull.repository, pull.number), pull]));
  const groups = new Map<string, ActivityGroup>();
  for (const event of feed.events) {
    if ((event.readAt !== null) !== read) continue;
    const key = pullKey(event.repository, event.pullRequestNumber);
    const pull = pulls.get(key);
    if (!pull || pull.holdOn) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        pull, events: [], firstAt: event.occurredAt, latestAt: event.occurredAt,
        throughSequence: event.sequence, acknowledgementIds: [],
      };
      groups.set(key, group);
    }
    group.events.push(event);
    if (Date.parse(event.occurredAt) < Date.parse(group.firstAt)) group.firstAt = event.occurredAt;
    if (Date.parse(event.occurredAt) > Date.parse(group.latestAt)) group.latestAt = event.occurredAt;
    group.throughSequence = Math.max(group.throughSequence, event.sequence);
    if (event.acknowledgementId && !group.acknowledgementIds.includes(event.acknowledgementId)) {
      group.acknowledgementIds.push(event.acknowledgementId);
    }
  }
  return [...groups.values()].sort((left, right) =>
    (read ? Date.parse(right.latestAt) - Date.parse(left.latestAt) :
      Date.parse(left.firstAt) - Date.parse(right.firstAt)) ||
    pullKey(left.pull.repository, left.pull.number).localeCompare(pullKey(right.pull.repository, right.pull.number)),
  );
}

export function acknowledgeGroup(feed: SharedActivityFeed, group: ActivityGroup): ActivityAcknowledgeRequest {
  return {
    generation: feed.generation,
    repository: group.pull.repository,
    pullRequestNumber: group.pull.number,
    throughSequence: group.throughSequence,
  };
}

export function attentionEntries(snapshot: DashboardSnapshot) {
  const merged = new Set((snapshot.mergedPullRequests ?? []).map((pull) => pullKey(pull.repository, pull.number)));
  return snapshot.pullRequests.flatMap((pull) => {
    if (pull.draft || pull.holdOn || merged.has(pullKey(pull.repository, pull.number))) return [];
    const reasons: InboxReason[] = [];
    if (pull.reviewDecision === "review-required") reasons.push("review-needed");
    if ((pull.checks.failedCount ?? 0) > 0) reasons.push("ci-failure");
    if (!reasons.length) return [];
    const item: ReviewInboxItem = {
      repository: pull.repository, pullRequestNumber: pull.number,
      reasons, activityAt: pull.updatedAt, comments: [],
    };
    return [{ pull, item }];
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.trim().length > 0;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown) => value === null || text(value);
function webUrl(value: unknown): value is string {
  if (!text(value)) return false;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}

function validPackage(value: unknown): boolean {
  return record(value) && text(value.root) && nullableText(value.name) &&
    nullableText(value.version) &&
    ["available", "metadata-missing", "missing", "removed"].includes(String(value.state)) &&
    Array.isArray(value.apiVersions) && value.apiVersions.every((api: unknown) =>
      record(api) && text(api.namespace) && Array.isArray(api.versions) && api.versions.every(text)) &&
    (value.note === undefined || text(value.note)) &&
    (value.breakingChanges === undefined || value.breakingChanges === null || typeof value.breakingChanges === "boolean") &&
    (value.changelogUrl === undefined || webUrl(value.changelogUrl));
}

function validPull(value: unknown): value is SharedActivityPull {
  return record(value) && nonempty(value.repository) && integer(value.number) && value.number > 0 &&
    text(value.title) && webUrl(value.url) && ["management", "data"].includes(String(value.plane)) &&
    typeof value.draft === "boolean" && typeof value.holdOn === "boolean" &&
    ["open", "merged", "closed"].includes(String(value.state)) &&
    Array.isArray(value.packages) && value.packages.every(validPackage);
}

function validEvent(value: unknown): value is SharedActivityEvent {
  if (!record(value)) return false;
  const comment = value.comment;
  return nonempty(value.id) && integer(value.sequence) && value.sequence > 0 &&
    nonempty(value.repository) && integer(value.pullRequestNumber) && value.pullRequestNumber > 0 &&
    ["new-pr", "new-commit", "new-comment", "merged"].includes(String(value.kind)) &&
    timestamp(value.occurredAt) &&
    ((value.readAt === null && value.acknowledgementId === null) ||
      (timestamp(value.readAt) && nonempty(value.acknowledgementId))) &&
    (comment === undefined || (record(comment) && nonempty(comment.id) && text(comment.author) &&
      ["conversation", "review-comment", "review-summary"].includes(String(comment.kind)) &&
      timestamp(comment.createdAt) && webUrl(comment.url)));
}

export function parseActivityFeed(value: unknown): SharedActivityFeed {
  if (!record(value) || value.schemaVersion !== 1 || !nonempty(value.generation) ||
    !integer(value.revision) || !(value.collectedAt === null || timestamp(value.collectedAt)) ||
    !Array.isArray(value.pullRequests) || !value.pullRequests.every(validPull) ||
    !Array.isArray(value.events) || !value.events.every(validEvent)) {
    throw new Error("Invalid activity response. Retry to load a valid shared feed.");
  }
  const pulls = new Set(value.pullRequests.map((pull) => pullKey(pull.repository, pull.number)));
  if (pulls.size !== value.pullRequests.length ||
    new Set(value.events.map((event) => event.id)).size !== value.events.length ||
    new Set(value.events.map((event) => event.sequence)).size !== value.events.length ||
    value.events.some((event) => !pulls.has(pullKey(event.repository, event.pullRequestNumber)))) {
    throw new Error("Invalid activity response: duplicate or missing activity references.");
  }
  return {
    schemaVersion: 1, generation: value.generation, revision: value.revision,
    collectedAt: value.collectedAt, pullRequests: value.pullRequests, events: value.events,
  };
}

export function parseActivityMutation(value: unknown): ActivityMutationResponse {
  if (!record(value) || !(value.acknowledgementId === null || nonempty(value.acknowledgementId))) {
    throw new Error("Invalid activity mutation response. Reload before trying again.");
  }
  return { feed: parseActivityFeed(value.feed), acknowledgementId: value.acknowledgementId };
}

export class ActivityResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readActivityResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch {
    throw new ActivityResponseError(`Activity service returned an unreadable response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    const detail = record(value) && text(value.error) ? value.error :
      record(value) && text(value.message) ? value.message : "Request failed";
    throw new ActivityResponseError(`Activity service: ${detail.slice(0, 240)} (HTTP ${response.status}).`, response.status);
  }
  return value;
}

export async function fetchActivityResponse(
  url: string,
  options: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("Activity service timed out after 15 seconds. Retry loading."));
  }, 15_000);
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", rejectAbort);
  });
  if (signal.aborted) onAbort();
  try {
    // Bound both the fetch and body read, even if a transport ignores cancellation.
    return await Promise.race([
      aborted,
      fetch(url, { ...options, signal: controller.signal }).then(readActivityResponse),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    removeAbortListener();
  }
}
