import { describe, expect, it } from "vitest";
import {
  acknowledgeEmitter, createEmitterState, ingestEmitter, parseEmitterAcknowledge, parseEmitterIngest,
  parseEmitterRestore, pruneEmitterReadActivities, restoreEmitter, validateEmitterState, type EmitterActivityState,
} from "../api/src/emitter-engine";
import { updateEmitterState } from "../api/src/emitter-store";
import type { StateBlob } from "../api/src/store";
import type { EmitterSnapshot } from "../src/data/emitter-contracts";
import {
  isEmitterActivityFeed, isEmitterActivityMutationResponse,
  parseEmitterActivityFeed, parseEmitterActivityMutationResponse,
} from "../src/data/emitter-activity-contracts";

const baselineTime = "2026-09-17T00:00:00Z";
const now = "2026-09-18T00:00:00Z";
const later = "2026-09-19T00:00:00Z";
function snapshot(at = baselineTime, from: string | null = null): EmitterSnapshot {
  const item = {
    title: "Emitter work", createdAt: baselineTime, updatedAt: at, author: "author",
    assignees: [], labels: ["emitter"], comments: 1,
  };
  return {
    schemaVersion: 1, generatedAt: at,
    source: { repository: "Azure/typespec", label: "emitter", fetchedAt: at },
    package: { name: "@azure/emitter", version: "1.0.0", publishedAt: null, url: "https://npmjs.com/package/emitter" },
    issues: [{ ...item, number: 2, url: "https://github.com/Azure/typespec/issues/2" }],
    pullRequests: [{ ...item, number: 1, url: "https://github.com/Azure/typespec/pull/1",
      draft: false, headSha: "head", requestedReviewers: ["reviewer"], requestedTeams: ["team"] }],
    activity: {
      comparisonFrom: from, excludedIssueNumbers: [],
      events: from === null ? [] : [{
        id: `commit:${at}`, number: 1, kind: "new-commit", occurredAt: at,
        url: "https://github.com/Azure/typespec/pull/1/commits",
      }],
    },
  };
}
function seed(): EmitterActivityState {
  const state = createEmitterState();
  ingestEmitter(state, { snapshot: snapshot() }, baselineTime);
  ingestEmitter(state, { snapshot: snapshot(now, baselineTime) }, now);
  return state;
}
function ack(state: EmitterActivityState, throughSequence = 1) {
  return { generation: state.feed.generation, number: 1, throughSequence };
}
function memoryStore(initial: EmitterActivityState | null = null): StateBlob {
  let stored = initial ? JSON.stringify(initial) : null;
  let etag = 0;
  return {
    async read() { return stored === null ? null : { text: stored, etag: String(etag) }; },
    async write(text, expected) {
      if ((stored === null ? null : String(etag)) !== expected) throw { statusCode: 412 };
      stored = text;
      etag++;
    },
  };
}

