import { isEmitterActivity, type EmitterActivity, type EmitterIssue, type EmitterPullRequest, type EmitterSnapshot } from "./emitter-contracts";

export interface EmitterActivityFeed {
  schemaVersion: 1;
  generation: string;
  revision: number;
  collectedAt: string | null;
  events: Array<EmitterActivity & { sequence: number; readAt: string | null; acknowledgementId: string | null }>;
  issues: EmitterIssue[];
  pullRequests: EmitterPullRequest[];
  excludedIssueNumbers: number[];
}

export interface EmitterActivityBaseline { snapshot: EmitterSnapshot | null }
export interface EmitterActivityIngestRequest { snapshot: EmitterSnapshot }
export interface EmitterActivityAcknowledgeRequest { generation: string; number: number; throughSequence: number }
export interface EmitterActivityRestoreRequest { generation: string; acknowledgementIds: string[] }
export interface EmitterActivityMutationResponse { feed: EmitterActivityFeed; acknowledgementId: string | null }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string => text(value, 100) && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => text(entry));
function webUrl(value: unknown): value is string {
  if (!text(value, 2_000)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
function issue(value: unknown): value is EmitterIssue {
  return record(value) && integer(value.number) && value.number > 0 &&
    text(value.title, 2_000) && webUrl(value.url) && timestamp(value.createdAt) && timestamp(value.updatedAt) &&
    (value.author === null || text(value.author)) && strings(value.assignees) && strings(value.labels) &&
    integer(value.comments);
}
function pull(value: unknown): value is EmitterPullRequest {
  return issue(value) && "draft" in value && typeof value.draft === "boolean" &&
    (!("headSha" in value) || text(value.headSha)) &&
    (!("requestedReviewers" in value) || strings(value.requestedReviewers)) &&
    (!("requestedTeams" in value) || strings(value.requestedTeams));
}

export function isEmitterActivityFeed(value: unknown): value is EmitterActivityFeed {
  if (!record(value) || value.schemaVersion !== 1 || !text(value.generation) ||
    !integer(value.revision) || !(value.collectedAt === null || timestamp(value.collectedAt)) ||
    !Array.isArray(value.issues) || !value.issues.every(issue) ||
    !Array.isArray(value.pullRequests) || !value.pullRequests.every(pull) ||
    !Array.isArray(value.excludedIssueNumbers) ||
    !value.excludedIssueNumbers.every((number) => integer(number) && number > 0) ||
    !Array.isArray(value.events)) return false;
  const issues = new Set(value.issues.map((item) => item.number));
  const pulls = new Set(value.pullRequests.map((item) => item.number));
  const excluded = new Set(value.excludedIssueNumbers);
  if (new Set([...issues, ...pulls]).size !== value.issues.length + value.pullRequests.length ||
    excluded.size !== value.excludedIssueNumbers.length) return false;
  const events = value.events;
  return events.every((event: unknown) => {
    if (!record(event) || !isEmitterActivity(event) || !text(event.id, 2_000) || !webUrl(event.url) ||
      !integer(event.sequence) || event.sequence < 1 ||
      !(event.readAt === null || timestamp(event.readAt)) ||
      !(event.acknowledgementId === null || text(event.acknowledgementId, 100)) ||
      ((event.readAt === null) !== (event.acknowledgementId === null)) ||
      !timestamp(value.collectedAt) || Date.parse(event.occurredAt) > Date.parse(value.collectedAt) ||
      (!issues.has(event.number) && !pulls.has(event.number)) ||
      (issues.has(event.number) && excluded.has(event.number))) return false;
    return (event.kind !== "new-issue" || issues.has(event.number)) &&
      (!["new-pr", "new-commit"].includes(event.kind) || pulls.has(event.number));
  }) && new Set(events.map((event) => event.id)).size === events.length &&
    new Set(events.map((event) => event.sequence)).size === events.length;
}

export function parseEmitterActivityFeed(value: unknown): EmitterActivityFeed {
  if (!isEmitterActivityFeed(value)) throw new Error("Invalid emitter activity feed.");
  return value;
}

export function isEmitterActivityMutationResponse(value: unknown): value is EmitterActivityMutationResponse {
  return record(value) && isEmitterActivityFeed(value.feed) &&
    (value.acknowledgementId === null || text(value.acknowledgementId, 100));
}

export function parseEmitterActivityMutationResponse(value: unknown): EmitterActivityMutationResponse {
  if (!isEmitterActivityMutationResponse(value)) throw new Error("Invalid emitter activity response.");
  return value;
}
