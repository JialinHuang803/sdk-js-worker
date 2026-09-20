import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFederatedEntraClient } from "../api/src/azure/federation";
import type { AzureAuthConfig } from "../api/src/azure/auth";

const spies = vi.hoisted(() => ({
  managedIdentity: vi.fn(),
  application: vi.fn(),
  token: vi.fn(),
  authorize: vi.fn(),
  exchange: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("../api/node_modules/@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) { spies.managedIdentity(options); }
    getToken(...args: unknown[]) { return spies.token(...args); }
  },
}));
vi.mock("../api/node_modules/@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    constructor(options: unknown) { spies.application(options); }
    getAuthCodeUrl(request: unknown) { return spies.authorize(request); }
    acquireTokenByCode(request: unknown) { return spies.exchange(request); }
    clearCache() { spies.clear(); }
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
  spies.exchange.mockResolvedValue({ idTokenClaims: { tid: config.tenantId },
    accessToken: "must-not-escape", idToken: "must-not-escape" });
});

describe("MSAL managed identity client federation", () => {
  it("pins authority/client and uses only the selected MI token-exchange assertion, never a client secret", async () => {
    const client = createFederatedEntraClient(config);
    expect(spies.managedIdentity).toHaveBeenCalledWith({ clientId: config.managedIdentityClientId });
    await client.getAuthCodeUrl({ scopes: ["openid", "profile"], redirectUri: `${config.origin}/api/auth/callback` });
    const options = spies.application.mock.calls[0][0];
    expect(options.auth).toEqual({
      clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientAssertion: expect.any(Function),
    });
    expect(await options.auth.clientAssertion()).toBe("server-only-mi-assertion");
    expect(spies.token).toHaveBeenCalledWith("api://AzureADTokenExchange/.default", { abortSignal: expect.any(AbortSignal) });
    expect(options.system.loggerOptions.piiLoggingEnabled).toBe(false);
    expect(options.cache).toBeUndefined();
  });

  it("returns claims only and clears each isolated MSAL cache on both success and failure", async () => {
    const client = createFederatedEntraClient(config);
    const request = { scopes: ["openid", "profile"], code: "test-code",
      redirectUri: `${config.origin}/api/auth/callback`, codeVerifier: "test-pkce", nonce: "test-nonce" };
    expect(await client.acquireTokenByCode(request)).toEqual({ idTokenClaims: { tid: config.tenantId } });
    expect(spies.exchange).toHaveBeenCalledWith(request);
    expect(spies.clear).toHaveBeenCalledTimes(1);
    spies.exchange.mockRejectedValueOnce(new Error("exchange failed"));
    await expect(client.acquireTokenByCode(request)).rejects.toThrow("exchange failed");
    expect(spies.clear).toHaveBeenCalledTimes(2);
    expect(spies.application).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the selected managed identity cannot provide an assertion", async () => {
    const client = createFederatedEntraClient(config);
    await client.getAuthCodeUrl({ scopes: ["openid"], redirectUri: `${config.origin}/api/auth/callback` });
    spies.token.mockResolvedValueOnce(null);
    await expect(spies.application.mock.calls[0][0].auth.clientAssertion()).rejects.toThrow("unavailable");
  });
});
