export type CollectorCredential = string | (() => Promise<string>);

export async function collectorHeaders(credential: CollectorCredential): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(typeof credential === "string"
      ? { "x-functions-key": credential }
      : { Authorization: `Bearer ${await credential()}` }),
  };
}

export function collectorCredential(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): CollectorCredential | undefined {
  if (!env.ACTIVITY_COLLECTOR_AUTH) return env.ACTIVITY_INGEST_KEY;
  if (env.ACTIVITY_COLLECTOR_AUTH !== "github-oidc") {
    throw new Error("ACTIVITY_COLLECTOR_AUTH must be github-oidc when specified.");
  }
  if (env.ACTIVITY_INGEST_KEY) {
    throw new Error("GitHub OIDC collection must not also configure ACTIVITY_INGEST_KEY.");
  }
  if (!env.ACTIVITY_API_URL) throw new Error("ACTIVITY_API_URL is required for GitHub OIDC collection.");
  const api = URL.parse(env.ACTIVITY_API_URL);
  if (!api || api.protocol !== "https:" || api.username || api.password || api.search || api.hash ||
    api.pathname.replace(/\/+$/, "") !== "/api") {
    throw new Error("GitHub OIDC collection requires an HTTPS ACTIVITY_API_URL ending in /api without credentials.");
  }
  if (env.GITHUB_ACTIONS !== "true" || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("GitHub OIDC collection requires a GitHub Actions job with id-token: write permission.");
  }
  const issuer = URL.parse(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (!issuer || issuer.protocol !== "https:" || !issuer.hostname.endsWith(".actions.githubusercontent.com") ||
    issuer.username || issuer.password || issuer.hash || issuer.port) {
    throw new Error("The GitHub Actions identity request endpoint is invalid.");
  }
  issuer.searchParams.set("audience", `${api.origin}/api/collector`);
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  // Obtain a fresh short-lived token for each request, including after a long collection.
  return async () => {
    const response = await fetcher(issuer, {
      headers: { Authorization: `Bearer ${requestToken}` },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub Actions identity request failed (HTTP ${response.status}).`);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new Error("GitHub Actions identity response is invalid."); }
    if (!value || typeof value !== "object" || !("value" in value) ||
      typeof value.value !== "string" || value.value.length > 16_384 ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value.value)) {
      throw new Error("GitHub Actions identity response is invalid.");
    }
    return value.value;
  };
}
