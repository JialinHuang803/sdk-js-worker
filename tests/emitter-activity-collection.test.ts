import { describe, expect, it, vi } from "vitest";
import { collectEmitterActivity, type EmitterActivityOptions } from "../scripts/emitter-activity";
import { isEmitterSnapshot, type EmitterSnapshot } from "../src/data/emitter-contracts";

const before = "2026-09-17T00:00:00Z";
const after = "2026-09-18T00:00:00Z";
const changed = "2026-09-17T12:00:00Z";
function snapshot(time = after): EmitterSnapshot {
  const issue = {
    number: 1, title: "Emitter work", url: "https://github.com/Azure/typespec-azure/issues/1",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: changed,
    author: "contributor", assignees: [], labels: ["emitter:typescript"], comments: 2,
  };
  return {
    schemaVersion: 1, generatedAt: time,
    source: { repository: "Azure/typespec-azure", label: "emitter:typescript", fetchedAt: time },
    package: { name: "@azure-tools/typespec-ts", version: "1.0.0", publishedAt: null,
      url: "https://www.npmjs.com/package/@azure-tools/typespec-ts" },
    issues: [issue],
    pullRequests: [{ ...issue, number: 2, url: "https://github.com/Azure/typespec-azure/pull/2",
      draft: false, headSha: time === before ? "old-head" : "new-head",
      requestedReviewers: ["reviewer"], requestedTeams: [] }],
    activity: { comparisonFrom: null, events: [], excludedIssueNumbers: [5313] },
  };
}
function options(previous: EmitterSnapshot | null = snapshot(before)): EmitterActivityOptions {
  return {
    previous, excludedIssueNumbers: [5313],
    comments: {
      excludedCommentAuthorPatterns: ["JialinHuang803", "kazrael2119", "github-actions*", "*copilot*", "azure-pipelines*"],
      includeConversationComments: true, includeReviewComments: true,
      includeReviewSummaries: true, publishCommentBody: false,
    },
  };
}
const comment = {
  id: 12, user: { login: "contributor", email: "private@example.test" },
  created_at: changed, html_url: "https://github.com/Azure/typespec-azure/issues/1#issuecomment-12",
  body: "Private body should never be published",
};
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers });

