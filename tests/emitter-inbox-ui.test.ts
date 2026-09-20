import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmitterActivityFeed } from "../src/data/emitter-activity-contracts";
import type { EmitterIssue, EmitterPullRequest, EmitterSnapshot } from "../src/data/emitter-contracts";
import { EmitterActivityNotice, EmitterInboxView } from "../src/features/emitter/EmitterInbox";
import { EmitterDashboardView } from "../src/features/emitter/EmitterDashboard";
import { EmitterTable } from "../src/features/emitter/EmitterTable";
import { emitterAcknowledgementIds, emitterInboxEntries, emitterRelativeTime, type EmitterInboxEvent } from "../src/features/emitter/emitterInboxModel";
import {
  createEmitterActivityClient, parseEmitterFeed, parseEmitterMutation,
  unavailableEmitterActivity, type EmitterActivityState,
} from "../src/features/emitter/useEmitterActivity";

const timestamp = "2026-09-18T00:00:00Z";
const now = Date.parse(timestamp);
const issue: EmitterIssue = {
  number: 42, title: "Support emitter options", url: "https://github.com/Azure/typespec-azure/issues/42",
  createdAt: timestamp, updatedAt: timestamp, author: "author", assignees: [], labels: ["emitter:typescript"], comments: 2,
};
const pull: EmitterPullRequest = {
  ...issue, number: 43, title: "Fix emitter options", url: "https://github.com/Azure/typespec-azure/pull/43",
  draft: false, requestedReviewers: [], requestedTeams: [],
};
function event(overrides: Partial<EmitterInboxEvent> = {}): EmitterInboxEvent {
  return {
    id: "comment-1", number: 42, sequence: 1, kind: "new-comment", occurredAt: timestamp,
    url: `${issue.url}#issuecomment-1`, readAt: null, acknowledgementId: null, ...overrides,
  };
}
function feed(overrides: Partial<EmitterActivityFeed> = {}): EmitterActivityFeed {
  return {
    schemaVersion: 1, generation: "generation-1", revision: 1, collectedAt: timestamp,
    issues: [issue], pullRequests: [pull], events: [event()], excludedIssueNumbers: [5313], ...overrides,
  };
}
function state(overrides: Partial<EmitterActivityState> = {}): EmitterActivityState {
  return { feed: feed(), configured: true, canWrite: true, pending: false, loading: false, error: null, ...overrides };
}
const actions = { retry: vi.fn(), acknowledge: vi.fn(), restore: vi.fn() };
function renderInbox(activity = state(), items: Array<EmitterIssue | EmitterPullRequest> = [issue]) {
  return renderToStaticMarkup(createElement(EmitterInboxView, {
    activity, items, excludedIssueNumbers: [5313], now, kind: "issues", actions,
  }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("emitter attention grouping", () => {
  it("shows reader names and times in recently read, with an honest legacy fallback", () => {
    const assigned = { ...issue, assignees: ["owner"] };
    const events = [
      event({ readAt: timestamp, acknowledgementId: "alice", readBy: { name: "Alice", acknowledgementId: "alice" } }),
      event({ id: "second", sequence: 2, readAt: timestamp, acknowledgementId: "alice", readBy: { name: "Alice", acknowledgementId: "alice" } }),
      event({ id: "third", sequence: 3, readAt: timestamp, acknowledgementId: "bob", readBy: { name: "<Bob>", acknowledgementId: "bob" } }),
      event({ id: "legacy", sequence: 4, readAt: timestamp, acknowledgementId: "legacy" }),
      event({ id: "stale", sequence: 5, readAt: timestamp, acknowledgementId: "legacy-retry", readBy: { name: "Do not show", acknowledgementId: "old-batch" } }),
    ];
    const html = renderInbox(state({ feed: feed({ issues: [assigned], events }) }), [assigned]);
    expect(html).toContain('aria-label="Recently read issues"');
    expect(html.match(/Read by <strong>Alice<\/strong>/g)).toHaveLength(1);
    expect(html).toContain("Read by <strong>&lt;Bob&gt;</strong>");
    expect(html).toContain("Reader not recorded");
    expect(html).not.toContain("Do not show");
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(renderInbox()).not.toContain('aria-label="Read history"');
    expect(renderInbox(state({ feed: feed({ events }) }))).toContain("Read by <strong>Alice</strong>");
  });

  it("uses readable relative times without losing the exact timestamp", () => {
    expect(emitterRelativeTime(timestamp, now)).toBe("Just now");
    expect(emitterRelativeTime(timestamp, now + 5 * 60_000)).toBe("5 minutes ago");
    expect(emitterRelativeTime(timestamp, now + 2 * 3_600_000)).toBe("2 hours ago");
    expect(emitterRelativeTime(timestamp, now + 86_400_000)).toBe("yesterday");
    const html = renderInbox();
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(html).toContain("Just now");
    expect(renderInbox(state({ feed: feed({ events: [] }) }))).toContain("Updated");
  });

  it("combines current state and distinct activities into one row per work item", () => {
    const events = [event(), event({ id: "new-42", sequence: 2, kind: "new-issue" })];
    const grouped = emitterInboxEntries([issue], events, [], now);
    expect(grouped.attention).toHaveLength(1);
    expect(grouped.attention[0].signals).toEqual(["Unassigned"]);
    expect(grouped.attention[0].unread).toHaveLength(2);
    const html = renderInbox(state({ feed: feed({ events }) }));
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain("Unassigned");
    expect(html).toContain("New issue");
    expect(html).toContain("New comment");
    expect(html).not.toMatch(/needs.triage/i);
  });

  it("requires explicit reviewers or teams, never infers review requests from non-draft", () => {
    expect(emitterInboxEntries([pull], [], [], now).attention).toEqual([]);
    for (const reviewed of [{ ...pull, requestedReviewers: ["reviewer"] }, { ...pull, requestedTeams: ["team"] }]) {
      expect(emitterInboxEntries([reviewed], [], [], now).attention[0].signals).toEqual(["Review requested"]);
    }
    expect(emitterInboxEntries([{ ...pull, requestedReviewers: undefined, requestedTeams: undefined }], [], [], now)
      .attention).toEqual([]);
  });

  it("surfaces drafts only for discussion and displays every event covered by acknowledgement", () => {
    const draft = { ...pull, draft: true, requestedReviewers: ["reviewer"] };
    const events = [event({ number: 43, kind: "new-pr" }),
      event({ id: "commit", sequence: 2, number: 43, kind: "new-commit" })];
    expect(emitterInboxEntries([draft], events, [], now).attention).toEqual([]);
    events.push(event({ id: "comment", sequence: 3, number: 43 }));
    const grouped = emitterInboxEntries([draft], events, [], now);
    expect(grouped.attention[0].signals).toEqual([]);
    expect(grouped.attention[0].unread.map((entry) => entry.kind)).toEqual(["new-pr", "new-commit", "new-comment"]);
    const html = renderInbox(state({ feed: feed({ events }) }), [draft]);
    expect(html).toContain("Draft");
    expect(html).toContain("New comment");
    expect(html).toContain("New commits");
    expect(html).not.toContain("Review requested");
  });

  it("excludes configured tracking issues while leaving source tables unchanged", () => {
    const tracking = { ...issue, number: 5313 };
    const items = [issue, tracking, { ...issue, number: 99 }];
    expect(emitterInboxEntries(items, [event({ number: 5313 })], [5313, 99], now).attention.map((e) => e.item.number))
      .toEqual([42]);
    expect(items).toHaveLength(3);
    const trackingFeed = feed({ issues: [issue, tracking], events: [] });
    expect(parseEmitterFeed(trackingFeed).issues).toHaveLength(2);
    const inbox = renderInbox(state({ feed: trackingFeed }), trackingFeed.issues);
    expect(inbox).not.toContain(">#5313</a>");
    const allOpen = renderToStaticMarkup(createElement(EmitterTable, { rows: trackingFeed.issues, kind: "issues" }));
    expect(allOpen).toContain("#5313 Support emitter options");
    expect(allOpen).toContain("2 of 2 open issues");
  });

  it("read clears only activity, keeps current signals, and offers restore without duplicate rows", () => {
    const read = event({ readAt: timestamp, acknowledgementId: "ack-1" });
    const grouped = emitterInboxEntries([issue], [read], [], now);
    expect(grouped.attention[0].signals).toEqual(["Unassigned"]);
    expect(grouped.attention[0].unread).toEqual([]);
    expect(emitterAcknowledgementIds(grouped.attention[0])).toEqual(["ack-1"]);
    expect(grouped.recentlyRead).toEqual([]);
    const html = renderInbox(state({ feed: feed({ events: [read] }) }));
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain("Restore unread");
    expect(html).not.toContain(">Mark read");
    expect(html).toContain("Unassigned");
    const requested = { ...pull, requestedTeams: ["sdk"] };
    expect(emitterInboxEntries([requested], [event({ ...read, number: 43 })], [], now).attention[0].signals)
      .toEqual(["Review requested"]);
  });

  it("shows recently read for three days and removes it when expired", () => {
    const assigned = { ...issue, assignees: ["owner"] };
    const read = event({ readAt: timestamp, acknowledgementId: "ack-1" });
    expect(emitterInboxEntries([assigned], [read], [], now + 3 * 86_400_000).recentlyRead).toHaveLength(1);
    expect(emitterInboxEntries([assigned], [read], [], now + 3 * 86_400_000 + 1).recentlyRead).toEqual([]);
    const html = renderInbox(state({ feed: feed({ events: [read] }) }), [assigned]);
    expect(html).toContain("Recently read");
    expect(html).toContain("Last 3 days");
    expect(html).toContain("Restore unread");
  });
});

describe("emitter inbox states", () => {
  it("makes shared read behavior explicit and links have no implicit read action", () => {
    const notice = renderToStaticMarkup(createElement(EmitterActivityNotice, { activity: state() }));
    expect(notice).toContain("Read state is shared across the team");
    expect(notice).toContain("Opening a link never marks it read");
    const html = renderInbox();
    expect(html).toContain(`href="${issue.url}" target="_blank"`);
    expect(html).toContain(`href="${issue.url}#issuecomment-1" target="_blank"`);
    expect(html).toContain('aria-label="Mark activity read for #42"');
    expect(actions.acknowledge).not.toHaveBeenCalled();
    expect(html).not.toContain('disabled=""');
  });

  it("surfaces errors, preserves stale activity and disables actions", () => {
    const activity = state({ error: "Activity service failed (HTTP 503)", canWrite: false });
    const html = renderInbox(activity);
    expect(html).toContain("New comment");
    expect(html).toContain('disabled=""');
    const notice = renderToStaticMarkup(createElement(EmitterActivityNotice, { activity, retry: actions.retry }));
    expect(notice).toContain('role="alert"');
    expect(notice).toContain("503");
    expect(notice).toContain("Showing the last available activity");
    expect(notice).toContain("Retry loading");
  });

  it("does not invent activity or claim an empty success before initialization", () => {
    const activity = state({ feed: feed({ collectedAt: null, events: [], issues: [], pullRequests: [] }), canWrite: false });
    expect(renderInbox(activity)).not.toContain("New issue");
    const notice = renderToStaticMarkup(createElement(EmitterActivityNotice, { activity }));
    expect(notice).toContain("has not been initialized");
    expect(notice).toContain("older snapshot has no activity baseline");
    expect(notice).toContain("initial collection creates no new activity");
    const baseline = renderToStaticMarkup(createElement(EmitterActivityNotice, {
      activity, baseline: { comparisonFrom: null, events: [], excludedIssueNumbers: [5313] },
    }));
    expect(baseline).toContain("An activity baseline has been established");
    expect(renderInbox(unavailableEmitterActivity, [])).toContain("Unread activity is not yet confirmed");
  });

  it("uses newer initialized feed work and counters while keeping package and coverage snapshots", () => {
    const snapshot: EmitterSnapshot = {
      schemaVersion: 1, generatedAt: "2026-09-17T00:00:00Z",
      source: { repository: "Azure/typespec-azure", label: "emitter:typescript", fetchedAt: "2026-09-17T00:00:00Z" },
      package: { name: "@azure-tools/typespec-ts", version: "1.0.0", publishedAt: null, url: "https://npmjs.com/" },
      issues: [], pullRequests: [],
    };
    const html = renderToStaticMarkup(createElement(EmitterDashboardView, {
      state: { snapshot, loading: false, error: null }, activity: state(), now,
    }));
    expect(html).toContain(issue.title);
    expect(html).toContain("Open work and counts use the shared feed");
    expect(html).toContain("Package and coverage use the published snapshot");
    expect(html).toContain("Spector Coverage");
  });

  it("distinguishes activity collection freshness from polling read state", () => {
    const html = renderToStaticMarkup(createElement(EmitterActivityNotice, {
      activity: state(), now: now + 27 * 60 * 60_000,
    }));
    expect(html).toContain("Activity collection is more than 26 hours old");
    expect(html).toContain("Polling checks shared read state");
  });
});

describe("emitter activity transport and races", () => {
  function setup() {
    let latest = unavailableEmitterActivity;
    const client = createEmitterActivityClient("https://example.test/api/", (next) => { latest = next; });
    return { client, state: () => latest };
  }
  const response = (value: unknown) => new Response(JSON.stringify(value));

  it("validates feeds and mutation wrappers rather than accepting malformed empty data", () => {
    expect(parseEmitterFeed(feed())).toEqual(feed());
    expect(() => parseEmitterFeed({ events: [] })).toThrow("Invalid emitter");
    expect(() => parseEmitterMutation({ feed: feed() })).toThrow("Invalid emitter");
    expect(() => parseEmitterFeed(feed({ events: [event(), event()] }))).toThrow();
  });

  it("disables writes for an uninitialized feed and makes no requests without configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(feed({
      collectedAt: null, events: [], issues: [], pullRequests: [],
    })));
    vi.stubGlobal("fetch", fetcher);
    const unconfigured = createEmitterActivityClient(undefined, vi.fn());
    await unconfigured.refresh();
    expect(fetcher).not.toHaveBeenCalled();
    unconfigured.dispose();
    const { client, state } = setup();
    await client.refresh();
    expect(state().canWrite).toBe(false);
    await client.acknowledge({ generation: "generation-1", number: 42, throughSequence: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("keeps an initial service failure distinct from an empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503 }),
    ));
    const { client, state } = setup();
    await client.refresh();
    expect(state().feed).toBeNull();
    expect(state().loading).toBe(false);
    expect(state().error).toContain("503");
    expect(state().canWrite).toBe(false);
    const html = renderToStaticMarkup(createElement(EmitterActivityNotice, { activity: state() }));
    expect(html).toContain("this is not an empty inbox");
    client.dispose();
  });

  it("loads credential-free emitter endpoint and bounds acknowledgements to observed sequences", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(feed()))
      .mockResolvedValueOnce(response({ feed: feed({ revision: 2 }), acknowledgementId: "ack-1" }))
      .mockResolvedValueOnce(response({ feed: feed({ revision: 3 }), acknowledgementId: null }));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    await client.refresh();
    expect(fetcher.mock.calls[0][0]).toBe("https://example.test/api/emitter-activity");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    const ack = { generation: "generation-1", number: 42, throughSequence: 1 };
    await client.acknowledge(ack);
    expect(fetcher.mock.calls[1][0]).toBe("https://example.test/api/emitter-activity/ack");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify(ack));
    await client.restore({ generation: "generation-1", acknowledgementIds: ["ack-1"] });
    expect(fetcher.mock.calls[2][0]).toBe("https://example.test/api/emitter-activity/restore");
    expect(state().feed?.revision).toBe(3);
    expect(state().canWrite).toBe(true);
    client.dispose();
  });

  it("preserves feed after HTTP errors and requires successful reload after uncertain writes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(feed()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(response(feed({ revision: 2 })));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    await client.refresh();
    await client.acknowledge({ generation: "generation-1", number: 42, throughSequence: 1 });
    expect(state().feed).toEqual(feed());
    expect(state().error).toContain("HTTP 503");
    expect(state().error).toContain("may not have been saved");
    expect(state().canWrite).toBe(false);
    await client.restore({ generation: "generation-1", acknowledgementIds: ["ack"] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await client.refresh();
    expect(state().canWrite).toBe(true);
    expect(state().error).toBeNull();
    client.dispose();
  });

  it("rejects regressing revisions from GET and mutation without losing existing data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(feed({ revision: 5 })))
      .mockResolvedValueOnce(response(feed({ revision: 4 })))
      .mockResolvedValueOnce(response(feed({ revision: 5 })))
      .mockResolvedValueOnce(response({ feed: feed({ revision: 3 }), acknowledgementId: "ack" }));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    await client.refresh();
    await client.refresh();
    expect(state().feed?.revision).toBe(5);
    expect(state().canWrite).toBe(false);
    await client.refresh();
    await client.acknowledge({ generation: "generation-1", number: 42, throughSequence: 1 });
    expect(state().feed?.revision).toBe(5);
    expect(state().canWrite).toBe(false);
    expect(state().error).toContain("older or changed feed");
    client.dispose();
  });

  it("rejects retired generations and generation-changing mutations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(feed()))
      .mockResolvedValueOnce(response(feed({ generation: "generation-2" })))
      .mockResolvedValueOnce(response(feed()))
      .mockResolvedValueOnce(response(feed({ generation: "generation-2" })))
      .mockResolvedValueOnce(response({ feed: feed({ generation: "generation-3" }), acknowledgementId: "ack" }));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    await client.refresh();
    await client.refresh();
    await client.refresh();
    expect(state().feed?.generation).toBe("generation-2");
    expect(state().canWrite).toBe(false);
    await client.refresh();
    await client.acknowledge({ generation: "generation-2", number: 42, throughSequence: 1 });
    expect(state().feed?.generation).toBe("generation-2");
    expect(state().canWrite).toBe(false);
    client.dispose();
  });

  it("ignores older in-flight GETs even when the transport ignores abort", async () => {
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(old)
      .mockResolvedValueOnce(response(feed({ generation: "generation-2", revision: 2 })));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    const first = client.refresh();
    await client.refresh();
    resolveOld(response(feed({ revision: 20 })));
    await first;
    expect(state().feed?.generation).toBe("generation-2");
    expect(state().feed?.revision).toBe(2);
    expect(state().error).toBeNull();
    client.dispose();
  });

  it("blocks polling and duplicate writes during a mutation and ignores disposed responses", async () => {
    let resolveMutation!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(feed())).mockReturnValueOnce(delayed);
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    await client.refresh();
    const mutation = client.acknowledge({ generation: "generation-1", number: 42, throughSequence: 1 });
    expect(state().pending).toBe(true);
    expect(state().canWrite).toBe(false);
    await client.refresh();
    await client.restore({ generation: "generation-1", acknowledgementIds: ["ack"] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
    resolveMutation(response({ feed: feed({ revision: 2 }), acknowledgementId: "ack" }));
    await mutation;
    expect(state().feed?.revision).toBe(1);
  });
});
