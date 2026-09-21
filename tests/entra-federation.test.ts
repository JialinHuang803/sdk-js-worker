import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFederatedEntraClient } from "../api/src/azure/federation";
import type { AzureAuthConfig } from "../api/src/azure/auth";

const spies = vi.hoisted(() => ({
  managedIdentity: vi.fn(),
  application: vi.fn(),
  token: vi.fn(),
  authorize: vi.fn(),
  exchange: vi.fn(),
  clear: vi.fn(),
  serialize: vi.fn(),
  deserialize: vi.fn(),
  account: vi.fn(),
  silent: vi.fn(),
}));
vi.mock("../api/node_modules/@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) { spies.managedIdentity(options); }
    getToken(...args: unknown[]) { return spies.token(...args); }
  },
}));
vi.mock("../api/node_modules/@azure/msal-node", async (importOriginal) => ({
  ...await importOriginal<object>(),
  ConfidentialClientApplication: class {
    constructor(options: unknown) { spies.application(options); }
    getAuthCodeUrl(request: unknown) { return spies.authorize(request); }
    acquireTokenByCode(request: unknown) { return spies.exchange(request); }
    clearCache() { spies.clear(); }
    acquireTokenSilent(request: unknown) { return spies.silent(request); }
    getTokenCache() { return { serialize: spies.serialize, deserialize: spies.deserialize, getAccountByHomeId: spies.account }; }
  },
}));
const config: AzureAuthConfig = {
  mode: "entra-federated", tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  clientId: "d8714cdb-8d6d-443e-969a-5beab691ce59",
  managedIdentityClientId: "11111111-1111-4111-8111-111111111111",
  accessPolicy: "allowlist", allowedObjectIds: ["1c15547f-ea83-425d-aeaf-7312df6f6148"], origin: "https://dashboard.example",
};
beforeEach(() => {
  vi.clearAllMocks();
  spies.token.mockResolvedValue({ token: "server-only-mi-assertion" });
  spies.authorize.mockResolvedValue("https://login.microsoftonline.com/authorize");
  spies.serialize.mockReturnValue('{"encryptedServerOnly":"refreshed-cache"}');
  spies.account.mockResolvedValue({ homeAccountId: "account-id", tenantId: config.tenantId });
  spies.exchange.mockResolvedValue({ idTokenClaims: { tid: config.tenantId },
    account: { homeAccountId: "account-id", tenantId: config.tenantId }, fromCache: false,
    accessToken: "must-not-escape", idToken: "must-not-escape" });
  spies.silent.mockImplementation(() => spies.exchange());
});
afterEach(() => vi.unstubAllGlobals());

