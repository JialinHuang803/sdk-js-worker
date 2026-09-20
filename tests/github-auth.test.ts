import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityError } from "../api/src/engine";
import { createAuth, type Auth, type AuthConfig } from "../api/src/github/auth";

const config: AuthConfig = {
  clientId: "app-client", clientSecret: "server-only-secret",
  callbackUrl: "http://127.0.0.1:5173/api/auth/callback",
  dashboardUrl: "http://127.0.0.1:5173/sdk-js-worker/",
  allowedUsers: [" Reviewer "], secureCookies: false,
};
const anonymous = { authenticated: false, login: null, csrfToken: null };
const tokenReply = { access_token: "github-user-token", token_type: "bearer" };
const userReply = { login: "ReViewer", id: 123 };

function cookiePair(cookie: string): string {
  return cookie.split(";")[0];
}

function callbackUrl(location: string): URL {
  const url = new URL(config.callbackUrl);
  url.searchParams.set("state", new URL(location).searchParams.get("state") ?? "");
  url.searchParams.set("code", "authorization-code");
  return url;
}

function setup() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    Response.json(String(url).endsWith("/user") ? userReply : tokenReply));
  return { auth: createAuth(config, fetcher), fetcher };
}

async function signIn(auth: Auth, previousCookie = "") {
  const start = auth.start();
  const result = await auth.callback(callbackUrl(start.location), `${cookiePair(start.cookie)}; ${previousCookie}`);
  const cookie = cookiePair(result.cookie);
  const session = auth.session(cookie);
  if (!session.csrfToken) throw new Error("Expected authenticated session.");
  return { cookie, csrfToken: session.csrfToken, result };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub App OAuth", () => {
  it("uses independent browser binding, random state and PKCE; secrets stay server-side", async () => {
    const { auth, fetcher } = setup();
    const start = auth.start();
    const location = new URL(start.location);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(config.clientId);
    expect(location.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.has("scope")).toBe(false);
    expect(start.cookie).toMatch(/^activity_oauth=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/api; HttpOnly; SameSite=Lax$/);
    expect(start.cookie).not.toContain(location.searchParams.get("state"));
    expect(start.location).not.toContain(config.clientSecret);
    const second = auth.start();
    expect(second.location).not.toBe(start.location);
    expect(second.cookie).not.toBe(start.cookie);
    const url = callbackUrl(start.location);
    url.searchParams.set("returnTo", "https://evil.example/");
    const result = await auth.callback(url, cookiePair(start.cookie));
    expect(result.location).toBe(config.dashboardUrl);
    expect(result.cookie).toMatch(/^activity_session=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/api; HttpOnly; SameSite=Lax$/);
    const exchange = fetcher.mock.calls[0];
    expect(exchange[0]).toBe("https://github.com/login/oauth/access_token");
    expect(exchange[1]?.method).toBe("POST");
    expect(exchange[1]?.redirect).toBe("error");
    expect(exchange[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(exchange[1]?.headers).toEqual({
      Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
    });
    if (typeof exchange[1]?.body !== "string") throw new Error("Expected form body.");
    const body = new URLSearchParams(exchange[1].body);
    expect(body.get("client_secret")).toBe(config.clientSecret);
    expect(body.get("redirect_uri")).toBe(config.callbackUrl);
    expect(body.get("code")).toBe("authorization-code");
    const verifier = body.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(verifier).digest("base64url"))
      .toBe(location.searchParams.get("code_challenge"));
    expect(fetcher.mock.calls[1][0]).toBe("https://api.github.com/user");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Authorization")).toBe(`Bearer ${tokenReply.access_token}`);
    expect(fetcher.mock.calls[1][1]?.redirect).toBe("error");
    const session = auth.session(cookiePair(result.cookie));
    expect(session).toEqual({ authenticated: true, login: "reviewer", csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(JSON.stringify({ result, session })).not.toContain(tokenReply.access_token);
    expect(JSON.stringify({ result, session })).not.toContain(config.clientSecret);
  });

  it("uses Secure cookies for HTTPS and rejects unsafe configuration", () => {
    const secure = createAuth({
      ...config, callbackUrl: "https://dashboard.example/api/auth/callback",
      dashboardUrl: "https://dashboard.example/", secureCookies: true,
    });
    expect(secure.start().cookie).toContain("; Secure");
    const invalid: Partial<AuthConfig>[] = [
      { clientId: "" }, { clientSecret: "" }, { allowedUsers: [] }, { allowedUsers: ["*"] },
      { callbackUrl: "http://public.example/api/auth/callback", dashboardUrl: "http://public.example/" },
      { callbackUrl: "not a URL" }, { callbackUrl: `${config.callbackUrl}?redirect=x` },
      { callbackUrl: "http://user:password@127.0.0.1:5173/api/auth/callback" },
      { callbackUrl: "http://127.0.0.1:5173/auth/callback" }, { dashboardUrl: "https://evil.example/" },
      { dashboardUrl: `${config.dashboardUrl}#fragment` }, { secureCookies: true },
      { callbackUrl: "https://dashboard.example/api/auth/callback", dashboardUrl: "https://dashboard.example/" },
    ];
    for (const overrides of invalid) expect(() => createAuth({ ...config, ...overrides })).toThrow();
  });

  it("rejects absent, altered, duplicate or cross-browser state and cookies before fetching", async () => {
    const { auth, fetcher } = setup();
    const first = auth.start();
    const second = auth.start();
    const valid = callbackUrl(first.location);
    const absent = new URL(valid); absent.searchParams.delete("state");
    const changed = new URL(valid); changed.searchParams.set("state", "X".repeat(43));
    const duplicate = new URL(valid); duplicate.searchParams.append("state", valid.searchParams.get("state") ?? "");
    const wrongPath = new URL(valid); wrongPath.pathname = "/api/elsewhere";
    const wrongOrigin = new URL(valid); wrongOrigin.hostname = "evil.example";
    const firstCookie = cookiePair(first.cookie);
    for (const [url, cookie] of [
      [valid, undefined], [valid, cookiePair(second.cookie)], [absent, firstCookie],
      [changed, firstCookie], [duplicate, firstCookie], [wrongPath, firstCookie],
      [wrongOrigin, firstCookie], [valid, `${firstCookie}; ${firstCookie}`],
      [valid, "activity_oauth=invalid"], [valid, `${firstCookie}; other=${"x".repeat(16_384)}`],
    ] satisfies [URL, string | undefined][]) {
      await expect(auth.callback(url, cookie)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(auth.callback(valid, firstCookie)).resolves.toHaveProperty("cookie");
    await expect(auth.callback(valid, firstCookie)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("consumes a validated state before asynchronous exchange, even when the exchange fails", async () => {
    const { auth, fetcher } = setup();
    fetcher.mockRejectedValue(new Error("secret upstream diagnostic"));
    const start = auth.start();
    const first = auth.callback(callbackUrl(start.location), cookiePair(start.cookie));
    const replay = auth.callback(callbackUrl(start.location), cookiePair(start.cookie));
    await expect(replay).rejects.toMatchObject({ status: 400 });
    await expect(first).rejects.toMatchObject({ status: 503, message: "GitHub authentication is unavailable." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "duplicate", "empty", "error", "oversized", "control"])("rejects %s authorization code and consumes state", async (kind) => {
    const { auth, fetcher } = setup();
    const start = auth.start();
    const url = callbackUrl(start.location);
    if (kind === "missing") url.searchParams.delete("code");
    if (kind === "duplicate") url.searchParams.append("code", "other");
    if (kind === "empty") url.searchParams.set("code", "");
    if (kind === "error") url.searchParams.set("error", "access_denied");
    if (kind === "oversized") url.searchParams.set("code", "x".repeat(1_025));
    if (kind === "control") url.searchParams.set("code", "code\n");
    await expect(auth.callback(url, cookiePair(start.cookie))).rejects.toMatchObject({ status: 400 });
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie))).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { access_token: 123, token_type: "bearer" },
    { access_token: "", token_type: "bearer" }, { access_token: "token\n", token_type: "bearer" },
    { access_token: "token", token_type: "other" }, { access_token: "token" },
    { ...tokenReply, error: "secret upstream error" },
  ])("rejects malformed token response %#", async (value) => {
    const { auth, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json(value));
    const start = auth.start();
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie)))
      .rejects.toMatchObject({ status: 503, message: "GitHub returned an invalid authentication response." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, [], {}, { login: "reviewer" }, { login: "reviewer", id: "123" },
    { login: "reviewer", id: 0 }, { login: "reviewer", id: -1 }, { login: "reviewer", id: 1.5 },
    { login: "reviewer", id: Number.MAX_SAFE_INTEGER + 1 }, { login: 123, id: 123 },
    { login: " reviewer", id: 123 }, { login: "reviewer\n", id: 123 },
  ])("rejects untrustworthy user identity %#", async (value) => {
    const { auth, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json(tokenReply)).mockResolvedValueOnce(Response.json(value));
    const start = auth.start();
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie)))
      .rejects.toMatchObject({ status: 503, message: "GitHub returned an invalid user identity." });
  });

  it("denies users outside the exact normalized allowlist", async () => {
    const { auth, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json(tokenReply))
      .mockResolvedValueOnce(Response.json({ login: "reviewer-other", id: 456 }));
    const start = auth.start();
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie)))
      .rejects.toMatchObject({ status: 403 });
    expect(auth.session(cookiePair(start.cookie))).toEqual(anonymous);
  });

  it.each(["token-status", "token-json", "user-status", "user-json", "network"])("sanitizes %s upstream failures", async (failure) => {
    const { auth, fetcher } = setup();
    if (failure.startsWith("user")) fetcher.mockResolvedValueOnce(Response.json(tokenReply));
    if (failure.endsWith("status")) fetcher.mockResolvedValueOnce(new Response("private upstream body", { status: 500 }));
    else if (failure.endsWith("json")) fetcher.mockResolvedValueOnce(new Response("private invalid json"));
    else fetcher.mockRejectedValueOnce(new Error("private network details"));
    const start = auth.start();
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie)))
      .rejects.toMatchObject({ status: 503, message: "GitHub authentication is unavailable." });
  });

  it("bounds each network request with a timeout and safely handles aborts", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      init?.signal?.throwIfAborted();
      return Response.json({});
    });
    const auth = createAuth(config, fetcher);
    const start = auth.start();
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie)))
      .rejects.toMatchObject({ status: 503, message: "GitHub authentication is unavailable." });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("expires pending state at ten minutes, including during an exchange", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { auth, fetcher } = setup();
    const start = auth.start();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await expect(auth.callback(callbackUrl(start.location), cookiePair(start.cookie))).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
    const next = auth.start();
    fetcher.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      return Response.json(tokenReply);
    });
    await expect(auth.callback(callbackUrl(next.location), cookiePair(next.cookie))).rejects.toMatchObject({ status: 400 });
  });
});

