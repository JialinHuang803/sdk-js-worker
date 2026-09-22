import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SharedActivityEvent, SharedActivityFeed, SharedActivityPull } from "../src/data/activity-contracts";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot, type PullRequestRecord } from "../src/data/contracts";
import { ReviewInboxView } from "../src/features/sdk-prs/ReviewInbox";
import { SharedActivityList } from "../src/features/sdk-prs/SharedActivityList";
import {
  acknowledgeGroup, attentionEntries, fetchActivityResponse, groupActivities, parseActivityFeed,
  parseActivityMutation, readActivityResponse,
} from "../src/features/sdk-prs/sharedActivity";
import type { SharedActivityState } from "../src/features/sdk-prs/useSharedActivity";

const repository = "Azure/azure-sdk-for-js";
const time = "2026-09-18T00:00:00Z";
function pull(number: number, overrides: Partial<SharedActivityPull> = {}): SharedActivityPull {
  return {
    repository, number, title: `SDK ${number}`, url: `https://example.test/pull/${number}`,
    plane: "management", draft: false, holdOn: false, state: "open", packages: [], ...overrides,
  };
}
function event(sequence: number, pullRequestNumber: number, overrides: Partial<SharedActivityEvent> = {}): SharedActivityEvent {
  return {
    id: `event-${sequence}`, sequence, repository, pullRequestNumber, kind: "new-commit",
    occurredAt: time, readAt: null, acknowledgementId: null, ...overrides,
  };
}
function feed(overrides: Partial<SharedActivityFeed> = {}): SharedActivityFeed {
  return {
    schemaVersion: 1, generation: "generation-one", revision: 4, collectedAt: time,
    pullRequests: [pull(1)], events: [event(1, 1)], ...overrides,
  };
}
function snapshot(pulls: SharedActivityPull[] = [pull(1)]): DashboardSnapshot {
  const current: PullRequestRecord[] = pulls.map((pr) => ({
    ...pr, headSha: "head", createdAt: time, updatedAt: time, releasePlanUrl: null,
    reviewDecision: "review-required", checks: { failedCount: 2, qualification: "complete", observedCount: 3 },
    conflicts: false, completeness: { changedFiles: "complete", checks: "complete", metadata: "complete", reviews: "complete" },
    warnings: [],
  }));
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: time, stale: false,
    source: { repository, fetchedAt: time, query: "" }, pullRequests: current,
    inbox: { comparisonFrom: null, generatedAt: time, baselineAvailable: false, defaultPlane: "management", items: [] },
  };
}
function state(data: SharedActivityFeed | null, overrides: Partial<SharedActivityState> = {}): SharedActivityState {
  return {
    feed: data, loading: false, pending: false, error: null,
    retry: vi.fn(), acknowledge: vi.fn(), restore: vi.fn(), ...overrides,
  };
}

describe("shared activity grouping", () => {
  it("aggregates multiple days per repository + PR and sorts oldest unread first", () => {
    const data = feed({
      pullRequests: [pull(1), pull(2), pull(1, { repository: "other/repo" })],
      events: [
        event(6, 1, { occurredAt: "2026-09-18T10:00:00Z" }),
        event(2, 2, { occurredAt: "2026-09-16T10:00:00Z" }),
        event(1, 1, { occurredAt: "2026-09-15T10:00:00Z" }),
        event(3, 1, { repository: "other/repo", occurredAt: "2026-09-17T10:00:00Z" }),
      ],
    });
    const groups = groupActivities(data, false);
    expect(groups.map(({ pull: pr }) => `${pr.repository}:${pr.number}`)).toEqual([
      `${repository}:1`, `${repository}:2`, "other/repo:1",
    ]);
    expect(groups[0]).toMatchObject({
      firstAt: "2026-09-15T10:00:00Z", latestAt: "2026-09-18T10:00:00Z", throughSequence: 6,
    });
    expect(groups[0].events).toHaveLength(2);
  });

  it("acknowledges only the displayed unread sequence with its original generation", () => {
    const data = feed({ events: [
      event(2, 1),
      event(8, 1, { readAt: time, acknowledgementId: "read-batch" }),
    ] });
    const displayed = groupActivities(data, false)[0];
    const request = acknowledgeGroup(data, displayed);
    data.events.push(event(9, 1));
    expect(request).toEqual({
      generation: "generation-one", repository, pullRequestNumber: 1, throughSequence: 2,
    });
    expect(groupActivities(data, false)[0].throughSequence).toBe(9);
  });

  it("collects only the selected PR's read batches and keeps other PRs after restoration", () => {
    const data = feed({ pullRequests: [pull(1), pull(2)], events: [
      event(1, 1, { readAt: time, acknowledgementId: "one" }),
      event(2, 1, { readAt: time, acknowledgementId: "one" }),
      event(3, 1, { readAt: time, acknowledgementId: "two" }),
      event(4, 2, { readAt: time, acknowledgementId: "other" }),
    ] });
    const groups = groupActivities(data, true);
    expect(groups[0].acknowledgementIds).toEqual(["one", "two"]);
    const selectedIds = new Set(groups[0].acknowledgementIds);
    const restored = { ...data, events: data.events.map((entry) =>
      entry.acknowledgementId && selectedIds.has(entry.acknowledgementId)
        ? { ...entry, readAt: null, acknowledgementId: null } : entry) };
    expect(groupActivities(restored, false).map(({ pull: pr }) => pr.number)).toEqual([1]);
    expect(groupActivities(restored, true).map(({ pull: pr }) => pr.number)).toEqual([2]);
    expect(restored.events).toHaveLength(4);
  });

  it("retains HoldOn, merged/closed and draft unread activity without consuming events", () => {
    const data = feed({ pullRequests: [
      pull(1, { holdOn: true }), pull(2, { state: "merged" }),
      pull(3, { state: "closed" }), pull(4, { draft: true }),
    ], events: [event(1, 1), event(2, 2), event(3, 3), event(4, 4)] });
    expect(groupActivities(data, false).map(({ pull: pr }) => pr.number)).toEqual([1, 2, 3, 4]);
    expect(data.events.every((entry) => entry.readAt === null)).toBe(true);
    expect(groupActivities({ ...data, pullRequests: data.pullRequests.map((pr) => ({ ...pr, holdOn: false })) }, false)).toHaveLength(4);
  });
});

