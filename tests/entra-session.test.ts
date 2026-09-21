import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntraAuth, InteractiveSignInRequired, type AzureAuthConfig, type EntraClient } from "../api/src/azure/auth";
import { InvalidSessionRecord } from "../api/src/azure/session-store";
import { memorySessionStore } from "./helpers/session-store";

const config: AzureAuthConfig = {
  mode: "entra-federated", tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  clientId: "d8714cdb-8d6d-443e-969a-5beab691ce59", managedIdentityClientId: "cd1b838f-1e56-4462-91e8-80dc8084c233",
  accessPolicy: "tenant-members", allowedObjectIds: [], origin: "https://dashboard.example",
};
const objectId = "11111111-1111-4111-8111-111111111111";
const hour = 60 * 60_000;
const day = 24 * hour;
const claims = (overrides: Record<string, unknown> = {}) => ({
  tid: config.tenantId, oid: objectId, aud: config.clientId,
  iss: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
  acct: 0, name: "Reviewer", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});
const tokens = (overrides: Record<string, unknown> = {}) => ({
  cache: '{"refreshToken":"never-return-to-browser"}', accountId: "account-id", idTokenClaims: claims(overrides),
});
function setup() {
  const store = memorySessionStore();
  const client: EntraClient = {
    getAuthCodeUrl: vi.fn(async (request) => `https://login.microsoftonline.com/authorize?state=${request.state}&nonce=${request.nonce}`),
    acquireTokenByCode: vi.fn(async (request) => tokens({ nonce: request.nonce })),
    renew: vi.fn(async () => tokens()),
  };
  const auth = createEntraAuth(config, client, store);
  const restart = () => createEntraAuth(config, client, store);
  async function pending() {
    const started = await auth.start();
    const state = new URL(started.location).searchParams.get("state")!;
    return { browser: started.cookies[0].split(";")[0],
      url: new URL(`${config.origin}/api/auth/callback?code=server-code&state=${state}`) };
  }
  async function login() {
    const start = await pending();
    const result = await auth.callback(start.url, start.browser);
    const cookie = result.cookies[0].split(";")[0];
    const session = await auth.session(cookie);
    const key = createHash("sha256").update(cookie.split("=")[1]).digest("base64url");
    return { cookie, key, session, result,
      headers: { cookie, origin: config.origin, "content-type": "application/json", "x-csrf-token": session.csrfToken } };
  }
  return { auth, client, store, restart, pending, login };
}
afterEach(() => vi.useRealTimers());

