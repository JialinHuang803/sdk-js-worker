import { randomUUID } from "node:crypto";
import { isDashboardSnapshot, type DashboardSnapshot, type PackageMetadata } from "../../src/data/contracts";
import type {
  ActivityAcknowledgeRequest,
  ActivityIngestRequest,
  ActivityRestoreRequest,
  SharedActivityEvent,
  SharedActivityFeed,
  SharedActivityPull,
} from "../../src/data/activity-contracts";

export class ActivityError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface ActivityState {
  schemaVersion: 1;
  feed: SharedActivityFeed;
  snapshot: DashboardSnapshot | null;
  nextSequence: number;
  rate: { minute: number; count: number };
}

const READ_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const kinds = new Set(["new-pr", "new-commit", "new-comment", "merged"]);

export function createState(): ActivityState {
  return {
    schemaVersion: 1,
    feed: { schemaVersion: 1, generation: randomUUID(), revision: 0,
      collectedAt: null, events: [], pullRequests: [] },
    snapshot: null, nextSequence: 1, rate: { minute: 0, count: 0 },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function githubUrl(value: unknown): value is string {
  if (!text(value, 2_000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      !url.username && !url.password && !url.port;
  } catch { return false; }
}
function packageValid(value: unknown): value is PackageMetadata {
  return record(value) && text(value.root) &&
    (value.name === null || text(value.name)) &&
    (value.version === null || text(value.version)) &&
    ["available", "metadata-missing", "missing", "removed"].includes(String(value.state)) &&
    Array.isArray(value.apiVersions) && value.apiVersions.every((api: unknown) =>
      record(api) && text(api.namespace) && Array.isArray(api.versions) &&
      api.versions.every((version: unknown) => text(version))) &&
    (value.breakingChanges === undefined || value.breakingChanges === null ||
      typeof value.breakingChanges === "boolean") &&
    (value.changelogUrl === undefined || githubUrl(value.changelogUrl));
}

function pullValid(value: unknown): value is SharedActivityPull {
  return record(value) && text(value.repository) && repoPattern.test(value.repository) &&
    integer(value.number) && value.number > 0 && text(value.title, 2_000) &&
    githubUrl(value.url) && ["management", "data"].includes(String(value.plane)) &&
    typeof value.holdOn === "boolean" && typeof value.draft === "boolean" &&
    ["open", "merged", "closed"].includes(String(value.state)) &&
    Array.isArray(value.packages) && value.packages.every(packageValid);
}

function eventValid(value: unknown): value is SharedActivityEvent {
  if (!record(value) || !text(value.id, 2_000) || !integer(value.sequence) ||
      value.sequence < 1 || !text(value.repository) || !repoPattern.test(value.repository) ||
      !integer(value.pullRequestNumber) || value.pullRequestNumber < 1 ||
      !kinds.has(String(value.kind)) || !date(value.occurredAt) ||
      !(value.readAt === null || date(value.readAt)) ||
      !(value.acknowledgementId === null || text(value.acknowledgementId)) ||
      ((value.readAt === null) !== (value.acknowledgementId === null))) return false;
  return value.comment === undefined || (record(value.comment) &&
    text(value.comment.id) && ["conversation", "review-comment", "review-summary"].includes(String(value.comment.kind)) &&
    text(value.comment.author) && date(value.comment.createdAt) && githubUrl(value.comment.url));
}

export function validateStoredState(value: unknown): ActivityState {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.feed)) {
    throw new ActivityError(503, "Stored activity state is invalid. No data was changed.");
  }
  const feed = value.feed;
  if (feed.schemaVersion !== 1 || !text(feed.generation) ||
      !integer(feed.revision) ||
      !(feed.collectedAt === null || date(feed.collectedAt)) ||
      !Array.isArray(feed.events) || !feed.events.every(eventValid) ||
      !Array.isArray(feed.pullRequests) || !feed.pullRequests.every(pullValid) ||
      !(value.snapshot === null || (isDashboardSnapshot(value.snapshot) &&
        date(value.snapshot.generatedAt) && !value.snapshot.stale)) ||
      !integer(value.nextSequence) || value.nextSequence < 1 ||
      feed.events.some((event) => event.sequence >= Number(value.nextSequence)) ||
      !record(value.rate) || !integer(value.rate.minute) || !integer(value.rate.count)) {
    throw new ActivityError(503, "Stored activity state is invalid. No data was changed.");
  }
  const ids = new Set(feed.events.map((event) => event.id));
  const sequences = new Set(feed.events.map((event) => event.sequence));
  const pulls = new Set(feed.pullRequests.map((pull) => `${pull.repository}#${pull.number}`));
  if (ids.size !== feed.events.length || sequences.size !== feed.events.length ||
      pulls.size !== feed.pullRequests.length ||
      feed.events.some((event) => !pulls.has(`${event.repository}#${event.pullRequestNumber}`)) ||
      feed.collectedAt !== (value.snapshot?.generatedAt ?? null)) {
    throw new ActivityError(503, "Stored activity state contains inconsistent references.");
  }
  return {
    schemaVersion: 1,
    feed: {
      schemaVersion: 1,
      generation: feed.generation,
      revision: feed.revision,
      collectedAt: feed.collectedAt,
      events: feed.events,
      pullRequests: feed.pullRequests,
    },
    snapshot: value.snapshot,
    nextSequence: value.nextSequence,
    rate: { minute: value.rate.minute, count: value.rate.count },
  };
}

export function parseIngest(value: unknown): ActivityIngestRequest {
  if (!record(value) || !isDashboardSnapshot(value.snapshot) ||
      value.snapshot.stale || !date(value.snapshot.generatedAt) ||
      !Array.isArray(value.inactivePullRequests) || !value.inactivePullRequests.every(pullValid)) {
    throw new ActivityError(400, "Invalid activity snapshot.");
  }
  const s = value.snapshot;
  if (!repoPattern.test(s.source.repository) || !date(s.source.fetchedAt) ||
      !s.pullRequests.every((p) => pullValid({ ...p, state: "open" }) &&
        text(p.headSha) && date(p.createdAt) && date(p.updatedAt)) ||
      (s.mergedPullRequests !== undefined && (!Array.isArray(s.mergedPullRequests) ||
        !s.mergedPullRequests.every((p) => pullValid({ ...p, draft: false, packages: [], state: "merged" }) &&
          date(p.mergedAt) && text(p.headSha)))) ||
      !s.inbox.items.every((item) => record(item) && text(item.repository) &&
        repoPattern.test(item.repository) && integer(item.pullRequestNumber) &&
        item.pullRequestNumber > 0 && date(item.activityAt) &&
        Array.isArray(item.reasons) &&
        item.reasons.every((reason) => ["review-needed", "ci-failure", ...kinds].includes(reason)) &&
        Array.isArray(item.comments) && item.comments.every((comment) =>
          record(comment) && eventValid({ id: "validate", sequence: 1, repository: item.repository,
            pullRequestNumber: item.pullRequestNumber, kind: "new-comment",
            occurredAt: comment.createdAt, readAt: null, acknowledgementId: null, comment })))) {
    throw new ActivityError(400, "Snapshot activity fields are invalid.");
  }
  return { snapshot: s, inactivePullRequests: value.inactivePullRequests };
}

export function parseAcknowledge(value: unknown): ActivityAcknowledgeRequest {
  if (!record(value) || !text(value.generation) || !text(value.repository) ||
      !repoPattern.test(value.repository) || !integer(value.pullRequestNumber) ||
      value.pullRequestNumber < 1 || !integer(value.throughSequence) || value.throughSequence < 1) {
    throw new ActivityError(400, "Invalid acknowledgement.");
  }
  return { generation: value.generation, repository: value.repository,
    pullRequestNumber: value.pullRequestNumber, throughSequence: value.throughSequence };
}

export function parseRestore(value: unknown): ActivityRestoreRequest {
  if (!record(value) || !text(value.generation) || !Array.isArray(value.acknowledgementIds) ||
      value.acknowledgementIds.length === 0 || value.acknowledgementIds.length > 100 ||
      !value.acknowledgementIds.every((id) => text(id, 100))) {
    throw new ActivityError(400, "Invalid restore request.");
  }
  return { generation: value.generation, acknowledgementIds: value.acknowledgementIds };
}

function projectPackages(packages: PackageMetadata[]): PackageMetadata[] {
  return packages.map((p) => ({
    root: p.root, name: p.name, version: p.version, state: p.state,
    apiVersions: p.apiVersions.map((api) => ({ namespace: api.namespace, versions: [...api.versions] })),
    ...(p.breakingChanges !== undefined ? { breakingChanges: p.breakingChanges } : {}),
    ...(p.changelogUrl ? { changelogUrl: p.changelogUrl } : {}),
  }));
}
function projectPull(p: SharedActivityPull): SharedActivityPull {
  return { repository: p.repository, number: p.number, title: p.title, url: p.url,
    plane: p.plane, draft: p.draft, holdOn: p.holdOn, state: p.state,
    packages: projectPackages(p.packages) };
}
const pullKey = (repo: string, number: number) => `${repo}#${number}`;

export function pruneReadActivities(state: ActivityState, now: string): void {
  const events = state.feed.events.filter((event) =>
    event.readAt === null || Date.parse(event.readAt) > Date.parse(now) - READ_RETENTION_MS);
  const retained = new Set(events.map((event) => pullKey(event.repository, event.pullRequestNumber)));
  const pulls = state.feed.pullRequests.filter(
    (p) => p.state === "open" || retained.has(pullKey(p.repository, p.number)),
  );
  if (events.length !== state.feed.events.length || pulls.length !== state.feed.pullRequests.length) {
    state.feed.events = events;
    state.feed.pullRequests = pulls;
    state.feed.revision++;
  }
}

export function ingest(state: ActivityState, body: ActivityIngestRequest, now: string): void {
  const s = body.snapshot;
  if (state.snapshot && Date.parse(s.generatedAt) <= Date.parse(state.snapshot.generatedAt)) {
    pruneReadActivities(state, now);
    return;
  }
  if (state.snapshot && state.snapshot.source.repository !== s.source.repository) {
    throw new ActivityError(409, "Activity source repository cannot change.");
  }
  const pulls = new Map(state.feed.pullRequests.map((p) => [pullKey(p.repository, p.number), p]));
  for (const p of body.inactivePullRequests) pulls.set(pullKey(p.repository, p.number), projectPull(p));
  for (const p of s.pullRequests) {
    pulls.set(pullKey(p.repository, p.number), projectPull({ ...p, state: "open" }));
  }
  for (const p of s.mergedPullRequests ?? []) {
    const key = pullKey(p.repository, p.number);
    pulls.set(key, projectPull({ ...p, draft: false, state: "merged",
      packages: pulls.get(key)?.packages ?? [] }));
  }
  const ids = new Set(state.feed.events.map((event) => event.id));
  function append(event: Omit<SharedActivityEvent, "sequence" | "readAt" | "acknowledgementId">) {
    if (ids.has(event.id)) return;
    ids.add(event.id);
    state.feed.events.push({ ...event, sequence: state.nextSequence++, readAt: null, acknowledgementId: null });
  }
  for (const item of s.inbox.items) {
    const key = pullKey(item.repository, item.pullRequestNumber);
    const p = pulls.get(key);
    if (!p) throw new ActivityError(400, "Activity references an unknown PR.");
    const common = { repository: item.repository, pullRequestNumber: item.pullRequestNumber };
    if (item.reasons.includes("new-pr")) {
      const open = s.pullRequests.find((pr) => pullKey(pr.repository, pr.number) === key);
      if (!open) throw new ActivityError(400, "New PR source is missing.");
      append({ ...common, id: `${key}:opened`, kind: "new-pr", occurredAt: open.createdAt });
    }
    if (item.reasons.includes("new-commit")) {
      const open = s.pullRequests.find((pr) => pullKey(pr.repository, pr.number) === key);
      if (!open) throw new ActivityError(400, "Commit source is missing.");
      append({ ...common, id: `${key}:head:${open.headSha}`, kind: "new-commit", occurredAt: open.updatedAt });
    }
    if (item.reasons.includes("new-comment")) {
      for (const c of item.comments) {
        append({ ...common, id: `${key}:comment:${c.kind}:${c.id}`, kind: "new-comment",
          occurredAt: c.createdAt,
          comment: { id: c.id, kind: c.kind, author: c.author, createdAt: c.createdAt, url: c.url } });
      }
    }
    if (item.reasons.includes("merged")) {
      const merged = s.mergedPullRequests?.find((pr) => pullKey(pr.repository, pr.number) === key);
      if (!merged) throw new ActivityError(400, "Merge source is missing.");
      append({ ...common, id: `${key}:merged:${merged.mergedAt}`, kind: "merged", occurredAt: merged.mergedAt });
    }
  }
  state.feed.pullRequests = [...pulls.values()];
  pruneReadActivities(state, now);
  state.feed.collectedAt = s.generatedAt;
  state.feed.revision++;
  state.snapshot = s;
}

function mutation(state: ActivityState, generation: string, now: string): void {
  if (state.feed.generation !== generation) throw new ActivityError(409, "Activity state changed. Reload before trying again.");
  const minute = Math.floor(Date.parse(now) / 60_000);
  if (state.rate.minute !== minute) state.rate = { minute, count: 0 };
  if (state.rate.count >= 120) throw new ActivityError(429, "Too many shared changes. Please wait a minute.");
  state.rate.count++;
  state.feed.revision++;
  pruneReadActivities(state, now);
}

export function acknowledge(state: ActivityState, body: ActivityAcknowledgeRequest, now: string): string | null {
  if (!state.feed.events.some((event) => event.repository === body.repository &&
      event.pullRequestNumber === body.pullRequestNumber && event.sequence === body.throughSequence)) {
    throw new ActivityError(409, "This activity card changed. Reload before trying again.");
  }
  mutation(state, body.generation, now);
  const events = state.feed.events.filter((event) => event.repository === body.repository &&
    event.pullRequestNumber === body.pullRequestNumber && event.sequence <= body.throughSequence &&
    event.readAt === null);
  if (events.length === 0) return null;
  const id = randomUUID();
  for (const event of events) { event.readAt = now; event.acknowledgementId = id; }
  return id;
}

export function restore(state: ActivityState, body: ActivityRestoreRequest, now: string): void {
  mutation(state, body.generation, now);
  const ids = new Set(body.acknowledgementIds);
  for (const event of state.feed.events) {
    if (event.acknowledgementId && ids.has(event.acknowledgementId)) {
      event.readAt = null;
      event.acknowledgementId = null;
    }
  }
}