describe("emitter activity collection", () => {
  it("establishes a baseline without making the backlog look new", async () => {
    for (const previous of [null, { ...snapshot(before), activity: undefined }]) {
      const current = snapshot();
      const get = vi.fn();
      await collectEmitterActivity(current, options(previous), get);
      expect(current.activity).toEqual({ comparisonFrom: null, events: [], excludedIssueNumbers: [5313] });
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("only calls genuinely newly created work new, and detects current head changes", async () => {
    const current = snapshot();
    current.issues.push({ ...current.issues[0], number: 3, createdAt: changed });
    current.issues.push({ ...current.issues[0], number: 4 }); // old issue newly labeled
    current.pullRequests.push({ ...current.pullRequests[0], number: 5, createdAt: changed });
    const get = vi.fn(async () => json([]));
    await collectEmitterActivity(current, options(), get);
    expect(current.activity?.events.map((event) => [event.number, event.kind])).toEqual([
      [3, "new-issue"], [5, "new-pr"], [2, "new-commit"],
    ]);
    expect(isEmitterSnapshot(current)).toBe(true);
  });

  it("paginates and deduplicates each comment source, excludes bots, edits, approvals and future events", async () => {
    const current = snapshot();
    const requested: string[] = [];
    const get = vi.fn(async (path: string) => {
      requested.push(path);
      if (path.includes("/reviews")) return json([
        { ...comment, id: 20, state: "APPROVED", submitted_at: changed },
        { ...comment, id: 21, state: "PENDING", submitted_at: null },
        { ...comment, id: 22, state: "COMMENTED", submitted_at: changed, body: "" },
        { ...comment, id: 23, state: "CHANGES_REQUESTED", submitted_at: changed },
      ]);
      if (path.includes("page=2")) return json([comment, { ...comment, id: 13 }]);
      return json([
        comment,
        ...["JialinHuang803", "kazrael2119", "github-actions[bot]", "Copilot", "azure-pipelines[bot]"]
          .map((login, index) => ({ ...comment, id: 30 + index, user: { login } })),
        { ...comment, id: 40, created_at: before, updated_at: changed },
        { ...comment, id: 41, created_at: "2026-09-19T00:00:00Z" },
      ], { link: '<https://api.github.com/next>; rel="next"' });
    });
    await collectEmitterActivity(current, options(), get);
    expect(requested.filter((path) => path.includes("page=2"))).toHaveLength(3);
    expect(requested.filter((path) => path.includes("since="))).toHaveLength(6);
    const comments = current.activity!.events.filter((event) => event.kind === "new-comment");
    expect(comments).toHaveLength(7);
    expect(new Set(comments.map((event) => event.id)).size).toBe(7);
    expect(JSON.stringify(current)).not.toMatch(/Private body|private@example|"body"|"email"|azure-pipelines/);
  });

  it("fetches past a full page without a Link header", async () => {
    const current = snapshot();
    current.pullRequests = [];
    const get = vi.fn()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, id) => ({ ...comment, id: id + 1 }))))
      .mockResolvedValueOnce(json([{ ...comment, id: 101 }]));
    await collectEmitterActivity(current, options(), get);
    expect(current.activity!.events).toHaveLength(101);
  });

  it("excludes configured tracking issues, but keeps them in the inventory", async () => {
    const current = snapshot();
    current.issues = [{ ...current.issues[0], number: 5313, createdAt: changed }];
    current.pullRequests = [];
    const get = vi.fn();
    await collectEmitterActivity(current, options(), get);
    expect(current.issues).toHaveLength(1);
    expect(current.activity!.events).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("supports deleted authors and respects disabled comment sources", async () => {
    const current = snapshot();
    const config = options();
    config.comments.includeReviewComments = false;
    config.comments.includeReviewSummaries = false;
    const get = vi.fn(async () => json([{ ...comment, user: null }]));
    await collectEmitterActivity(current, config, get);
    expect(get).toHaveBeenCalledTimes(2);
    expect(current.activity!.events.filter((event) => event.kind === "new-comment")
      .every((event) => event.author === "deleted-user")).toBe(true);
  });

  it("does not infer commits when the prior SHA is unavailable", async () => {
    const prior = snapshot(before);
    delete prior.pullRequests[0].headSha;
    const current = snapshot();
    await collectEmitterActivity(current, options(prior), async () => json([]));
    expect(current.activity!.events).toEqual([]);
  });

  it("fails instead of silently losing activity on an API failure", async () => {
    await expect(collectEmitterActivity(snapshot(), options(), async () => {
      throw new Error("HTTP 403");
    })).rejects.toThrow("HTTP 403");
  });

  it("rejects future or cross-source baselines and malformed activity metadata", async () => {
    await expect(collectEmitterActivity(snapshot(), options(snapshot(after)), vi.fn())).rejects.toThrow("baseline");
    const other = snapshot(before);
    other.source.repository = "Azure/other";
    await expect(collectEmitterActivity(snapshot(), options(other), vi.fn())).rejects.toThrow("baseline");
    const current = snapshot();
    current.activity!.comparisonFrom = "2027-01-01T00:00:00Z";
    expect(isEmitterSnapshot(current)).toBe(false);
    current.activity!.comparisonFrom = before;
    current.pullRequests[0].requestedReviewers = [""];
    expect(isEmitterSnapshot(current)).toBe(false);
  });

  it("rejects duplicate, orphaned, wrongly typed and out-of-window events", () => {
    const current = snapshot();
    const event = { id: "issue:1", number: 1, kind: "new-issue" as const,
      occurredAt: changed, url: current.issues[0].url };
    current.activity = { comparisonFrom: before, excludedIssueNumbers: [5313], events: [event] };
    expect(isEmitterSnapshot(current)).toBe(true);
    for (const events of [
      [event, event], [{ ...event, number: 99 }], [{ ...event, number: 2 }],
      [{ ...event, occurredAt: before }], [{ ...event, occurredAt: "2027-01-01T00:00:00Z" }],
    ]) {
      current.activity.events = events;
      expect(isEmitterSnapshot(current)).toBe(false);
    }
    current.activity.events = [event];
    current.activity.comparisonFrom = null;
    expect(isEmitterSnapshot(current)).toBe(false);
    current.activity.events = [];
    current.pullRequests[0].number = 1;
    expect(isEmitterSnapshot(current)).toBe(false);
  });
});
