import { ManagedIdentityCredential } from "@azure/identity";
import { ConfidentialClientApplication } from "@azure/msal-node";
import type { AzureAuthConfig, EntraClient } from "./auth";

export function createFederatedEntraClient(config: AzureAuthConfig): EntraClient {
  const credential = new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
  const createClient = () => new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientAssertion: async () => {
        const assertion = await credential.getToken("api://AzureADTokenExchange/.default", {
          abortSignal: AbortSignal.timeout(15_000),
        });
        if (!assertion?.token) throw new Error("Managed identity token exchange is unavailable.");
        return assertion.token;
      },
    },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
  return {
    async getAuthCodeUrl(request) { return createClient().getAuthCodeUrl(request); },
    async acquireTokenByCode(request) {
      const client = createClient();
      try {
        const result = await client.acquireTokenByCode(request);
        return { idTokenClaims: result.idTokenClaims };
      } finally {
        // No token cache persistence, refresh tokens, or browser tokens are used by this BFF.
        client.clearCache();
      }
    },
  };
}
