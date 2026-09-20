import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityAuthContext, ActivityAuthControls, ActivityAuthProvider, canChangeActivity, createActivityAuthClient, publicActivityTransport, type ActivityAuthState } from "../src/shared/ActivityAuth";
import { fetchEmitterSnapshot } from "../src/features/emitter/useEmitterData";
import viteConfig from "../vite.config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const session = { authenticated: true, login: "Entra reviewer", csrfToken: "random-session-csrf" };

describe("opt-in Entra UI", () => {
  it("uses same-origin BFF cookies, disallows redirects, and sends session CSRF on mutations and logout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json({ authenticated: false, login: null, csrfToken: null }));
    vi.stubGlobal("fetch", fetcher);
    let state: ActivityAuthState = { session: null, loading: true, error: null };
    const client = createActivityAuthClient("/api", (next) => { state = next; }, "entra");
    expect(() => client.options(true)).toThrow("Microsoft Entra");
    await client.refresh();
    expect(canChangeActivity(state)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({
      credentials: "same-origin", redirect: "error", method: "GET",
    }));
    expect(client.options(true)).toEqual({
      credentials: "same-origin", redirect: "error", headers: { "x-csrf-token": "random-session-csrf" },
    });
    await client.logout();
    expect(canChangeActivity(state)).toBe(false);
    expect(fetcher).toHaveBeenLastCalledWith("/api/auth/logout", expect.objectContaining({
      method: "POST", body: "{}", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json", "x-csrf-token": "random-session-csrf" },
    }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("fails closed on expired sessions, redirects and non-same-origin API configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("redirect blocked"));
    vi.stubGlobal("fetch", fetcher);
    let state: ActivityAuthState = { session: null, loading: true, error: null };
    const client = createActivityAuthClient("/api", (next) => { state = next; }, "entra");
    await client.refresh();
    expect(state.error).toContain("Microsoft Entra");
    expect(canChangeActivity(state)).toBe(false);
    expect(() => client.options(true)).toThrow();
    client.dispose();
    const external = createActivityAuthClient("https://other.example/api", (next) => { state = next; }, "entra");
    await external.refresh();
    expect(state.error).toContain("VITE_ACTIVITY_API_URL=/api");
    expect(fetcher).toHaveBeenCalledTimes(1);
    external.dispose();
  });

  it("removes the Entra sign-in panel from the dashboard content", () => {
    const html = renderToStaticMarkup(createElement(ActivityAuthProvider, {
      enabled: true, provider: "entra", baseUrl: "/api", children: createElement(ActivityAuthControls),
    }));
    expect(html).toBe("");
  });

  function header(state: ActivityAuthState, enabled = true, provider: "entra" | "github" = "entra") {
    return renderToStaticMarkup(createElement(ActivityAuthContext.Provider, {
      value: { enabled, provider, state, transport: publicActivityTransport,
        loginUrl: "/api/auth/login", refresh: vi.fn(), logout: vi.fn() },
      children: createElement(ActivityAuthControls, { placement: "header" }),
    }));
  }

  it("shows only a compact account name and sign-out control when signed in", () => {
    const html = header({ session, loading: false, error: null });
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain("Entra reviewer");
    expect(html).toContain("Sign out");
    for (const text of ["activity-auth", "Shared read changes", "Only assigned", "Retry", "/api/auth/login",
      "random-session-csrf"]) expect(html).not.toContain(text);
  });

  it("keeps loading, expired-session recovery and sign-in controls without a panel", () => {
    expect(header({ session: null, loading: true, error: null })).toContain("Checking sign-in...");
    const failed = header({ session: null, loading: false, error: "Session expired." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Session expired.");
    expect(failed).toContain('href="/api/auth/login"');
    expect(failed).toContain("Retry");
    expect(failed).not.toContain("Sign out");
    const signedOut = header({ session: null, loading: false, error: null });
    expect(signedOut).toContain("Signed out");
    expect(signedOut).toContain("Sign in");
    expect(header({ session, loading: false, error: null }, false)).toBe("");
    expect(header({ session, loading: false, error: null }, true, "github")).toBe("");
  });

  it("sends BFF cookies for protected published emitter snapshots only when opted in", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("VITE_ACTIVITY_AUTH", "entra");
    await expect(fetchEmitterSnapshot()).rejects.toThrow("503");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
    vi.stubEnv("VITE_ACTIVITY_AUTH", "");
    await expect(fetchEmitterSnapshot()).rejects.toThrow("503");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: "omit" });
    expect(fetcher.mock.calls[1][1]?.redirect).toBeUndefined();
  });

  it("keeps Pages base by default and explicitly configures root-hosted Entra builds", async () => {
    if (typeof viteConfig !== "function") throw new Error("Expected Vite factory.");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "");
    vi.stubEnv("VITE_BASE_PATH", "");
    expect((await viteConfig({ command: "build", mode: "test" })).base).toBe("/sdk-js-worker/");
    vi.stubEnv("VITE_ACTIVITY_AUTH", "entra");
    expect(() => viteConfig({ command: "build", mode: "test" })).toThrow("Entra hosting requires");
    vi.stubEnv("VITE_BASE_PATH", "/");
    vi.stubEnv("VITE_ACTIVITY_API_URL", "/api");
    expect((await viteConfig({ command: "build", mode: "test" })).base).toBe("/");
    vi.stubEnv("VITE_ACTIVITY_API_URL", "https://other.example/api");
    expect(() => viteConfig({ command: "build", mode: "test" })).toThrow("Entra hosting requires");
  });
});
