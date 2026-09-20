import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedActivityFeed } from "../src/data/activity-contracts";
import type { EmitterActivityFeed } from "../src/data/emitter-activity-contracts";
import { DASHBOARD_SCHEMA_VERSION, type DashboardSnapshot } from "../src/data/contracts";
import viteConfig from "../vite.config";
import { EmitterActivityNotice, EmitterInboxView } from "../src/features/emitter/EmitterInbox";
import { createEmitterActivityClient, unavailableEmitterActivity } from "../src/features/emitter/useEmitterActivity";
import { ReviewInboxView } from "../src/features/sdk-prs/ReviewInbox";
import { SharedActivityList } from "../src/features/sdk-prs/SharedActivityList";
import { ActivityResponseError, groupActivities, readActivityResponse } from "../src/features/sdk-prs/sharedActivity";
import {
  ActivityAuthContext, ActivityAuthControls, ActivityAuthProvider, canChangeActivity,
  createActivityAuthClient, parseActivitySession, publicActivityTransport, type ActivityAuthState,
} from "../src/shared/ActivityAuth";

const signedIn = { authenticated: true, login: "octocat", csrfToken: "session-csrf" };
const signedOut = { authenticated: false, login: null, csrfToken: null };
const ready: ActivityAuthState = { session: signedIn, loading: false, error: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const now = "2026-09-18T00:00:00Z";
const sdkFeed: SharedActivityFeed = {
  schemaVersion: 1, generation: "generation-1", revision: 1, collectedAt: now,
  pullRequests: [{
    repository: "Azure/azure-sdk-for-js", number: 42, title: "SDK work", url: "https://example.test/42",
    plane: "management", draft: false, holdOn: false, state: "open", packages: [],
  }],
  events: [{
    id: "event-1", sequence: 1, repository: "Azure/azure-sdk-for-js", pullRequestNumber: 42,
    kind: "new-commit", occurredAt: now, readAt: null, acknowledgementId: null,
  }],
};
const emitterFeed: EmitterActivityFeed = {
  schemaVersion: 1, generation: "generation-1", revision: 1, collectedAt: now,
  issues: [{
    number: 42, title: "Emitter work", url: "https://example.test/42",
    createdAt: now, updatedAt: now, author: "octocat", assignees: [], labels: [], comments: 1,
  }], pullRequests: [], excludedIssueNumbers: [],
  events: [{
    id: "event-1", number: 42, sequence: 1, kind: "new-comment", occurredAt: now,
    url: "https://example.test/42#comment-1", readAt: null, acknowledgementId: null,
  }],
};
const actions = { retry: vi.fn(), acknowledge: vi.fn(), restore: vi.fn() };
function renderWithAuth(children: ReactNode, state = ready, enabled = true) {
  return renderToStaticMarkup(createElement(ActivityAuthContext.Provider, {
    value: {
      enabled, state, transport: publicActivityTransport, loginUrl: "/api/auth/login",
      refresh: vi.fn(), logout: vi.fn(),
    }, children,
  }));
}
function setup() {
  let state: ActivityAuthState = { session: null, loading: true, error: null };
  const publish = vi.fn((next: ActivityAuthState) => { state = next; });
  const client = createActivityAuthClient("/api/", publish);
  return { client, publish, state: () => state };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("optional GitHub auth UI", () => {
  it("only enables the loopback API proxy for opted-in local development", async () => {
    if (typeof viteConfig !== "function") throw new Error("Expected Vite config factory");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "");
    vi.stubEnv("ACTIVITY_PORT", "");
    const publicConfig = await viteConfig({ command: "serve", mode: "test" });
    expect(publicConfig.server?.proxy).toBeUndefined();
    expect(publicConfig.server?.fs?.deny).toContain("**/.local/**");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "github");
    expect((await viteConfig({ command: "serve", mode: "test" })).server).toEqual({
      host: "127.0.0.1", port: 5173, strictPort: true,
      proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
      fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**", "**/*.pem"] },
    });
    expect((await viteConfig({ command: "build", mode: "production" })).server?.proxy).toBeUndefined();
    expect((await viteConfig({ command: "serve", mode: "production", isPreview: true })).server?.proxy).toBeUndefined();
  });

  it("accepts only a numeric server port and never exposes server env through browser config", async () => {
    if (typeof viteConfig !== "function") throw new Error("Expected Vite config factory");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "github");
    vi.stubEnv("ACTIVITY_PORT", "9876");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "server-only-test-value");
    const config = await viteConfig({ command: "serve", mode: "test" });
    expect(config.server?.proxy?.["/api"]).toMatchObject({ target: "http://127.0.0.1:9876" });
    expect(config.define).toBeUndefined();
    expect(config.envPrefix).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("server-only-test-value");
    for (const port of ["0", "80", "65536", "1.5", "8787/path", "https://other.example"]) {
      vi.stubEnv("ACTIVITY_PORT", port);
      expect(() => viteConfig({ command: "serve", mode: "test" })).toThrow("ACTIVITY_PORT");
    }
  });

  it("requires a fully checked, authenticated session with CSRF before writing", () => {
    for (const value of [null, {}, { ...signedIn, csrfToken: null }, { ...signedOut, login: "octocat" }]) {
      expect(() => parseActivitySession(value)).toThrow("Invalid sign-in");
    }
    expect(parseActivitySession(signedIn)).toEqual(signedIn);
    expect(parseActivitySession(signedOut)).toEqual(signedOut);
    expect(canChangeActivity(ready)).toBe(true);
    for (const state of [
      { ...ready, loading: true }, { ...ready, error: "offline" },
      { ...ready, session: signedOut }, { ...ready, session: null },
      { ...ready, session: { ...signedIn, csrfToken: "" } },
    ]) expect(canChangeActivity(state)).toBe(false);
  });

  it("keeps public default credential-free and renders no sign-in UI", () => {
    expect(publicActivityTransport.options(true)).toEqual({ credentials: "omit" });
    expect(renderWithAuth(createElement(ActivityAuthControls), ready, false)).toBe("");
    const html = renderToStaticMarkup(createElement(ActivityAuthProvider, {
      enabled: true, provider: "github", baseUrl: "/api", children: createElement(ActivityAuthControls),
    }));
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain("Checking GitHub sign-in");
    expect(html).toContain("Shared read changes are disabled");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("session-csrf");
  });

  it("shows explicit permission, error, sign-in, and retry controls", () => {
    expect(renderWithAuth(createElement(ActivityAuthControls))).toContain("Signed in as octocat");
    const html = renderWithAuth(createElement(ActivityAuthControls), { ...ready, session: null, error: "API unavailable" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("API unavailable");
    expect(html).toContain("Retry checking sign-in");
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("Sign out");
  });

  it.each([false, true])("gates both inbox mark/restore buttons (read=%s) for loading, anonymous, and failed auth", (read) => {
    const sdk = { ...sdkFeed, events: sdkFeed.events.map((event) => ({
      ...event, readAt: read ? now : null, acknowledgementId: read ? "ack-1" : null,
    })) };
    const emitter = { ...emitterFeed, events: emitterFeed.events.map((event) => ({
      ...event, readAt: read ? now : null, acknowledgementId: read ? "ack-1" : null,
    })) };
    const children = [
      createElement(SharedActivityList, {
        key: "sdk", groups: groupActivities(sdk, read), read,
        activity: { feed: sdk, loading: false, pending: false, error: null, ...actions },
      }),
      createElement(EmitterInboxView, {
        key: "emitter", items: emitter.issues, excludedIssueNumbers: [], actions, now: Date.parse(now), kind: "issues",
        activity: { feed: emitter, loading: false, pending: false, error: null, configured: true, canWrite: true },
      }),
    ];
    for (const state of [
      { ...ready, session: signedOut }, { ...ready, loading: true }, { ...ready, error: "offline" },
    ]) {
      const buttons = renderWithAuth(children, state).match(/<button[^>]*>/g)!;
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    }
    expect(renderWithAuth(children)).not.toContain('disabled=""');
    expect(renderWithAuth(children, { ...ready, session: signedOut }, false)).not.toContain('disabled=""');
  });

  it("replaces only opt-in SDK wording and explains emitter permission", () => {
    const snapshot: DashboardSnapshot = {
      schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: now, stale: false, source: { repository: "Azure/azure-sdk-for-js", fetchedAt: now, query: "" },
      pullRequests: [], inbox: { comparisonFrom: null, generatedAt: now, baselineAvailable: false, defaultPlane: "management", items: [] },
    };
    const inbox = createElement(ReviewInboxView, {
      snapshot, activity: { feed: sdkFeed, loading: false, pending: false, error: null, ...actions },
    });
    expect(renderWithAuth(inbox)).not.toContain("Anyone can mark activities");
    expect(renderWithAuth(inbox)).toContain("GitHub sign-in is required");
    expect(renderWithAuth(inbox, ready, false)).toContain("Anyone can mark activities");
    expect(renderWithAuth(createElement(EmitterActivityNotice, { activity: unavailableEmitterActivity })))
      .toContain("GitHub sign-in is required");
  });
});

describe("shared GitHub session client", () => {
  it("uses same-origin cookies, shares concurrent session checks, and sends CSRF only on writes/logout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(signedIn)).mockResolvedValueOnce(response(signedOut));
    vi.stubGlobal("fetch", fetcher);
    const { client, state } = setup();
    expect(() => client.options(true)).toThrow("Sign in");
    await Promise.all([client.refresh(), client.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(["/api/auth/session", expect.objectContaining({
      method: "GET", cache: "no-store", credentials: "same-origin",
    })]);
    expect(client.options()).toEqual({ credentials: "same-origin" });
    expect(client.options(true)).toEqual({ credentials: "same-origin", headers: { "x-csrf-token": "session-csrf" } });
    const logout = client.logout();
    expect(canChangeActivity(state())).toBe(false);
    await logout;
    expect(fetcher.mock.calls[1]).toEqual(["/api/auth/logout", expect.objectContaining({
      method: "POST", credentials: "same-origin", headers: { "x-csrf-token": "session-csrf" },
    })]);
    expect(state().session).toEqual(signedOut);
    expect(() => client.options(true)).toThrow("Sign in");
    client.dispose();
  });

  it.each([response({}, 503), response({ ...signedIn, csrfToken: null }), response("bad session")])(
    "fails closed on unavailable/malformed session and supports retry", async (failure) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(failure).mockResolvedValueOnce(response(signedIn)));
      const { client, state } = setup();
      await client.refresh();
      expect(state().error).toContain("Unable to check GitHub sign-in");
      expect(() => client.options(true)).toThrow("Sign in");
      await client.refresh();
      expect(canChangeActivity(state())).toBe(true);
      client.dispose();
    },
  );

  it("fails closed on a failed logout instead of claiming success", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(response(signedIn))
      .mockRejectedValueOnce(new Error("network unavailable")));
    const { client, state } = setup();
    await client.refresh();
    await client.logout();
    expect(state().session).toBeNull();
    expect(state().error).toContain("Unable to confirm sign out");
    expect(canChangeActivity(state())).toBe(false);
    client.dispose();
  });

  it("bounds unavailable session requests and ignores disposed results", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const { client, state, publish } = setup();
    const first = client.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(state().error).toContain("timed out");
    const second = client.refresh();
    client.dispose();
    const count = publish.mock.calls.length;
    await second;
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(publish).toHaveBeenCalledTimes(count);
    expect(() => client.options(true)).toThrow("Sign in");
  });

  it.each([401, 403])("invalidates both inbox permissions on HTTP %s even with an unreadable body", async (status) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response(signedIn)));
    const { client, state } = setup();
    await client.refresh();
    try { await readActivityResponse(new Response("not JSON", { status })); } catch (cause) {
      expect(cause).toBeInstanceOf(ActivityResponseError);
      client.failed(cause);
    }
    expect(canChangeActivity(state())).toBe(false);
    expect(state().error).toContain("expired or permission was denied");
    client.dispose();
  });

  it("adds CSRF for emitter ack/restore and stops subsequent writes after session expiry", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(signedIn))
      .mockResolvedValueOnce(response(emitterFeed))
      .mockResolvedValueOnce(response({ feed: emitterFeed, acknowledgementId: "ack-1" }))
      .mockResolvedValueOnce(response({ error: "Sign in required" }, 401))
      .mockResolvedValueOnce(response(emitterFeed));
    vi.stubGlobal("fetch", fetcher);
    const { client: auth, state } = setup();
    await auth.refresh();
    let activity = unavailableEmitterActivity;
    const client = createEmitterActivityClient("/api", (next) => { activity = next; }, auth);
    await client.refresh();
    const ack = { generation: "generation-1", number: 42, throughSequence: 1 };
    await client.acknowledge(ack);
    await client.restore({ generation: "generation-1", acknowledgementIds: ["ack-1"] });
    for (const index of [2, 3]) expect(fetcher.mock.calls[index][1]).toMatchObject({
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": "session-csrf" },
    });
    expect(state().error).toContain("expired");
    expect(activity.error).toContain("may not have been saved");
    await client.refresh();
    await client.acknowledge(ack);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(activity.error).toContain("Sign in");
    client.dispose();
    auth.dispose();
  });
});
