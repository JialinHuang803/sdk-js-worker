import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntraAuth, type AzureAuthConfig, type EntraClient } from "../api/src/azure/auth";

const config: AzureAuthConfig = {
  mode: "entra-federated", tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  clientId: "d8714cdb-8d6d-443e-969a-5beab691ce59",
  managedIdentityClientId: "11111111-1111-4111-8111-111111111111",
  accessPolicy: "allowlist", allowedObjectIds: ["1c15547f-ea83-425d-aeaf-7312df6f6148"], origin: "https://dashboard.example",
};
function setup(overrides: Record<string, unknown> = {}, authConfig = config) {
  let authorization: Parameters<EntraClient["getAuthCodeUrl"]>[0];
  const getAuthCodeUrl = vi.fn<EntraClient["getAuthCodeUrl"]>(async (request) => {
    authorization = request;
    return `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?state=${request.state}`;
  });
  const acquireTokenByCode = vi.fn<EntraClient["acquireTokenByCode"]>(async () => ({
    idTokenClaims: {
      tid: config.tenantId, aud: config.clientId, oid: config.allowedObjectIds[0],
      iss: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      nonce: authorization.nonce, exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000), name: "Test reviewer", ...overrides,
    },
  }));
  const auth = createEntraAuth(authConfig, { getAuthCodeUrl, acquireTokenByCode });
  async function start() {
    const result = await auth.start();
    return { ...result, browser: result.cookies[0].split(";")[0],
      url: new URL(`${config.origin}/api/auth/callback?code=test-code&state=${authorization.state}`) };
  }
  return { auth, start, getAuthCodeUrl, acquireTokenByCode, authorization: () => authorization };
}
afterEach(() => vi.useRealTimers());