describe("emitter shared activity state", () => {
  it("starts with inventory only, without marking persistent attention as an event", () => {
    const state = createEmitterState();
    ingestEmitter(state, { snapshot: snapshot() }, baselineTime);
    expect(state.feed.events).toEqual([]);
    expect(state.feed.issues).toHaveLength(1);
    expect(state.feed.pullRequests[0].requestedReviewers).toEqual(["reviewer"]);
    expect(validateEmitterState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("treats legacy inventory without an activity window as no baseline", async () => {
    const state = createEmitterState();
    ingestEmitter(state, { snapshot: snapshot() }, baselineTime);
    delete state.snapshot!.activity;
    delete state.snapshot!.pullRequests[0].headSha;
    delete state.snapshot!.pullRequests[0].requestedReviewers;
    delete state.snapshot!.pullRequests[0].requestedTeams;
    const blob = memoryStore(state);
    const result = await updateEmitterState(blob, (current) =>
      ingestEmitter(current, { snapshot: snapshot(now) }, now));
    expect(result.state.feed.collectedAt).toBe(now);
    expect(result.state.feed.events).toEqual([]);
    expect(result.state.snapshot?.activity?.comparisonFrom).toBeNull();
  });

  it("deduplicates the exact latest ingest, including after acknowledgement", () => {
    const state = seed();
    const id = acknowledgeEmitter(state, ack(state), now);
    const before = structuredClone(state);
    ingestEmitter(state, { snapshot: snapshot(now, baselineTime) }, now);
    expect(state).toEqual(before);
    expect(state.feed.events[0].acknowledgementId).toBe(id);
    expect(isEmitterActivityFeed(state.feed)).toBe(true);
  });

  it("rejects stale, out-of-order, mismatched-source and inconsistent baseline collections", () => {
    const state = seed();
    const cases = [
      snapshot(),
      snapshot(later, null),
      snapshot(later, baselineTime),
      { ...snapshot(now, baselineTime), package: { ...snapshot().package, version: "2.0.0" } },
      { ...snapshot(later, now), source: { ...snapshot().source, repository: "Azure/other" } },
      { ...snapshot(later, now), source: { ...snapshot().source, label: "other" } },
    ];
    for (const invalid of cases) {
      const before = structuredClone(state);
      expect(() => ingestEmitter(state, { snapshot: invalid }, later)).toThrow("baseline changed");
      expect(state).toEqual(before);
    }
    expect(() => ingestEmitter(createEmitterState(), { snapshot: snapshot(now, baselineTime) }, now))
      .toThrow("baseline changed");
  });

  it("preserves read state while an old-card acknowledgement cannot consume new events", () => {
    const state = seed();
    const oldCard = ack(state);
    ingestEmitter(state, { snapshot: snapshot(later, now) }, later);
    acknowledgeEmitter(state, oldCard, later);
    expect(state.feed.events.map((event) => event.readAt)).toEqual([later, null]);
    expect(acknowledgeEmitter(state, oldCard, later)).toBeNull();
    expect(state.nextSequence).toBe(3);
  });

  it("restores only its acknowledgement batch, never a newer acknowledgement", () => {
    const state = seed();
    const first = acknowledgeEmitter(state, ack(state), now)!;
    restoreEmitter(state, { generation: state.feed.generation, acknowledgementIds: [first] }, now);
    expect(state.feed.events[0].readAt).toBeNull();
    const second = acknowledgeEmitter(state, ack(state), now)!;
    restoreEmitter(state, { generation: state.feed.generation, acknowledgementIds: [first] }, now);
    expect(state.feed.events[0].acknowledgementId).toBe(second);
  });

  it("expires read details exactly three days later, retaining unread events and baseline", async () => {
    const state = seed();
    const id = acknowledgeEmitter(state, ack(state), now)!;
    ingestEmitter(state, { snapshot: snapshot(later, now) }, later);
    const baseline = structuredClone(state.snapshot);
    pruneEmitterReadActivities(state, "2026-09-20T23:59:59.999Z");
    expect(state.feed.events).toHaveLength(2);
    const blob = memoryStore(state);
    const result = await updateEmitterState(blob, (s) => pruneEmitterReadActivities(s, "2026-09-21T00:00:00Z"));
    expect(result.state.feed.events.map((event) => event.sequence)).toEqual([2]);
    expect(result.state.snapshot).toEqual(baseline);
    restoreEmitter(result.state, { generation: state.feed.generation, acknowledgementIds: [id] }, "2026-09-21T00:00:00Z");
    expect(result.state.feed.events.map((event) => event.sequence)).toEqual([2]);
    expect(result.state.nextSequence).toBe(3);
  });

  it("prunes closed or label-removed work and suppresses excluded issues without suppressing PRs", () => {
    const state = seed();
    const next = snapshot(later, now);
    next.pullRequests = [];
    next.activity!.events = [{
      id: "comment:2:3", number: 2, kind: "new-comment", occurredAt: later,
      url: "https://github.com/Azure/typespec/issues/2#issuecomment-3", author: "person",
    }];
    ingestEmitter(state, { snapshot: next }, later);
    expect(state.feed.events.map((event) => event.number)).toEqual([2]);
    const excluded = snapshot("2026-09-20T00:00:00Z", later);
    excluded.activity!.excludedIssueNumbers = [1, 2];
    ingestEmitter(state, { snapshot: excluded }, excluded.generatedAt);
    expect(state.feed.events.map((event) => event.number)).toEqual([1]);
    expect(state.feed.issues.map((issue) => issue.number)).toEqual([2]);
    expect(state.feed.excludedIssueNumbers).toEqual([1, 2]);
    expect(state.snapshot?.issues).toHaveLength(1);
    expect(validateEmitterState(state)).toEqual(state);
  });

  it("projects only allowed fields, including private nested baseline metadata", () => {
    const raw = snapshot();
    raw.coverage = {
      url: "https://example.test/coverage", reportDate: baselineTime, updatedAt: baselineTime,
      suites: [{ name: "suite", version: "1", total: 1, passed: 1, failed: 0, notImplemented: 0, coverage: 100 }],
    };
    for (const object of [raw, raw.source, raw.package, raw.issues[0], raw.pullRequests[0],
      raw.activity!, raw.coverage, raw.coverage.suites[0]]) Object.assign(object, { body: "private-content" });
    const state = createEmitterState();
    ingestEmitter(state, { snapshot: raw }, baselineTime);
    expect(JSON.stringify(state)).not.toContain("private-content");
    const next = snapshot(now, baselineTime);
    Object.assign(next.activity!.events[0], { body: "private-content", readAt: now, sequence: 42, acknowledgementId: "injected" });
    ingestEmitter(state, { snapshot: next }, now);
    expect(JSON.stringify(state)).not.toContain("private-content");
    expect(state.feed.events[0]).toMatchObject({ readAt: null, sequence: 1, acknowledgementId: null });
  });

  it("rejects malformed, oversized, duplicate and inconsistent activity fields", () => {
    const variants: Array<(s: EmitterSnapshot) => void> = [
      (s) => { delete s.activity; },
      (s) => { s.activity!.events[0].id = "x".repeat(2_001); },
      (s) => { s.activity!.events[0].url = "javascript:alert(1)"; },
      (s) => { s.activity!.events[0].number = 99; },
      (s) => { s.activity!.events[0].kind = "new-issue"; },
      (s) => { s.activity!.events[0].occurredAt = baselineTime; },
      (s) => { s.activity!.events[0].occurredAt = later; },
      (s) => { s.activity!.events.push(s.activity!.events[0]); },
      (s) => { s.activity!.comparisonFrom = null; },
      (s) => { s.activity!.excludedIssueNumbers = [2, 2]; },
      (s) => { s.issues[0].url = "https://user:password@github.com/Azure/typespec/issues/2"; },
      (s) => { s.issues[0].number = 1; },
      (s) => { s.pullRequests[0].requestedTeams = ["x".repeat(501)]; },
      (s) => { s.package.url = "http://example.test"; },
    ];
    for (const change of variants) {
      const invalid = snapshot(now, baselineTime);
      change(invalid);
      expect(() => parseEmitterIngest({ snapshot: invalid })).toThrow();
    }
    const state = seed();
    const reused = snapshot(later, now);
    reused.activity!.events[0].id = state.feed.events[0].id;
    expect(() => ingestEmitter(state, { snapshot: reused }, later)).toThrow("identity changed");
  });

  it("validates public mutation requests, generation and visible sequence boundaries", () => {
    const state = seed();
    for (const request of [null, {}, { ...ack(state), number: 0 }, { ...ack(state), throughSequence: 1.5 },
      { ...ack(state), generation: "x".repeat(501) }]) expect(() => parseEmitterAcknowledge(request)).toThrow();
    expect(parseEmitterAcknowledge({ ...ack(state), secret: "discard" })).toEqual(ack(state));
    for (const acknowledgementIds of [[], ["x".repeat(101)], Array(101).fill("x"), [null]]) {
      expect(() => parseEmitterRestore({ generation: "g", acknowledgementIds })).toThrow();
    }
    expect(() => acknowledgeEmitter(state, { ...ack(state), generation: "old" }, now)).toThrow("state changed");
    expect(() => acknowledgeEmitter(state, ack(state, 2), now)).toThrow("card changed");
    expect(() => acknowledgeEmitter(state, { ...ack(state), number: 2 }, now)).toThrow("card changed");
    expect(() => restoreEmitter(state, { generation: "old", acknowledgementIds: ["id"] }, now)).toThrow("state changed");
  });

  it("persists a 120-per-minute public mutation budget shared by ack and restore", () => {
    const state = seed();
    for (let count = 0; count < 60; count++) {
      acknowledgeEmitter(state, ack(state), now);
      restoreEmitter(state, { generation: state.feed.generation, acknowledgementIds: ["missing"] }, now);
    }
    expect(() => acknowledgeEmitter(state, ack(state), now)).toThrow("Too many");
    expect(() => acknowledgeEmitter(state, ack(state), "2026-09-18T00:01:00Z")).not.toThrow();
  });

  it("guards feed and mutation responses against inconsistent stored references", () => {
    const state = seed();
    expect(parseEmitterActivityFeed(state.feed)).toEqual(state.feed);
    expect(parseEmitterActivityMutationResponse({ feed: state.feed, acknowledgementId: null })).toEqual({
      feed: state.feed, acknowledgementId: null,
    });
    expect(isEmitterActivityMutationResponse({ feed: state.feed, acknowledgementId: 1 })).toBe(false);
    for (const change of [
      (s: EmitterActivityState) => { s.nextSequence = 1; },
      (s: EmitterActivityState) => { s.feed.events[0].readAt = now; },
      (s: EmitterActivityState) => { s.feed.events.push(s.feed.events[0]); },
      (s: EmitterActivityState) => { s.feed.events[0].number = 99; },
      (s: EmitterActivityState) => { s.feed.collectedAt = later; },
      (s: EmitterActivityState) => { s.feed.pullRequests[0].title = "Different"; },
    ]) {
      const invalid = JSON.parse(JSON.stringify(state)) as EmitterActivityState;
      change(invalid);
      expect(() => validateEmitterState(invalid)).toThrow("invalid");
    }
    expect(() => parseEmitterActivityFeed({})).toThrow("Invalid");
    expect(() => parseEmitterActivityMutationResponse({})).toThrow("Invalid");
  });
});

describe("independent emitter CAS storage", () => {
  it("initializes once and preserves generation across concurrent creators", async () => {
    const blob = memoryStore();
    const results = await Promise.all([
      updateEmitterState(blob, () => undefined), updateEmitterState(blob, () => undefined),
    ]);
    expect(results[0].state.feed.generation).toBe(results[1].state.feed.generation);
  });

  it("retries a collector/ack race without losing read state or new unread activity", async () => {
    const initial = seed();
    const blob = memoryStore(initial);
    await Promise.all([
      updateEmitterState(blob, (state) => ingestEmitter(state, { snapshot: snapshot(later, now) }, later)),
      updateEmitterState(blob, (state) => acknowledgeEmitter(state, ack(initial), now)),
    ]);
    const result = await updateEmitterState(blob, () => undefined);
    expect(result.state.feed.events.map((event) => event.readAt !== null)).toEqual([true, false]);
  });

  it("does not reset corrupt, incompatible SDK, or inaccessible state", async () => {
    let writes = 0;
    const blob: StateBlob = {
      async read() { return { text: "{broken", etag: "1" }; },
      async write() { writes++; },
    };
    await expect(updateEmitterState(blob, () => undefined)).rejects.toThrow("unreadable");
    blob.read = async () => ({ text: JSON.stringify({ ...seed(), feed: { pullRequests: [] } }), etag: "1" });
    await expect(updateEmitterState(blob, () => undefined)).rejects.toThrow("invalid");
    blob.read = async () => { throw new Error("403"); };
    await expect(updateEmitterState(blob, () => undefined)).rejects.toThrow("403");
    expect(writes).toBe(0);
  });

  it("bounds write conflict retries and never retries unrelated storage failures", async () => {
    let writes = 0;
    const blob: StateBlob = {
      async read() { return null; },
      async write() { writes++; throw { statusCode: 409, code: "BlobAlreadyExists" }; },
    };
    await expect(updateEmitterState(blob, () => undefined)).rejects.toThrow("busy");
    expect(writes).toBe(6);
    blob.write = async () => { throw new Error("permission denied"); };
    await expect(updateEmitterState(blob, () => undefined)).rejects.toThrow("permission denied");
  });
});