describe("shared activity UI", () => {
  it("shows each reader once per acknowledgement batch and leaves legacy readers unattributed", () => {
    const data = feed({ events: [
      event(1, 1, { readAt: time, acknowledgementId: "alice", readBy: { name: "Alice", acknowledgementId: "alice" } }),
      event(2, 1, { readAt: time, acknowledgementId: "alice", readBy: { name: "Alice", acknowledgementId: "alice" } }),
      event(3, 1, { readAt: "2026-09-18T01:00:00Z", acknowledgementId: "bob", readBy: { name: "<Bob>", acknowledgementId: "bob" } }),
      event(4, 1, { readAt: time, acknowledgementId: "legacy" }),
      event(5, 1, { readAt: time, acknowledgementId: "legacy-retry", readBy: { name: "Do not show", acknowledgementId: "old-batch" } }),
    ] });
    const html = renderToStaticMarkup(createElement(SharedActivityList, {
      groups: groupActivities(data, true), activity: state(data), read: true,
    }));
    expect(html.match(/Read by <strong>Alice<\/strong>/g)).toHaveLength(1);
    expect(html).toContain("Read by <strong>&lt;Bob&gt;</strong>");
    expect(html).toContain("Reader not recorded");
    expect(html).not.toContain("Do not show");
    expect(html).toContain('dateTime="2026-09-18T01:00:00Z"');
    expect(html.indexOf("&lt;Bob&gt;")).toBeLessThan(html.indexOf(">Alice<"));
    const unread = renderToStaticMarkup(createElement(SharedActivityList, {
      groups: groupActivities(feed(), false), activity: state(feed()),
    }));
    expect(unread).not.toContain('aria-label="Read history"');
  });

  it("renders the same PR in unread and attention, counts it once, and keeps attention headlines persistent", () => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(feed()),
    }));
    expect(html).toContain("Unread activities");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Management <span>1</span>");
    expect(html).toContain("First <time");
    expect(html).toContain("Latest <time");
    expect(html).toContain("Oldest unread first");
    expect(html).toContain("Read state is shared with everyone. Anyone can mark activities as read.");
    expect(html).not.toContain("No sign-in is required.");
    expect(html).toContain(`aria-label="Mark activities as read for ${repository} #1"`);
    const attention = html.slice(html.indexOf("<h3>Needs attention</h3>"));
    expect(attention).toContain("waiting for approval");
    expect(attention).toContain("CI failure");
    expect(attention).not.toContain("New commit");
  });

  it("does not let marking read suppress current attention or use stale inbox reasons", () => {
    const current = snapshot();
    current.inbox.items = [{
      repository, pullRequestNumber: 1, reasons: ["new-pr"], activityAt: time, comments: [],
    }];
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: current, activity: state(feed({ events: [event(1, 1, { readAt: time, acknowledgementId: "ack" })] })),
    }));
    expect(html).toContain("No unread activities");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Management <span>1</span>");
    current.pullRequests[0].reviewDecision = "approved";
    current.pullRequests[0].checks.failedCount = 0;
    expect(attentionEntries(current)).toEqual([]);
  });

  it("includes labeled HoldOn in both blocks and counts it once, while excluding draft attention", () => {
    const pulls = [pull(1, { draft: true }), pull(2, { holdOn: true })];
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(pulls), activity: state(feed({ pullRequests: pulls, events: [event(1, 1), event(2, 2)] })),
    }));
    expect(html).toContain("#1");
    expect(html.match(/>#2<\/a>/g)).toHaveLength(2);
    expect(html.match(/>HoldOn<\/span>/g)).toHaveLength(2);
    expect(html).toContain(">Draft</span>");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Management <span>2</span>");
    expect(attentionEntries(snapshot(pulls)).map(({ pull: pr }) => pr.number)).toEqual([2]);
  });

  it("keeps labeled HoldOn in recently read and in refresh-cycle fallback activity", () => {
    const held = pull(1, { holdOn: true });
    const data = feed({ pullRequests: [held], events: [
      event(1, 1, { readAt: time, acknowledgementId: "held-read" }),
    ] });
    const groups = groupActivities(data, true);
    expect(groups[0].acknowledgementIds).toEqual(["held-read"]);
    const read = renderToStaticMarkup(createElement(SharedActivityList, {
      groups, activity: state(data), read: true,
    }));
    expect(read).toContain(">HoldOn</span>");
    expect(read).toContain("Restore unread");
    expect(groupActivities(data, false)).toEqual([]);
    const current = snapshot([held]);
    current.inbox.items = [{ repository, pullRequestNumber: 1, reasons: ["new-comment"],
      activityAt: time, comments: [] }];
    const fallback = renderToStaticMarkup(createElement(ReviewInboxView, { snapshot: current }));
    expect(fallback).toContain("<h3>New activity</h3>");
    expect(fallback).toContain("<h3>Needs attention</h3>");
    expect(fallback.match(/>HoldOn<\/span>/g)).toHaveLength(2);
    expect(fallback).toContain("Management <span>1</span>");
  });

  it("retains merged and closed cards as badges without synthesizing closure events", () => {
    const data = feed({ pullRequests: [pull(1, { state: "merged" }), pull(2, { state: "closed" })],
      events: [event(1, 1), event(2, 2)] });
    const html = renderToStaticMarkup(createElement(ReviewInboxView, { snapshot: snapshot([]), activity: state(data) }));
    expect(html).toContain(">Merged</span>");
    expect(html).toContain(">Closed</span>");
    expect(html).not.toContain("Needs attention");
    expect(html.match(/1 unread event/g)).toHaveLength(2);
  });

  it("retains recently read restoration without a separate undo button", () => {
    const data = feed({ events: [event(1, 1, { readAt: time, acknowledgementId: "ack" })] });
    const activity = state(data);
    const list = renderToStaticMarkup(createElement(SharedActivityList, {
      groups: groupActivities(data, true), activity, read: true,
    }));
    expect(list).toContain("1 read event");
    expect(list).toContain(`aria-label="Restore read activities for ${repository} #1"`);
    expect(list).toContain("Restore unread");
    expect(list).toContain("Retained for 3 days after marking read");
    const html = renderToStaticMarkup(createElement(ReviewInboxView, { snapshot: snapshot([]), activity }));
    expect(html).toContain("Recently read");
    expect(html).not.toContain("Undo last mark read");
    expect(html).toContain("Management <span>0</span>");
  });

  it.each([
    { error: "Service unavailable", loading: false, pending: false },
    { error: null, loading: true, pending: false },
    { error: null, loading: false, pending: true },
  ])("disables writes when unavailable, refreshing or pending: %j", (overrides) => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(feed(), overrides),
    }));
    expect(html).toContain(`disabled="" aria-label="Mark activities as read for ${repository} #1"`);
    if (overrides.error) {
      expect(html).toContain('role="alert"');
      expect(html).toContain("Showing stale activities");
      expect(html).toContain("Retry loading");
      expect(html).toContain("SDK 1");
    }
  });

  it("does not claim an empty unread feed on initial failure and preserves independent attention", () => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(null, { error: "Network failed" }),
    }));
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("No unread activities");
    expect(html).toContain("Needs attention");
  });

  it("shows loading rather than unavailable before the initial feed arrives", () => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(null, { loading: true }),
    }));
    expect(html).toContain("Loading shared activities");
    expect(html).not.toContain("unavailable");
    expect(html).not.toContain("No unread activities");
  });

  it("labels unseeded feeds as awaiting collection rather than healthy empty inboxes", () => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(feed({ collectedAt: null, events: [], pullRequests: [] })),
    }));
    expect(html).toContain("Awaiting first collection");
    expect(html).not.toContain("No unread activities");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Unread activity never expires");
  });

  it("distinguishes the attention snapshot timestamp from the shared activity collection", () => {
    const activityTime = "2026-09-17T12:00:00Z";
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(feed({ collectedAt: activityTime })),
    }));
    expect(html).toContain(`Attention: ${new Date(time).toLocaleString()}`);
    expect(html).toContain(`Activities: ${new Date(activityTime).toLocaleString()}`);
  });

  it("combines matching collection times into one compact toolbar label", () => {
    const html = renderToStaticMarkup(createElement(ReviewInboxView, {
      snapshot: snapshot(), activity: state(feed({ collectedAt: time })),
    }));
    expect(html).toContain(`Updated ${new Date(time).toLocaleString()}`);
    expect(html).not.toContain("Attention:");
    expect(html).not.toContain("Activities:");
    expect(html).not.toContain("No sign-in is required.");
  });

  it("honestly falls back to refresh-cycle activity without an API URL", () => {
    const current = snapshot();
    current.inbox.items = [{ repository, pullRequestNumber: 1, reasons: ["new-commit", "review-needed"],
      activityAt: time, comments: [] }];
    const html = renderToStaticMarkup(createElement(ReviewInboxView, { snapshot: current }));
    expect(html).toContain("Shared read state is not configured");
    expect(html).toContain("<h3>New activity</h3>");
    expect(html).toContain("<h3>Needs attention</h3>");
    expect(html).toContain("Management <span>1</span>");
    expect(html).not.toContain("Unread activities");
    expect(html).not.toContain("Mark read");
  });
});