describe("durable seven-day Entra sessions", () => {
  it("accepts fresh Entra ID tokens backdated by five minutes while rejecting genuinely stale claims", async () => {
    vi.useFakeTimers();
    const { auth, client, login } = setup();
    vi.mocked(client.acquireTokenByCode).mockImplementationOnce(async (request) =>
      tokens({ nonce: request.nonce, iat: Math.floor(Date.now() / 1000) - 300 }));
    const { cookie, session } = await login();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    vi.mocked(client.renew).mockResolvedValueOnce(tokens({ iat: Math.floor(Date.now() / 1000) - 300 }));
    expect(await auth.session(cookie)).toEqual(session);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    vi.mocked(client.renew).mockResolvedValueOnce(tokens({ iat: Math.floor(Date.now() / 1000) - 420 }));
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
  });

  it("bounds anonymous login admission before metadata requests or durable writes", async () => {
    vi.useFakeTimers();
    const { auth, client, store } = setup();
    const create = vi.spyOn(store, "create");
    for (let count = 0; count < 100; count++) await auth.start();
    await expect(auth.start()).rejects.toMatchObject({ status: 503, message: "Too many sign-in attempts. Try again shortly." });
    expect(client.getAuthCodeUrl).toHaveBeenCalledTimes(100);
    expect(create).toHaveBeenCalledTimes(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await auth.start();
    expect(create).toHaveBeenCalledTimes(101);
  });

  it("bounds concurrent anonymous metadata requests before they reach storage", async () => {
    const { auth, client, store } = setup();
    const create = vi.spyOn(store, "create");
    let release!: (url: string) => void;
    const metadata = new Promise<string>((resolve) => { release = resolve; });
    vi.mocked(client.getAuthCodeUrl).mockImplementation(() => metadata);
    const starts = Array.from({ length: 20 }, () => auth.start());
    await expect(auth.start()).rejects.toMatchObject({ status: 503 });
    expect(client.getAuthCodeUrl).toHaveBeenCalledTimes(20);
    expect(create).not.toHaveBeenCalled();
    release("https://login.microsoftonline.com/authorize");
    await Promise.all(starts);
  });

  it("completes pending callbacks across restarts and keeps the same cookie/CSRF across renewal after ID-token expiry", async () => {
    vi.useFakeTimers();
    const { auth, pending, restart, client } = setup();
    const start = await pending();
    const other = restart();
    const result = await other.callback(start.url, start.browser);
    expect(result.cookies[0]).toContain("Max-Age=604800");
    const cookie = result.cookies[0].split(";")[0];
    const session = await auth.session(cookie);
    await vi.advanceTimersByTimeAsync(2 * hour);
    expect(await restart().session(cookie)).toEqual(session);
    expect(client.renew).toHaveBeenCalledWith('{"refreshToken":"never-return-to-browser"}', "account-id");
    expect(JSON.stringify(session)).not.toMatch(/cache|accountId|idToken|refreshToken/);
    await expect(auth.callback(start.url, start.browser)).rejects.toMatchObject({ status: 400 });
  });

  it("never extends the absolute seven-day deadline, even after successful renewal", async () => {
    vi.useFakeTimers();
    const { auth, login, client, restart, store } = setup();
    const { cookie, key } = await login();
    const original = (await store.read("sessions", key))!.value as { expiresAt: number };
    await vi.advanceTimersByTimeAsync(7 * day - hour);
    await restart().session(cookie);
    expect(((await store.read("sessions", key))!.value as { expiresAt: number }).expiresAt).toBe(original.expiresAt);
    await vi.advanceTimersByTimeAsync(hour);
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    expect(client.renew).toHaveBeenCalledTimes(1);
    expect(await store.read("sessions", key)).toBeUndefined();
  });

  it("renews online at thirty minutes, or five minutes before a shorter-lived token expires", async () => {
    vi.useFakeTimers();
    const { auth, client, login } = setup();
    vi.mocked(client.acquireTokenByCode).mockImplementationOnce(async (request) =>
      tokens({ nonce: request.nonce, exp: Math.floor(Date.now() / 1000) + 600 }));
    const { cookie } = await login();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await auth.session(cookie);
    expect(client.renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await auth.session(cookie);
    expect(client.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await auth.session(cookie);
    expect(client.renew).toHaveBeenCalledTimes(2);
  });

  it.each([
    { acct: 1 }, { acct: undefined }, { acct: false },
    { tid: "11111111-1111-4111-8111-111111111111" }, { aud: "wrong" }, { iss: "https://attacker.example" },
    { oid: "22222222-2222-4222-8222-222222222222" }, { exp: 0 }, { iat: undefined },
  ])("durably invalidates fresh renewal claims that no longer authorize the same member: %j", async (overrides) => {
    vi.useFakeTimers();
    const { auth, client, login, restart, store } = setup();
    const { cookie, key } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    vi.mocked(client.renew).mockResolvedValueOnce(tokens(overrides));
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    await expect(restart().session(cookie)).rejects.toMatchObject({ status: 401 });
    expect(await store.read("sessions", key)).toBeUndefined();
  });

  it("rejects a stale cached identity returned from a nominal refresh, while allowing an absent refresh nonce", async () => {
    vi.useFakeTimers();
    const { auth, client, login } = setup();
    const oldClaims = tokens();
    const { cookie } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    vi.mocked(client.renew).mockResolvedValueOnce(oldClaims);
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    const next = await login();
    await vi.advanceTimersByTimeAsync(hour);
    await expect(auth.session(next.cookie)).resolves.toEqual(next.session);
  });

  it("rejects an account switch or too-short fresh token without repeatedly refreshing", async () => {
    vi.useFakeTimers();
    const { auth, client, login } = setup();
    for (const response of [
      () => ({ ...tokens(), accountId: "different-account" }),
      () => tokens({ exp: Math.floor(Date.now() / 1000) + 300 }),
    ]) {
      const { cookie } = await login();
      await vi.advanceTimersByTimeAsync(hour);
      vi.mocked(client.renew).mockResolvedValueOnce(response());
      await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
      await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    }
    expect(client.renew).toHaveBeenCalledTimes(2);
  });

  it("revoked/interaction-required sessions require interactive login on every replica", async () => {
    vi.useFakeTimers();
    const { auth, client, login, restart } = setup();
    const { cookie } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    vi.mocked(client.renew).mockRejectedValueOnce(new InteractiveSignInRequired());
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    await expect(restart().session(cookie)).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed on transient renewal failure without deleting cache, and succeeds on a later retry", async () => {
    vi.useFakeTimers();
    const { auth, client, store, login } = setup();
    const { cookie, key, session } = await login();
    const before = (await store.read("sessions", key))!.value;
    await vi.advanceTimersByTimeAsync(hour);
    vi.mocked(client.renew).mockRejectedValueOnce(new Error("sensitive network response"));
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 503, message: expect.not.stringContaining("sensitive") });
    expect((await store.read("sessions", key))!.value).toEqual(before);
    expect(await auth.session(cookie)).toEqual(session);
  });

  it("bounds stalled renewal and does not authorize the stale session", async () => {
    vi.useFakeTimers();
    const { auth, client, login } = setup();
    const { cookie } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    vi.mocked(client.renew).mockImplementationOnce(() => new Promise(() => {}));
    const rejected = expect(auth.session(cookie)).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });

  it("single-flights concurrent requests and coordinates a second runtime through ETag locks", async () => {
    vi.useFakeTimers();
    const { auth, client, login, restart } = setup();
    const { cookie, session } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    let release!: (value: ReturnType<typeof tokens>) => void;
    vi.mocked(client.renew).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = auth.session(cookie);
    const same = auth.session(cookie);
    const other = restart().session(cookie);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.renew).toHaveBeenCalledTimes(1);
    release(tokens());
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all([first, same, other])).toEqual([session, session, session]);
    expect(client.renew).toHaveBeenCalledTimes(1);
  });

  it("recovers an expired refresh lock after a runtime stops without sliding session expiry", async () => {
    vi.useFakeTimers();
    const { store, client, login, restart } = setup();
    const { cookie, key, session } = await login();
    const record = (await store.read("sessions", key))!;
    await store.replace("sessions", key, { ...(record.value as object),
      refresh: { owner: "A".repeat(43), until: Date.now() + 30_000 } }, record.etag);
    await vi.advanceTimersByTimeAsync(hour);
    expect(await restart().session(cookie)).toEqual(session);
    expect(client.renew).toHaveBeenCalledOnce();
    expect((await store.read("sessions", key))!.value).not.toHaveProperty("refresh");
  });

  it("does not authorize a fresh response unless the updated cache was durably persisted", async () => {
    vi.useFakeTimers();
    const { auth, store, login } = setup();
    const { cookie, key } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    const replace = store.replace.bind(store);
    vi.spyOn(store, "replace")
      .mockImplementationOnce(replace)
      .mockRejectedValueOnce(new Error("private Azure write failure"));
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 503, message: "Authentication storage is unavailable." });
    expect((await store.read("sessions", key))!.value).toHaveProperty("refresh");
  });

  it("a durable logout during refresh cannot be resurrected, and does not need Entra availability", async () => {
    vi.useFakeTimers();
    const { auth, client, login, store, restart } = setup();
    const { cookie, key, headers } = await login();
    await vi.advanceTimersByTimeAsync(hour);
    let release!: (value: ReturnType<typeof tokens>) => void;
    vi.mocked(client.renew).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const refresh = expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    await vi.advanceTimersByTimeAsync(1);
    expect((await restart().logout(headers))[0]).toContain("Max-Age=0");
    release(tokens());
    await refresh;
    expect(await store.read("sessions", key)).toBeUndefined();
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
  });

  it("consumes a pending transaction only once even when two runtimes read the same ETag", async () => {
    const { auth, pending, restart, client } = setup();
    const start = await pending();
    const results = await Promise.allSettled([
      auth.callback(start.url, start.browser), restart().callback(start.url, start.browser),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(client.acquireTokenByCode).toHaveBeenCalledTimes(1);
  });

  it("denies bad CSRF and origin, without exposing stored credentials", async () => {
    const { auth, login } = setup();
    const { cookie, headers } = await login();
    await expect(auth.logout({ ...headers, origin: "https://attacker.example" })).rejects.toMatchObject({ status: 403 });
    await expect(auth.logout({ ...headers, "x-csrf-token": "A".repeat(43) })).rejects.toMatchObject({ status: 403 });
    await expect(auth.requireMutation({ ...headers, "content-type": "text/plain" })).rejects.toMatchObject({ status: 415 });
    await expect(auth.session(cookie)).resolves.toMatchObject({ authenticated: true });
  });

  it("distinguishes absent/corrupt records (401) from storage failures (503), with no fallback", async () => {
    const { auth, client, store, login } = setup();
    const { cookie, key } = await login();
    const record = (await store.read("sessions", key))!;
    await store.replace("sessions", key, { version: 1 }, record.etag);
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    const read = vi.spyOn(store, "read");
    read.mockRejectedValueOnce(new InvalidSessionRecord());
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 401 });
    read.mockRejectedValueOnce(new Error("secret azure response"));
    await expect(auth.session(cookie)).rejects.toMatchObject({ status: 503, message: "Authentication storage is unavailable." });
    expect(client.renew).not.toHaveBeenCalled();
  });

  it("can replace a corrupt or old-key session after a successful interactive login", async () => {
    const { auth, store, login, pending } = setup();
    const old = await login();
    const record = (await store.read("sessions", old.key))!;
    const next = await pending();
    const originalRead = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation(async (purpose, key) => {
      if (purpose === "sessions" && key === old.key && await originalRead(purpose, key)) {
        throw new InvalidSessionRecord(record.etag);
      }
      return originalRead(purpose, key);
    });
    const result = await auth.callback(next.url, `${next.browser}; ${old.cookie}`);
    expect(await originalRead("sessions", old.key)).toBeUndefined();
    expect(await auth.session(result.cookies[0].split(";")[0])).toMatchObject({ authenticated: true });
  });

  it("requires a durable store explicitly, and never authorizes a record under another client or tenant", async () => {
    const { client, store, login } = setup();
    expect(() => createEntraAuth(config, client, undefined!)).toThrow("durable encrypted");
    const { cookie } = await login();
    for (const changes of [{ clientId: objectId }, { tenantId: objectId }]) {
      await expect(createEntraAuth({ ...config, ...changes }, client, store).session(cookie)).rejects.toMatchObject({ status: 401 });
    }
  });
});