describe("opaque in-memory sessions", () => {
  it("requires a session-bound CSRF token for mutations and logout, then revokes on logout", async () => {
    const { auth } = setup();
    const first = await signIn(auth);
    const second = await signIn(auth);
    expect(first.cookie).not.toContain(first.csrfToken);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    expect(auth.session(undefined)).toEqual(anonymous);
    expect(auth.requireMutation(`unrelated=value; ${first.cookie}`, first.csrfToken)).toBe("reviewer");
    for (const csrf of [undefined, "", "wrong", "X".repeat(43), second.csrfToken, `${first.csrfToken}\n`]) {
      expect(() => auth.requireMutation(first.cookie, csrf)).toThrow(ActivityError);
      expect(() => auth.logout(first.cookie, csrf)).toThrow(expect.objectContaining({ status: 403 }));
    }
    for (const cookie of [undefined, "activity_session=invalid", "activity_session=" + "X".repeat(43),
      `${first.cookie}; ${first.cookie}`, `${first.cookie}\nmalformed`, `other=${first.cookie}`]) {
      expect(auth.session(cookie)).toEqual(anonymous);
      expect(() => auth.requireMutation(cookie, first.csrfToken)).toThrow(expect.objectContaining({ status: 401 }));
    }
    expect(auth.logout(first.cookie, first.csrfToken))
      .toBe("activity_session=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax");
    expect(auth.session(first.cookie)).toEqual(anonymous);
    expect(() => auth.requireMutation(first.cookie, first.csrfToken)).toThrow(expect.objectContaining({ status: 401 }));
    expect(auth.session(second.cookie).authenticated).toBe(true);
  });

  it("rotates and revokes an existing session after a fresh sign-in", async () => {
    const { auth } = setup();
    const old = await signIn(auth);
    const fresh = await signIn(auth, old.cookie);
    expect(fresh.cookie).not.toBe(old.cookie);
    expect(fresh.csrfToken).not.toBe(old.csrfToken);
    expect(auth.session(old.cookie)).toEqual(anonymous);
    expect(auth.session(fresh.cookie).authenticated).toBe(true);
    expect(createAuth(config).session(fresh.cookie)).toEqual(anonymous);
  });

  it("expires sessions after eight hours without sliding expiration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { auth } = setup();
    const signedIn = await signIn(auth);
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000 - 1);
    expect(auth.session(signedIn.cookie).authenticated).toBe(true);
    expect(auth.requireMutation(signedIn.cookie, signedIn.csrfToken)).toBe("reviewer");
    vi.setSystemTime(Date.now() + 1);
    expect(auth.session(signedIn.cookie)).toEqual(anonymous);
    expect(() => auth.requireMutation(signedIn.cookie, signedIn.csrfToken))
      .toThrow(expect.objectContaining({ status: 401 }));
    expect(() => auth.logout(signedIn.cookie, signedIn.csrfToken))
      .toThrow(expect.objectContaining({ status: 401 }));
  });

  it("bounds pending states and frees expired capacity", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { auth } = setup();
    for (let i = 0; i < 1_000; i++) auth.start();
    expect(() => auth.start()).toThrow(expect.objectContaining({ status: 503 }));
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(auth.start().cookie).toContain("activity_oauth=");
  });

  it("bounds sessions without evicting live users and frees expired capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { auth } = setup();
    const first = await signIn(auth);
    for (let i = 1; i < 1_000; i++) await signIn(auth);
    await expect(signIn(auth)).rejects.toMatchObject({ status: 503 });
    expect(auth.session(first.cookie).authenticated).toBe(true);
    const rotated = await signIn(auth, first.cookie);
    expect(auth.session(rotated.cookie).authenticated).toBe(true);
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000);
    await expect(signIn(auth)).resolves.toHaveProperty("cookie");
  });
});