describe("MSAL managed identity client federation", () => {
  it("pins authority/client and uses only the selected MI token-exchange assertion, never a client secret", async () => {
    const client = createFederatedEntraClient(config);
    expect(spies.managedIdentity).toHaveBeenCalledWith({ clientId: config.managedIdentityClientId });
    await client.getAuthCodeUrl({ scopes: ["openid", "profile"], redirectUri: `${config.origin}/api/auth/callback` });
    const options = spies.application.mock.calls[0][0];
    expect(options.auth).toEqual({
      clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientCapabilities: ["CP1"],
      clientAssertion: expect.any(Function),
    });
    expect(await options.auth.clientAssertion()).toBe("server-only-mi-assertion");
    expect(spies.token).toHaveBeenCalledWith("api://AzureADTokenExchange/.default", { abortSignal: expect.any(AbortSignal) });
    expect(options.system.loggerOptions.piiLoggingEnabled).toBe(false);
    expect(options.cache).toBeUndefined();
  });

  it("returns claims/account and a server-only cache, clearing each isolated client on success and failure", async () => {
    const client = createFederatedEntraClient(config);
    const request = { scopes: ["openid", "profile"], code: "test-code",
      redirectUri: `${config.origin}/api/auth/callback`, codeVerifier: "test-pkce", nonce: "test-nonce" };
    expect(await client.acquireTokenByCode(request)).toEqual({ idTokenClaims: { tid: config.tenantId },
      accountId: "account-id", cache: '{"encryptedServerOnly":"refreshed-cache"}' });
    expect(spies.exchange).toHaveBeenCalledWith(request);
    expect(spies.clear).toHaveBeenCalledTimes(1);
    spies.exchange.mockRejectedValueOnce(new Error("exchange failed"));
    await expect(client.acquireTokenByCode(request)).rejects.toThrow("exchange failed");
    expect(spies.clear).toHaveBeenCalledTimes(2);
    expect(spies.application).toHaveBeenCalledTimes(2);
  });

  it("deserializes the expected account and forces online renewal before serializing its fresh cache", async () => {
    const client = createFederatedEntraClient(config);
    expect(await client.renew("server-cache", "account-id")).toEqual({
      idTokenClaims: { tid: config.tenantId }, accountId: "account-id", cache: '{"encryptedServerOnly":"refreshed-cache"}',
    });
    expect(spies.deserialize).toHaveBeenCalledWith("server-cache");
    expect(spies.account).toHaveBeenCalledWith("account-id");
    expect(spies.silent).toHaveBeenCalledWith({
      account: { homeAccountId: "account-id", tenantId: config.tenantId },
      scopes: ["openid", "profile", "offline_access"], forceRefresh: true,
    });
    expect(spies.clear).toHaveBeenCalledOnce();
  });

  it("rejects cached results, changed accounts, missing accounts, invalid caches and tenant changes", async () => {
    const client = createFederatedEntraClient(config);
    spies.account.mockResolvedValueOnce(null);
    await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    spies.deserialize.mockImplementationOnce(() => { throw new Error("bad cache"); });
    await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    spies.exchange.mockResolvedValueOnce({ fromCache: true, account: { homeAccountId: "account-id", tenantId: config.tenantId } });
    await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    spies.exchange.mockResolvedValueOnce({ account: { homeAccountId: "different", tenantId: config.tenantId } });
    await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    spies.account.mockResolvedValueOnce({ homeAccountId: "account-id", tenantId: "other-tenant" });
    await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    expect(spies.clear).toHaveBeenCalledTimes(5);
  });

  it("maps MSAL revocation and interaction requirements to reauthentication, not transient failures", async () => {
    const { InteractionRequiredAuthError, ServerError } = await import("../api/node_modules/@azure/msal-node");
    const client = createFederatedEntraClient(config);
    for (const error of [new InteractionRequiredAuthError("interaction_required", ""), new ServerError("invalid_grant", ""),
      Object.assign(new ServerError("other", ""), { claims: '{"challenge":"server-only"}' })]) {
      spies.silent.mockRejectedValueOnce(error);
      await expect(client.renew("cache", "account-id")).rejects.toThrow("sign-in is required");
    }
    spies.silent.mockRejectedValueOnce(new ServerError("temporarily_unavailable", ""));
    await expect(client.renew("cache", "account-id")).rejects.toMatchObject({ errorCode: "temporarily_unavailable" });
  });

  it("bounds MSAL HTTP transport, disables redirects and preserves protocol errors for classification", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    const client = createFederatedEntraClient(config);
    await client.getAuthCodeUrl({ scopes: ["openid"], redirectUri: `${config.origin}/api/auth/callback` });
    const network = spies.application.mock.calls[0][0].system.networkClient;
    expect(await network.sendPostRequestAsync("https://login.microsoftonline.com/token", { body: "server-only" }))
      .toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(fetch).toHaveBeenCalledWith("https://login.microsoftonline.com/token", expect.objectContaining({
      method: "POST", body: "server-only", signal: expect.any(AbortSignal), redirect: "error",
    }));
    fetch.mockResolvedValueOnce(new Response("A".repeat(1024 * 1024 + 1)));
    await expect(network.sendGetRequestAsync("https://login.microsoftonline.com/metadata")).rejects.toThrow("too large");
  });

  it("fails closed if the selected managed identity cannot provide an assertion", async () => {
    const client = createFederatedEntraClient(config);
    await client.getAuthCodeUrl({ scopes: ["openid"], redirectUri: `${config.origin}/api/auth/callback` });
    spies.token.mockResolvedValueOnce(null);
    await expect(spies.application.mock.calls[0][0].auth.clientAssertion()).rejects.toThrow("unavailable");
  });
});
