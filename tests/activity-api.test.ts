import { describe, expect, it } from "vitest";
import {
  acknowledge, createState, ingest, parseAcknowledge, parseIngest, parseRestore,
  restore, validateStoredState, type ActivityState,
} from "../api/src/engine";
import { updateState, type StateBlob } from "../api/src/store";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";

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
      updateState(blob, (state) => acknowledge(state, ack(initial), now)),
    ]);
    const result = await updateState(blob, () => undefined);
    expect(result.state.feed.events.map((event) => event.readAt !== null)).toEqual([true, false]);
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
