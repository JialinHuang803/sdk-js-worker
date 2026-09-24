import { describe, expect, it } from "vitest";
import {
  acknowledge, createState, ingest, parseAcknowledge, parseIngest, parseRestore,
  restore, validateStoredState, pruneReadActivities, type ActivityState,
} from "../api/src/engine";
import { updateState, type StateBlob } from "../api/src/store";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";
import { publicActivityFeed } from "../api/src/public-feed";
import { parseActivityFeed } from "../src/features/sdk-prs/sharedActivity";
import { readerName } from "../src/data/read-attribution";

const repository = "Azure/azure-sdk-for-js";
const now = "2026-09-18T00:00:00Z";
function snapshot(date = now, head = "head1"): DashboardSnapshot {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: date, stale: false,
    source: { repository, fetchedAt: date, query: "AutoPR" },
    pullRequests: [{
      repository, number: 1, url: `https://github.com/${repository}/pull/1`,
      title: "[AutoPR test]", draft: false, holdOn: false, plane: "management",
      headSha: head, createdAt: date, updatedAt: date, releasePlanUrl: null,
      reviewDecision: "review-required", packages: [],
      checks: { failedCount: 1, qualification: "complete", observedCount: 1 },
      conflicts: false, completeness: {
        changedFiles: "complete", checks: "complete", reviews: "complete", metadata: "complete",
      }, warnings: [],
    }],
    inbox: {
      comparisonFrom: "2026-09-17T00:00:00Z", generatedAt: date, baselineAvailable: true,
      defaultPlane: "management", items: [{
        repository, pullRequestNumber: 1, activityAt: date,
        reasons: ["new-commit", "review-needed", "ci-failure"], comments: [],
      }],
    },
  };
}
function seed(): ActivityState {
  const state = createState();
  ingest(state, parseIngest({ snapshot: snapshot(), inactivePullRequests: [] }), now);
  return state;
}
function ack(state: ActivityState, throughSequence = 1) {
  return { generation: state.feed.generation, repository, pullRequestNumber: 1, throughSequence };
}
function memoryStore(initial: ActivityState | null = null): StateBlob {
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

describe("durable shared activity", () => {
  it("accepts optional recorded approval evidence but rejects invalid values", () => {
    const data = snapshot();
    data.pullRequests[0].recordedApproval = true;
    expect(parseIngest({ snapshot: data, inactivePullRequests: [] }).snapshot.pullRequests[0].recordedApproval).toBe(true);
    expect(() => parseIngest({ snapshot: {
      ...data, pullRequests: [{ ...data.pullRequests[0], recordedApproval: "yes" }],
    }, inactivePullRequests: [] })).toThrow("invalid");
  });
  it("recovers held comments idempotently without resetting existing reads or their attribution", () => {
    const state = seed();
    acknowledge(state, ack(state), now, "Reader");
    const generation = state.feed.generation;
    const original = structuredClone(state.feed.events[0]);
    const next = snapshot("2026-09-18T02:00:00Z");
    next.pullRequests[0].holdOn = true;
    next.inbox.items[0].reasons = ["new-comment", "review-needed"];
    next.inbox.items[0].comments = [{
      id: "conversation:123", kind: "conversation", author: "service-team",
      createdAt: "2026-09-17T23:00:00Z", url: `https://github.com/${repository}/pull/1#issuecomment-123`,
    }];
    ingest(state, parseIngest({ snapshot: next, inactivePullRequests: [] }), next.generatedAt);
    expect(state.feed.events[0]).toEqual(original);
    expect(state.feed.events[1]).toMatchObject({ kind: "new-comment", readAt: null });
    acknowledge(state, ack(state, 2), next.generatedAt, "Second reader");
    const recovered = structuredClone(state.feed.events[1]);
    next.generatedAt = "2026-09-18T03:00:00Z";
    ingest(state, { snapshot: next, inactivePullRequests: [] }, next.generatedAt);
    expect(state.feed.events).toEqual([original, recovered]);
    expect(state.feed.generation).toBe(generation);
    expect(state.feed.pullRequests[0].holdOn).toBe(true);
  });

  it("persists readers per batch, preserves the first reader on retries and clears only restored attribution", () => {
    const state = seed();
    const first = acknowledge(state, ack(state), now, "Alice")!;
    expect(acknowledge(state, ack(state), now, "Bob")).toBeNull();
    expect(readerName(state.feed.events[0])).toBe("Alice");
    const next = snapshot("2026-09-19T00:00:00Z", "head2");
    ingest(state, { snapshot: next, inactivePullRequests: [] }, next.generatedAt);
    expect(state.feed.events[1]).not.toHaveProperty("readBy");
    acknowledge(state, ack(state, 2), next.generatedAt, "Bob");
    expect(validateStoredState(JSON.parse(JSON.stringify(state))).feed.events.map(readerName))
      .toEqual(["Alice", "Bob"]);
    expect(readerName(parseActivityFeed(state.feed).events[0])).toBe("Alice");
    const anonymous = publicActivityFeed(state.feed);
    expect(anonymous.events.every((event) => !("readBy" in event))).toBe(true);
    expect(parseActivityFeed(anonymous).events).toHaveLength(2);
    expect(readerName(state.feed.events[0])).toBe("Alice");
    restore(state, { generation: state.feed.generation, acknowledgementIds: [first] }, next.generatedAt);
    expect(state.feed.events[0]).not.toHaveProperty("readBy");
    expect(readerName(state.feed.events[1])).toBe("Bob");
    acknowledge(state, ack(state), next.generatedAt, "Carol");
    restore(state, { generation: state.feed.generation, acknowledgementIds: [first] }, next.generatedAt);
    expect(readerName(state.feed.events[0])).toBe("Carol");
    expect(JSON.stringify(state.snapshot)).not.toContain("readBy");
  });

  it.each([null, "", " ", 12, {}, { name: "x".repeat(501), acknowledgementId: "a" },
    { name: "Alice", acknowledgementId: "" }])("rejects malformed stored reader attribution: %j", (readBy) => {
    const state = seed();
    acknowledge(state, ack(state), now);
    expect(() => validateStoredState(state)).not.toThrow();
    Object.assign(state.feed.events[0], { readBy });
    expect(() => validateStoredState(state)).toThrow("invalid");
    expect(() => parseActivityFeed(state.feed)).toThrow("Invalid activity");
  });

  it("does not misattribute reads when an older writer leaves attribution behind", () => {
    const state = seed();
    acknowledge(state, ack(state), now, "Alice");
    Object.assign(state.feed.events[0], { readAt: null, acknowledgementId: null });
    expect(() => validateStoredState(state)).not.toThrow();
    expect(validateStoredState(state).feed.events[0]).not.toHaveProperty("readBy");
    expect(readerName(parseActivityFeed(state.feed).events[0])).toBeUndefined();
    Object.assign(state.feed.events[0], { readAt: now, acknowledgementId: "older-writer-new-batch" });
    expect(readerName(parseActivityFeed(state.feed).events[0])).toBeUndefined();
  });

  it("only turns transient reasons into events and persists snapshots separately", () => {
    const state = seed();
    expect(state.feed.events).toHaveLength(1);
    expect(state.feed.events[0]).toMatchObject({ kind: "new-commit", sequence: 1, readAt: null });
    expect(state.snapshot?.pullRequests[0].reviewDecision).toBe("review-required");
    expect(validateStoredState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("accumulates multi-day changes and deduplicates retries", () => {
    const state = seed();
    ingest(state, { snapshot: snapshot(), inactivePullRequests: [] }, now);
    expect(state.feed.revision).toBe(1);
    const later = snapshot("2026-09-19T00:00:00Z", "head2");
    ingest(state, { snapshot: later, inactivePullRequests: [] }, later.generatedAt);
    expect(state.feed.events.map((event) => event.sequence)).toEqual([1, 2]);
    const duplicateHead = snapshot("2026-09-20T00:00:00Z", "head2");
    ingest(state, { snapshot: duplicateHead, inactivePullRequests: [] }, duplicateHead.generatedAt);
    expect(state.feed.events).toHaveLength(2);
    ingest(state, { snapshot: snapshot(), inactivePullRequests: [] }, now);
    expect(state.feed.collectedAt).toBe(duplicateHead.generatedAt);
  });

  it("acknowledges only visible events and preserves newer or late-discovered activity", () => {
    const state = seed();
    const oldCard = ack(state);
    const later = snapshot("2026-09-19T00:00:00Z", "head2");
    later.pullRequests[0].updatedAt = "2026-09-17T00:00:00Z";
    ingest(state, { snapshot: later, inactivePullRequests: [] }, later.generatedAt);
    const id = acknowledge(state, oldCard, later.generatedAt);
    expect(id).toBeTruthy();
    expect(state.feed.events.map((event) => event.readAt !== null)).toEqual([true, false]);
    expect(acknowledge(state, oldCard, later.generatedAt)).toBeNull();
  });

  it("undo is batch-specific and an old undo cannot reverse a newer acknowledgement", () => {
    const state = seed();
    const first = acknowledge(state, ack(state), now)!;
    restore(state, { generation: state.feed.generation, acknowledgementIds: [first] }, now);
    expect(state.feed.events[0].readAt).toBeNull();
    const second = acknowledge(state, ack(state), now)!;
    restore(state, { generation: state.feed.generation, acknowledgementIds: [first] }, now);
    expect(state.feed.events[0].acknowledgementId).toBe(second);
  });

  it("retains read state across collection, prunes only old read details, and never reuses sequence", () => {
    const state = seed();
    acknowledge(state, ack(state), now);
    const next = snapshot("2026-09-19T00:00:00Z", "head2");
    ingest(state, { snapshot: next, inactivePullRequests: [] }, next.generatedAt);
    expect(state.feed.events[0].readAt).toBe(now);
    const oldUnreadId = state.feed.events[1].id;
    const month = snapshot("2026-10-20T00:00:00Z", "head3");
    ingest(state, { snapshot: month, inactivePullRequests: [] }, month.generatedAt);
    expect(state.feed.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(state.feed.events[0].id).toBe(oldUnreadId);
    expect(state.nextSequence).toBe(4);
  });

  it("expires read events at exactly three days without waiting for another collection", async () => {
    const state = seed();
    const id = acknowledge(state, ack(state), now)!;
    const next = snapshot("2026-09-19T00:00:00Z", "head2");
    ingest(state, { snapshot: next, inactivePullRequests: [] }, next.generatedAt);
    const baseline = structuredClone(state.snapshot);
    const revision = state.feed.revision;
    pruneReadActivities(state, "2026-09-20T23:59:59.999Z");
    expect(state.feed.events).toHaveLength(2);
    expect(state.feed.revision).toBe(revision);
    const blob = memoryStore(state);
    const expired = await updateState(blob, (current) => pruneReadActivities(current, "2026-09-21T00:00:00Z"));
    expect(expired.state.feed.events.map((event) => event.sequence)).toEqual([2]);
    expect(expired.state.feed.events[0].readAt).toBeNull();
    expect(expired.state.snapshot).toEqual(baseline);
    expect(expired.state.nextSequence).toBe(3);
    restore(expired.state, { generation: state.feed.generation, acknowledgementIds: [id] }, "2026-09-21T00:00:00Z");
    expect(expired.state.feed.events.map((event) => event.sequence)).toEqual([2]);
  });

  it("cannot restore expired details and removes closed references only when no activities remain", () => {
    const state = seed();
    const id = acknowledge(state, ack(state), now)!;
    state.feed.pullRequests[0].state = "closed";
    restore(state, { generation: state.feed.generation, acknowledgementIds: [id] }, "2026-09-21T00:00:00Z");
    expect(state.feed.events).toEqual([]);
    expect(state.feed.pullRequests).toEqual([]);
    expect(state.snapshot).not.toBeNull();
  });

  it("retains closed/merged cards without inventing closure events", () => {
    const state = seed();
    const closed = { ...state.feed.pullRequests[0], state: "closed" as const };
    const later = snapshot("2026-09-19T00:00:00Z");
    later.pullRequests = [];
    later.inbox.items = [];
    ingest(state, { snapshot: later, inactivePullRequests: [closed] }, later.generatedAt);
    expect(state.feed.events).toHaveLength(1);
    expect(state.feed.pullRequests[0].state).toBe("closed");
    const merged = snapshot("2026-09-20T00:00:00Z");
    merged.pullRequests = [];
    merged.mergedPullRequests = [{
      repository, number: 1, url: closed.url, title: closed.title, plane: "management",
      holdOn: false, headSha: "head1", mergedAt: merged.generatedAt,
    }];
    merged.inbox.items[0].reasons = ["merged"];
    ingest(state, { snapshot: merged, inactivePullRequests: [] }, merged.generatedAt);
    expect(state.feed.events.map((event) => event.kind)).toEqual(["new-commit", "merged"]);
    expect(state.feed.pullRequests[0].state).toBe("merged");
  });

  it("sanitizes public pull and comment records", () => {
    const raw = snapshot();
    raw.inbox.items[0].reasons = ["new-pr", "new-comment"];
    raw.inbox.items[0].comments = [{
      id: "conversation:10", kind: "conversation", author: "team-member",
      createdAt: now, url: `https://github.com/${repository}/pull/1#issuecomment-10`,
    }];
    Object.assign(raw.inbox.items[0].comments[0], { body: "never publish" });
    Object.assign(raw.pullRequests[0], { email: "never publish", body: "never publish" });
    const state = createState();
    ingest(state, parseIngest({ snapshot: raw, inactivePullRequests: [] }), now);
    expect(JSON.stringify(state.feed)).not.toContain("never publish");
    expect(state.feed.events.map((event) => event.kind)).toEqual(["new-pr", "new-comment"]);
  });

  it("rejects invalid requests and stale card generations", () => {
    for (const body of [null, {}, { ...ack(seed()), throughSequence: 1.5 }]) {
      expect(() => parseAcknowledge(body)).toThrow("Invalid acknowledgement");
    }
    expect(() => parseRestore({ generation: "x", acknowledgementIds: [] })).toThrow();
    expect(() => parseIngest({ snapshot: { ...snapshot(), stale: true }, inactivePullRequests: [] })).toThrow();
    const bad = snapshot();
    bad.inbox.items[0].comments = [null as never];
    expect(() => parseIngest({ snapshot: bad, inactivePullRequests: [] })).toThrow("fields are invalid");
    const state = seed();
    expect(() => acknowledge(state, { ...ack(state), generation: "old" }, now)).toThrow("state changed");
    expect(() => acknowledge(state, ack(state, 1000), now)).toThrow("card changed");
  });

  it("enforces a global persisted mutation limit", () => {
    const state = seed();
    for (let n = 0; n < 120; n++) acknowledge(state, ack(state), now);
    expect(() => acknowledge(state, ack(state), now)).toThrow("Too many");
    expect(() => acknowledge(state, ack(state), "2026-09-18T00:01:00Z")).not.toThrow();
  });
});

describe("conditional storage writes", () => {
  it("initializes once and preserves generation across reads", async () => {
    const blob = memoryStore();
    const first = await updateState(blob, () => undefined);
    const second = await updateState(blob, () => undefined);
    expect(second.state.feed.generation).toBe(first.state.feed.generation);
  });

  it("retains acknowledgements when a collector races a public write", async () => {
    const initial = seed();
    const blob = memoryStore(initial);
    const later = snapshot("2026-09-19T00:00:00Z", "head2");
    await Promise.all([
      updateState(blob, (state) => ingest(state, { snapshot: later, inactivePullRequests: [] }, later.generatedAt)),
      updateState(blob, (state) => acknowledge(state, ack(initial), now, "Alice")),
    ]);
    const result = await updateState(blob, () => undefined);
    expect(result.state.feed.events.map((event) => event.readAt !== null)).toEqual([true, false]);
    expect(result.state.feed.events.map(readerName)).toEqual(["Alice", undefined]);
  });

  it("keeps the winning reader when two readers race on the same card", async () => {
    const initial = seed();
    const blob = memoryStore(initial);
    const outcomes = await Promise.all(["Alice", "Bob"].map((name) =>
      updateState(blob, (state) => acknowledge(state, ack(initial), now, name))));
    const winner = outcomes.find((outcome) => outcome.result !== null)!;
    const result = await updateState(blob, () => undefined);
    expect(outcomes.filter((outcome) => outcome.result !== null)).toHaveLength(1);
    expect(result.state.feed.events[0].readBy).toEqual(winner.state.feed.events[0].readBy);
  });

  it("fails on corrupt or inaccessible storage rather than resetting unread history", async () => {
    let writes = 0;
    const blob: StateBlob = {
      async read() { return { text: "{broken", etag: "1" }; },
      async write() { writes++; },
    };
    await expect(updateState(blob, () => undefined)).rejects.toThrow("unreadable");
    blob.read = async () => { throw new Error("403"); };
    await expect(updateState(blob, () => undefined)).rejects.toThrow("403");
    expect(writes).toBe(0);
    expect(() => validateStoredState({ ...seed(), nextSequence: 1 })).toThrow("invalid");
  });
});