describe("Entra authorization-code PKCE BFF", () => {
  it("uses nonce, S256 PKCE, browser binding and secure opaque cookies without exposing tokens", async () => {
    const { auth, start, authorization, acquireTokenByCode } = setup();
    const login = await start();
    expect(authorization()).toMatchObject({
      redirectUri: `${config.origin}/api/auth/callback`, responseMode: "query", codeChallengeMethod: "S256",
      scopes: ["openid", "profile"], prompt: "select_account",
    });
    expect(authorization().nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization().state).not.toBe(authorization().nonce);
    expect(login.cookies[0]).toMatch(/^__Host-activity_oauth=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const result = await auth.callback(login.url, login.browser);
    const exchange = acquireTokenByCode.mock.calls[0][0];
    expect(exchange).toMatchObject({ code: "test-code", redirectUri: `${config.origin}/api/auth/callback`, nonce: authorization().nonce });
    expect(createHash("sha256").update(exchange.codeVerifier!).digest("base64url")).toBe(authorization().codeChallenge);
    expect(result.location).toBe(`${config.origin}/`);
    expect(result.cookies[0]).toMatch(/^__Host-activity_session=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(result.cookies[1]).toContain("Max-Age=0");
    const cookie = result.cookies[0].split(";")[0];
    expect(auth.session(cookie)).toEqual({
      authenticated: true, login: "Test reviewer", csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(result)).not.toMatch(/idToken|accessToken|test-code|codeVerifier/);
    expect(() => auth.session(`${cookie}; ${cookie}`)).toThrow("sign-in is required");
  });

  it("rejects missing/wrong browser state, duplicate parameters, replay and provider rejection", async () => {
    const { auth, start, acquireTokenByCode } = setup();
    const login = await start();
    await expect(auth.callback(login.url, undefined)).rejects.toMatchObject({ status: 400 });
    await expect(auth.callback(login.url, `__Host-activity_oauth=${"A".repeat(43)}`)).rejects.toMatchObject({ status: 400 });
    const duplicate = new URL(login.url);
    duplicate.searchParams.append("state", duplicate.searchParams.get("state")!);
    await expect(auth.callback(duplicate, login.browser)).rejects.toMatchObject({ status: 400 });
    expect(acquireTokenByCode).not.toHaveBeenCalled();
    await auth.callback(login.url, login.browser);
    await expect(auth.callback(login.url, login.browser)).rejects.toMatchObject({ status: 400 });
    const rejected = await start();
    rejected.url.searchParams.set("error", "access_denied");
    await expect(auth.callback(rejected.url, rejected.browser)).rejects.toMatchObject({ status: 400 });
    const duplicateCode = await start();
    duplicateCode.url.searchParams.append("code", "other");
    await expect(auth.callback(duplicateCode.url, duplicateCode.browser)).rejects.toMatchObject({ status: 400 });
    expect(acquireTokenByCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tid: "11111111-1111-4111-8111-111111111111" }, { oid: "not-a-user" },
    { aud: "11111111-1111-4111-8111-111111111111" }, { iss: "https://attacker.example" },
    { nonce: "A".repeat(43) }, { nonce: undefined }, { exp: 0 }, { exp: "future" },
    { iat: Math.floor(Date.now() / 1000) + 600 }, { nbf: Math.floor(Date.now() / 1000) + 600 },
  ])("rejects untrusted identity claims %j", async (claims) => {
    const { auth, start } = setup(claims);
    const login = await start();
    await expect(auth.callback(login.url, login.browser)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects users outside the immutable object allowlist and never trusts display names", async () => {
    const { auth, start } = setup({ oid: "11111111-1111-4111-8111-111111111111", name: config.allowedObjectIds[0] });
    const login = await start();
    await expect(auth.callback(login.url, login.browser)).rejects.toMatchObject({ status: 403 });
  });

  it.each([0, "0"])("allows a tenant member outside the former allowlist with acct=%j", async (acct) => {
    const { auth, start } = setup({ oid: "11111111-1111-4111-8111-111111111111", acct },
      { ...config, accessPolicy: "tenant-members", allowedObjectIds: [] });
    const login = await start();
    const result = await auth.callback(login.url, login.browser);
    const sessionCookie = result.cookies[0].split(";")[0];
    const session = auth.session(sessionCookie);
    expect(session.authenticated).toBe(true);
    expect(auth.requireMutation({ cookie: sessionCookie, origin: config.origin,
      "content-type": "application/json", "x-csrf-token": session.csrfToken }).objectId)
      .toBe("11111111-1111-4111-8111-111111111111");
  });

  it.each([1, "1", undefined, null, false, "", "00", [], {}, 2])(
    "rejects guest, missing and malformed membership claims: %j", async (acct) => {
      const { auth, start } = setup({ acct, preferred_username: "member@microsoft.com" },
        { ...config, accessPolicy: "tenant-members", allowedObjectIds: [] });
      const login = await start();
      await expect(auth.callback(login.url, login.browser)).rejects.toMatchObject({ status: 403 });
      expect(() => auth.session(undefined)).toThrow("sign-in is required");
    });

  it("does not treat a member of another tenant as a member of the configured tenant", async () => {
    const { auth, start } = setup({ acct: 0, tid: "11111111-1111-4111-8111-111111111111" },
      { ...config, accessPolicy: "tenant-members", allowedObjectIds: [] });
    const login = await start();
    await expect(auth.callback(login.url, login.browser)).rejects.toMatchObject({ status: 401 });
  });

  it("expires pending state and sessions, rotates prior sessions and binds CSRF to each session", async () => {
    vi.useFakeTimers();
    const { auth, start } = setup();
    const expired = await start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(auth.callback(expired.url, expired.browser)).rejects.toMatchObject({ status: 400 });
    const first = await start();
    const firstCookie = (await auth.callback(first.url, first.browser)).cookies[0].split(";")[0];
    const firstCsrf = auth.session(firstCookie).csrfToken;
    const second = await start();
    const secondCookie = (await auth.callback(second.url, `${second.browser}; ${firstCookie}`)).cookies[0].split(";")[0];
    expect(() => auth.session(firstCookie)).toThrow("sign-in is required");
    expect(() => auth.requireMutation({ cookie: secondCookie, origin: config.origin,
      "content-type": "application/json", "x-csrf-token": firstCsrf })).toThrow("CSRF");
    const csrf = auth.session(secondCookie).csrfToken;
    expect(auth.requireMutation({ cookie: secondCookie, origin: config.origin,
      "content-type": "application/json", "x-csrf-token": csrf }).login).toBe("Test reviewer");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(() => auth.session(secondCookie)).toThrow("sign-in is required");
  });

  it("fails closed on unavailable or timed-out code exchange without logging or returning tokens", async () => {
    vi.useFakeTimers();
    const { auth, start, acquireTokenByCode } = setup();
    acquireTokenByCode.mockRejectedValueOnce(new Error("sensitive upstream token response"));
    const unavailable = await start();
    await expect(auth.callback(unavailable.url, unavailable.browser)).rejects.toThrow("code exchange is unavailable");
    acquireTokenByCode.mockImplementationOnce(() => new Promise(() => {}));
    const slow = await start();
    const result = expect(auth.callback(slow.url, slow.browser)).rejects.toThrow("code exchange is unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });
});
