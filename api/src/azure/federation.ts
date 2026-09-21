import { ManagedIdentityCredential } from "@azure/identity";
import { ConfidentialClientApplication, InteractionRequiredAuthError, ServerError,
  type AuthenticationResult, type NetworkRequestOptions, type NetworkResponse } from "@azure/msal-node";
import { InteractiveSignInRequired, type AzureAuthConfig, type EntraClient } from "./auth";

async function request<T>(url: string, method: "GET" | "POST", options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
  const response = await fetch(url, {
    method, headers: options?.headers, body: method === "POST" ? options?.body : undefined,
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error("Microsoft Entra response is too large.");
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, headers,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T };
}

export function createFederatedEntraClient(config: AzureAuthConfig): EntraClient {
  const credential = new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
  const createClient = () => new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientCapabilities: ["CP1"],
      clientAssertion: async () => {
        const assertion = await credential.getToken("api://AzureADTokenExchange/.default", {
          abortSignal: AbortSignal.timeout(15_000),
        });
        if (!assertion?.token) throw new Error("Managed identity token exchange is unavailable.");
        return assertion.token;
      },
    },
    system: {
      loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      disableInternalRetries: true,
      networkClient: {
        sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => request<T>(url, "GET", options),
        sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => request<T>(url, "POST", options),
      },
    },
  });
  const tokens = (client: ConfidentialClientApplication, result: AuthenticationResult | null) => {
    if (!result || result.fromCache !== false || !result.account || result.account.tenantId !== config.tenantId) {
      throw new InteractiveSignInRequired();
    }
    return { idTokenClaims: result.idTokenClaims, cache: client.getTokenCache().serialize(),
      accountId: result.account.homeAccountId };
  };
  return {
    async getAuthCodeUrl(request) { return createClient().getAuthCodeUrl(request); },
    async acquireTokenByCode(request) {
      const client = createClient();
      try {
        const result = await client.acquireTokenByCode(request);
        return tokens(client, result);
      } finally {
        await client.clearCache();
      }
    },
    async renew(cache, accountId) {
      const client = createClient();
      try {
        try { client.getTokenCache().deserialize(cache); }
        catch { throw new InteractiveSignInRequired(); }
        const account = await client.getTokenCache().getAccountByHomeId(accountId);
        if (!account || account.homeAccountId !== accountId || account.tenantId !== config.tenantId) {
          throw new InteractiveSignInRequired();
        }
        const result = await client.acquireTokenSilent({
          account, scopes: ["openid", "profile", "offline_access"], forceRefresh: true,
        });
        if (result?.account?.homeAccountId !== accountId) throw new InteractiveSignInRequired();
        return tokens(client, result);
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError ||
          (error instanceof ServerError && (["invalid_grant", "interaction_required", "login_required", "consent_required"]
            .includes(error.errorCode) || Boolean((error as ServerError & { claims?: string }).claims)))) {
          throw new InteractiveSignInRequired();
        }
        throw error;
      } finally { await client.clearCache(); }
    },
  };
}
