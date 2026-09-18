import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmitterSnapshot, type EmitterSnapshot } from "../src/data/emitter-contracts";
import { EmitterDashboardView } from "../src/features/emitter/EmitterDashboard";
import { EmitterTable, filterEmitterRows } from "../src/features/emitter/EmitterTable";
import { fetchEmitterSnapshot, type EmitterDataState } from "../src/features/emitter/useEmitterData";

const timestamp = "2026-09-18T00:00:00Z";
function snapshot(): EmitterSnapshot {
  const issue = {
    number: 42, title: "Support emitter options",
    url: "https://github.com/Azure/typespec-azure/issues/42",
    createdAt: timestamp, updatedAt: timestamp,
    author: "contributor", assignees: ["owner"], labels: ["emitter:typescript", "bug"], comments: 3,
  };
  return {
    schemaVersion: 1, generatedAt: timestamp,
    source: { repository: "Azure/typespec-azure", label: "emitter:typescript", fetchedAt: timestamp },
    package: {
      name: "@azure-tools/typespec-ts", version: "0.57.0", publishedAt: timestamp,
      url: "https://www.npmjs.com/package/@azure-tools/typespec-ts",
    },
    issues: [issue],
    pullRequests: [{ ...issue, number: 43, title: "Fix emitter options",
      url: "https://github.com/Azure/typespec-azure/pull/43", draft: true }],
  };
}
function render(state: Partial<EmitterDataState> = {}, now = Date.parse(timestamp)) {
  return renderToStaticMarkup(createElement(EmitterDashboardView, {
    state: { snapshot: snapshot(), loading: false, error: null, ...state }, now,
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("emitter data contract", () => {
  it("accepts complete and genuinely empty snapshots with nullable metadata", () => {
    expect(isEmitterSnapshot(snapshot())).toBe(true);
    const data = snapshot();
    data.issues[0].author = null;
    data.package.publishedAt = null;
    expect(isEmitterSnapshot(data)).toBe(true);
    data.issues = [];
    data.pullRequests = [];
    expect(isEmitterSnapshot(data)).toBe(true);
  });

  it.each([
    ["schemaVersion", 2], ["generatedAt", "invalid"], ["source", null],
    ["source.repository", 5], ["source.label", ""], ["source.fetchedAt", "bad-date"],
    ["package.name", null], ["package.version", ""], ["package.publishedAt", "unknown"],
    ["package.url", "javascript:alert(1)"], ["issues", {}], ["pullRequests", null],
    ["issues.0.number", -1], ["issues.0.title", null], ["issues.0.url", "/relative"],
    ["issues.0.createdAt", ""], ["issues.0.updatedAt", false],
    ["issues.0.author", {}], ["issues.0.assignees", [4]], ["issues.0.labels", null],
    ["issues.0.comments", -1], ["pullRequests.0.draft", "true"],
  ])("rejects malformed %s", (path, value) => {
    const data = snapshot();
    const parts = path.split(".");
    let target = data as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = value;
    expect(isEmitterSnapshot(data)).toBe(false);
  });

  it("requires all intended issue and PR fields", () => {
    for (const field of Object.keys(snapshot().issues[0])) {
      const data = snapshot();
      delete (data.issues[0] as unknown as Record<string, unknown>)[field];
      expect(isEmitterSnapshot(data), field).toBe(false);
    }
    const data = snapshot();
    delete (data.pullRequests[0] as unknown as Record<string, unknown>).draft;
    expect(isEmitterSnapshot(data)).toBe(false);
  });
});

describe("emitter snapshot fetch", () => {
  it("loads the public snapshot with no credentials and validates it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot())));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchEmitterSnapshot()).resolves.toEqual(snapshot());
    expect(fetcher).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}data/emitter.json`, {
      signal: undefined, cache: "no-cache", credentials: "omit",
    });
  });

  it("surfaces HTTP, malformed JSON, and contract failures instead of empty counts", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [], pullRequests: [] })));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchEmitterSnapshot()).rejects.toThrow("404");
    await expect(fetchEmitterSnapshot()).rejects.toThrow();
    await expect(fetchEmitterSnapshot()).rejects.toThrow("unsupported emitter data contract");
  });

  it("directs first-time users to initialize the snapshot through Run workflow", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })));
    let message = "";
    try {
      await fetchEmitterSnapshot();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Refresh data");
    expect(message).toContain("Run workflow");
    expect(message).toContain("initialize");
    const html = render({ snapshot: null, error: message });
    expect(html).toContain("Emitter data is unavailable");
    expect(html).toContain("Run workflow");
    expect(html).not.toContain("Open issues");
    expect(html).not.toContain("Open pull requests");
  });
});

describe("emitter dashboard", () => {
  it("shows npm latest, coverage and tabbed work defaulting to needs attention", () => {
    const html = render();
    expect(html).toContain("@azure-tools/typespec-ts");
    expect(html).toContain("0.57.0");
    expect(html).toContain("npm latest dist-tag");
    expect(html).toContain('href="https://www.npmjs.com/package/@azure-tools/typespec-ts"');
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(html).toContain('aria-pressed="true">Needs attention');
    expect(html).toContain('aria-pressed="false">All open');
    expect(html).not.toContain("Search issues");
    expect(html).not.toContain("Search pull requests");
    expect(html).toContain("Read state is shared across the team");
    expect(html).not.toContain("more than 26 hours old");
    expect(html).toContain("Spector Coverage");
    expect(html).not.toContain("Spector pass rate");
    expect(html).toContain('role="tablist" aria-label="Emitter work"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-selected="true"[^>]*>Open issues/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Open pull requests/);
    expect(html).toMatch(/role="tabpanel"[^>]*hidden=""/);
  });

  it("warns only after 26 hours and uses collection time even when generation is fresh", () => {
    const threshold = Date.parse(timestamp) + 26 * 60 * 60_000;
    expect(render({}, threshold)).not.toContain("more than 26 hours old");
    expect(render({}, threshold + 1)).toContain("more than 26 hours old");
    const data = snapshot();
    data.generatedAt = new Date(threshold + 1).toISOString();
    expect(render({ snapshot: data }, threshold + 1)).toContain("more than 26 hours old");
  });

  it("renders loading, error, and missing snapshot states without misleading zero counts", () => {
    expect(render({ snapshot: null, loading: true })).toContain("Loading JS emitter data");
    const html = render({ snapshot: null, error: "Snapshot request failed (503)" });
    expect(html).toContain("Emitter data is unavailable");
    expect(html).toContain("503");
    expect(html).not.toContain("Open issues");
    expect(html).not.toContain("Open pull requests");
    expect(render({ snapshot: null })).toContain("No emitter snapshot found");
  });

  it("distinguishes genuinely empty data and unavailable metadata", () => {
    const data = snapshot();
    data.issues = [];
    data.pullRequests = [];
    data.package.publishedAt = null;
    const html = render({ snapshot: data });
    expect(html).toContain("No current attention signals");
    expect(html).toContain("Unread activity is not yet confirmed");
    expect(html).toContain("Publication date unavailable");
  });

  it("handles deleted authors and unassigned work", () => {
    const data = snapshot();
    data.issues[0].author = null;
    data.issues[0].assignees = [];
    expect(render({ snapshot: data })).toContain("Unknown author");
    expect(render({ snapshot: data })).toContain("Unassigned");
  });
});

describe("emitter table filtering", () => {
  const filters = { search: "", label: "", draft: "all" as const };
  it("retains complete all-open tables with links, assignees, search and drafts", () => {
    const data = snapshot();
    const issues = renderToStaticMarkup(createElement(EmitterTable, { rows: data.issues, kind: "issues" }));
    const pulls = renderToStaticMarkup(createElement(EmitterTable, { rows: data.pullRequests, kind: "pull requests" }));
    expect(issues).toContain('aria-label="Open emitter issues"');
    expect(pulls).toContain('aria-label="Open emitter pull requests"');
    expect(issues).toContain('href="https://github.com/Azure/typespec-azure/issues/42"');
    expect(pulls).toContain('href="https://github.com/Azure/typespec-azure/pull/43"');
    expect(pulls).toContain(">Draft</span>");
    expect(issues).toContain("Assigned: owner");
    expect(issues).toContain("Search issues");
    expect(pulls).toContain("Search pull requests");
  });
  it.each(["SUPPORT", "#42", "contributor", "owner", "bug"])("searches %s", (search) => {
    expect(filterEmitterRows(snapshot().issues, { ...filters, search })).toHaveLength(1);
  });
  it("combines labels and draft state and returns empty results for unmatched filters", () => {
    const rows = snapshot().pullRequests;
    expect(filterEmitterRows(rows, { ...filters, label: "bug", draft: "draft" })).toHaveLength(1);
    expect(filterEmitterRows(rows, { ...filters, draft: "ready" })).toEqual([]);
    expect(filterEmitterRows(rows, { ...filters, label: "other" })).toEqual([]);
    expect(filterEmitterRows(rows, { ...filters, search: "unknown" })).toEqual([]);
  });
  it("sorts by update time without mutating source order", () => {
    const row = snapshot().issues[0];
    const rows = [row, { ...row, number: 44, updatedAt: "2026-09-19T00:00:00Z" }];
    expect(filterEmitterRows(rows, filters).map((item) => item.number)).toEqual([44, 42]);
    expect(rows[0].number).toBe(42);
  });
});