describe("activity API boundary", () => {
  it("validates feeds and mutation responses without losing read markers", () => {
    const data = feed({ events: [event(1, 1, { readAt: time, acknowledgementId: "ack" })] });
    expect(parseActivityFeed(data)).toEqual(data);
    expect(parseActivityMutation({ feed: data, acknowledgementId: "ack" }))
      .toEqual({ feed: data, acknowledgementId: "ack" });
    expect(parseActivityMutation({ feed: data, acknowledgementId: null }).acknowledgementId).toBeNull();
  });

  it.each([
    null, {}, { ...feed(), generation: "" }, { ...feed(), revision: -1 },
    { ...feed(), events: [event(1, 1, { readAt: time })] },
    { ...feed(), events: [event(1, 1, { occurredAt: "invalid" })] },
    { ...feed(), events: [event(1, 1), event(1, 1)] },
    { ...feed(), events: [event(1, 999)] },
    { ...feed(), pullRequests: [pull(1, { url: "javascript:alert(1)" })] },
    { ...feed(), pullRequests: [pull(1), pull(1)] },
  ])("rejects malformed and unsafe responses %#", (value) => {
    expect(() => parseActivityFeed(value)).toThrow("Invalid activity response");
  });

  it("rejects mutation responses without an acknowledgement result", () => {
    expect(() => parseActivityMutation({ feed: feed() })).toThrow("Invalid activity mutation response");
  });

  it("surfaces structured API errors, non-JSON failures, and successful malformed bodies", async () => {
    await expect(readActivityResponse(new Response(JSON.stringify({ error: "Generation changed; reload" }), { status: 409 })))
      .rejects.toThrow("Generation changed; reload (HTTP 409)");
    await expect(readActivityResponse(new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })))
      .rejects.toThrow("Too many requests (HTTP 429)");
    await expect(readActivityResponse(new Response("<html>unavailable</html>", { status: 502 })))
      .rejects.toThrow("unreadable response (HTTP 502)");
    await expect(readActivityResponse(new Response(JSON.stringify({}), { status: 500 })))
      .rejects.toThrow("Request failed (HTTP 500)");
    const value = await readActivityResponse(new Response(JSON.stringify({ unexpected: true })));
    expect(() => parseActivityFeed(value)).toThrow("Invalid activity response");
  });

  it.each(["fetch", "body"] as const)("times out a hung %s and aborts its request", async (stage) => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch");
    let requestSignal: AbortSignal | null | undefined;
    const body = new Response();
    vi.spyOn(body, "json").mockImplementation(() => new Promise(() => {}));
    fetcher.mockImplementation((_url, options) => {
      requestSignal = options?.signal;
      return stage === "fetch" ? new Promise(() => {}) : Promise.resolve(body);
    });
    try {
      const pending = fetchActivityResponse("https://example.test/api/activity", {}, new AbortController().signal);
      const result = expect(pending).rejects.toThrow("timed out after 15 seconds");
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clears the request timeout on success and preserves caller cancellation", async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(feed())));
      await expect(fetchActivityResponse("https://example.test/api/activity", {}, new AbortController().signal))
        .resolves.toEqual(feed());
      expect(vi.getTimerCount()).toBe(0);
      fetcher.mockImplementationOnce(() => new Promise(() => {}));
      const controller = new AbortController();
      const pending = fetchActivityResponse("https://example.test/api/activity", {}, controller.signal);
      const result = expect(pending).rejects.toThrow("Caller cancelled");
      controller.abort(new Error("Caller cancelled"));
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
