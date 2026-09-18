import { randomUUID } from "node:crypto";
import { isEmitterSnapshot, type EmitterActivity, type EmitterIssue, type EmitterPullRequest, type EmitterSnapshot } from "../../src/data/emitter-contracts";
import {
  isEmitterActivityFeed, type EmitterActivityFeed, type EmitterActivityAcknowledgeRequest,
  type EmitterActivityIngestRequest, type EmitterActivityRestoreRequest,
} from "../../src/data/emitter-activity-contracts";
import { ActivityError } from "./engine";

export interface EmitterActivityState {
  schemaVersion: 1;
  feed: EmitterActivityFeed;
  snapshot: EmitterSnapshot | null;
  nextSequence: number;
  rate: { minute: number; count: number };
}

const READ_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function publicUrl(value: string, github = false): boolean {
  if (!text(value, 2_000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (!github || url.hostname === "github.com");
  } catch { return false; }
}

export function createEmitterState(): EmitterActivityState {
  return {
    schemaVersion: 1,
    feed: { schemaVersion: 1, generation: randomUUID(), revision: 0, collectedAt: null,
      events: [], issues: [], pullRequests: [], excludedIssueNumbers: [] },
    snapshot: null, nextSequence: 1, rate: { minute: 0, count: 0 },
  };
}

function projectIssue(item: EmitterIssue): EmitterIssue {
  return {
    number: item.number, title: item.title, url: item.url, createdAt: item.createdAt,
    updatedAt: item.updatedAt, author: item.author, assignees: [...item.assignees],
    labels: [...item.labels], comments: item.comments,
  };
}
function projectPull(item: EmitterPullRequest): EmitterPullRequest {
  return {
    ...projectIssue(item), draft: item.draft,
    ...(item.headSha !== undefined ? { headSha: item.headSha } : {}),
    ...(item.requestedReviewers !== undefined ? { requestedReviewers: [...item.requestedReviewers] } : {}),
    ...(item.requestedTeams !== undefined ? { requestedTeams: [...item.requestedTeams] } : {}),
  };
}
function projectEvent(event: EmitterActivity): EmitterActivity {
  return { id: event.id, number: event.number, kind: event.kind, occurredAt: event.occurredAt,
    url: event.url, ...(event.author !== undefined ? { author: event.author } : {}) };
}

export function parseEmitterIngest(value: unknown): EmitterActivityIngestRequest {
  if (!record(value) || !isEmitterSnapshot(value.snapshot) || !value.snapshot.activity) {
    throw new ActivityError(400, "Invalid emitter activity snapshot.");
  }
  const s = value.snapshot;
  const activity = s.activity!;
  const items = [...s.issues, ...s.pullRequests];
  const feed: EmitterActivityFeed = {
    schemaVersion: 1, generation: "validate", revision: 0, collectedAt: s.generatedAt,
    issues: s.issues, pullRequests: s.pullRequests, excludedIssueNumbers: [],
    events: activity.events.map((event, index) =>
      ({ ...event, sequence: index + 1, readAt: null, acknowledgementId: null })),
  };
  if (!isEmitterActivityFeed(feed) || !text(s.source.repository) ||
    !/^[\w.-]+\/[\w.-]+$/.test(s.source.repository) || !text(s.source.label) ||
    !text(s.generatedAt, 100) || !text(s.source.fetchedAt, 100) ||
    (activity.comparisonFrom !== null && !text(activity.comparisonFrom, 100)) ||
    !text(s.package.name) || !text(s.package.version) || !publicUrl(s.package.url) ||
    (s.package.publishedAt !== null && !text(s.package.publishedAt, 100)) ||
    items.some((item) => !publicUrl(item.url, true)) ||
    activity.events.some((event) => !publicUrl(event.url, true) ||
      !text(event.occurredAt, 100) || (event.author !== undefined && !text(event.author))) ||
    new Set(activity.excludedIssueNumbers).size !== activity.excludedIssueNumbers.length ||
    (s.coverage && (!publicUrl(s.coverage.url) || !text(s.coverage.reportDate, 100) ||
      !text(s.coverage.updatedAt, 100) ||
      s.coverage.suites.some((suite) => !text(suite.name) || !text(suite.version))))) {
    throw new ActivityError(400, "Emitter snapshot activity fields are invalid.");
  }
  return {
    snapshot: {
      schemaVersion: 1, generatedAt: s.generatedAt,
      source: { repository: s.source.repository, label: s.source.label, fetchedAt: s.source.fetchedAt },
      package: { name: s.package.name, version: s.package.version, publishedAt: s.package.publishedAt, url: s.package.url },
      issues: s.issues.map(projectIssue), pullRequests: s.pullRequests.map(projectPull),
      ...(s.coverage ? { coverage: {
        url: s.coverage.url, reportDate: s.coverage.reportDate, updatedAt: s.coverage.updatedAt,
        suites: s.coverage.suites.map((suite) => ({
          name: suite.name, version: suite.version, total: suite.total, passed: suite.passed,
          failed: suite.failed, notImplemented: suite.notImplemented, coverage: suite.coverage,
        })),
      } } : {}),
      activity: { comparisonFrom: activity.comparisonFrom, events: activity.events.map(projectEvent),
        excludedIssueNumbers: [...activity.excludedIssueNumbers] },
    },
  };
}

export function parseEmitterAcknowledge(value: unknown): EmitterActivityAcknowledgeRequest {
  if (!record(value) || !text(value.generation) || !integer(value.number) || value.number < 1 ||
    !integer(value.throughSequence) || value.throughSequence < 1) {
    throw new ActivityError(400, "Invalid emitter acknowledgement.");
  }
  return { generation: value.generation, number: value.number, throughSequence: value.throughSequence };
}

export function parseEmitterRestore(value: unknown): EmitterActivityRestoreRequest {
  if (!record(value) || !text(value.generation) || !Array.isArray(value.acknowledgementIds) ||
    value.acknowledgementIds.length === 0 || value.acknowledgementIds.length > 100 ||
    !value.acknowledgementIds.every((id) => text(id, 100))) {
    throw new ActivityError(400, "Invalid emitter restore request.");
  }
  return { generation: value.generation, acknowledgementIds: [...value.acknowledgementIds] };
}

export function validateEmitterState(value: unknown): EmitterActivityState {
  const invalid = () => new ActivityError(503, "Stored emitter activity state is invalid. No data was changed.");
  if (!record(value) || value.schemaVersion !== 1 || !isEmitterActivityFeed(value.feed) ||
    !integer(value.nextSequence) || value.nextSequence < 1 ||
    value.feed.events.some((event) => event.sequence >= Number(value.nextSequence)) ||
    !record(value.rate) || !integer(value.rate.minute) || !integer(value.rate.count)) throw invalid();
  let snapshot: EmitterSnapshot | null;
  try {
    if (value.snapshot === null) snapshot = null;
    else if (isEmitterSnapshot(value.snapshot) && !value.snapshot.activity) {
      if (value.feed.events.length > 0) throw invalid();
      snapshot = parseEmitterIngest({ snapshot: {
        ...value.snapshot, activity: { comparisonFrom: null, events: [], excludedIssueNumbers: [] },
      } }).snapshot;
      delete snapshot.activity;
    } else snapshot = parseEmitterIngest({ snapshot: value.snapshot }).snapshot;
  }
  catch { throw invalid(); }
  const excluded = snapshot?.activity?.excludedIssueNumbers ?? [];
  if (value.feed.collectedAt !== (snapshot?.generatedAt ?? null) ||
    JSON.stringify(value.feed.excludedIssueNumbers) !== JSON.stringify(excluded) ||
    JSON.stringify(value.feed.issues) !== JSON.stringify(snapshot?.issues ?? []) ||
    JSON.stringify(value.feed.pullRequests) !== JSON.stringify(snapshot?.pullRequests ?? [])) throw invalid();
  return { schemaVersion: 1, feed: value.feed, snapshot, nextSequence: value.nextSequence,
    rate: { minute: value.rate.minute, count: value.rate.count } };
}

export function pruneEmitterReadActivities(state: EmitterActivityState, now: string): void {
  const events = state.feed.events.filter((event) =>
    event.readAt === null || Date.parse(event.readAt) > Date.parse(now) - READ_RETENTION_MS);
  if (events.length !== state.feed.events.length) {
    state.feed.events = events;
    state.feed.revision++;
  }
}

export function ingestEmitter(state: EmitterActivityState, body: EmitterActivityIngestRequest, now: string): void {
  const s = parseEmitterIngest(body).snapshot;
  const previous = state.snapshot?.activity ? state.snapshot : null;
  if (previous && s.generatedAt === previous.generatedAt && JSON.stringify(s) === JSON.stringify(previous)) {
    pruneEmitterReadActivities(state, now);
    return;
  }
  if ((previous && (Date.parse(s.generatedAt) <= Date.parse(previous.generatedAt) ||
    s.source.repository !== previous.source.repository || s.source.label !== previous.source.label)) ||
    s.activity!.comparisonFrom !== (previous?.generatedAt ?? null)) {
    throw new ActivityError(409, "Emitter activity baseline changed. Collect again from the shared baseline.");
  }
  const excluded = new Set(s.activity!.excludedIssueNumbers);
  const issues = s.issues.filter((item) => !excluded.has(item.number));
  const active = new Set([...issues, ...s.pullRequests].map((item) => item.number));
  const existing = new Map(state.feed.events.map((event) => [event.id, event]));
  for (const event of s.activity!.events) {
    const old = existing.get(event.id);
    if (old && JSON.stringify(projectEvent(old)) !== JSON.stringify(event)) {
      throw new ActivityError(409, "Emitter event identity changed. Collect again from the shared baseline.");
    }
  }
  state.feed.events = state.feed.events.filter((event) => active.has(event.number));
  for (const event of s.activity!.events) {
    if (!active.has(event.number) || existing.has(event.id)) continue;
    state.feed.events.push({ ...event, sequence: state.nextSequence++, readAt: null, acknowledgementId: null });
  }
  state.feed.issues = s.issues;
  state.feed.pullRequests = s.pullRequests;
  state.feed.excludedIssueNumbers = [...excluded];
  state.feed.collectedAt = s.generatedAt;
  state.feed.revision++;
  state.snapshot = s;
  pruneEmitterReadActivities(state, now);
}

function mutation(state: EmitterActivityState, generation: string, now: string): void {
  if (state.feed.generation !== generation) throw new ActivityError(409, "Emitter activity state changed. Reload before trying again.");
  const minute = Math.floor(Date.parse(now) / 60_000);
  if (state.rate.minute !== minute) state.rate = { minute, count: 0 };
  if (state.rate.count >= 120) throw new ActivityError(429, "Too many shared changes. Please wait a minute.");
  state.rate.count++;
  state.feed.revision++;
  pruneEmitterReadActivities(state, now);
}

export function acknowledgeEmitter(state: EmitterActivityState, body: EmitterActivityAcknowledgeRequest, now: string): string | null {
  if (!state.feed.events.some((event) => event.number === body.number && event.sequence === body.throughSequence)) {
    throw new ActivityError(409, "This emitter activity card changed. Reload before trying again.");
  }
  mutation(state, body.generation, now);
  const events = state.feed.events.filter((event) =>
    event.number === body.number && event.sequence <= body.throughSequence && event.readAt === null);
  if (!events.length) return null;
  const id = randomUUID();
  for (const event of events) { event.readAt = now; event.acknowledgementId = id; }
  return id;
}

export function restoreEmitter(state: EmitterActivityState, body: EmitterActivityRestoreRequest, now: string): void {
  mutation(state, body.generation, now);
  const ids = new Set(body.acknowledgementIds);
  for (const event of state.feed.events) {
    if (event.acknowledgementId && ids.has(event.acknowledgementId)) {
      event.readAt = null;
      event.acknowledgementId = null;
    }
  }
}
