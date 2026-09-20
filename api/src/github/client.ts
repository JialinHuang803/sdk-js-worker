import { createPrivateKey, sign } from "node:crypto";
import { ActivityError } from "../engine";

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: string;
}

export function createGitHubClient(config: GitHubAppConfig, fetcher: typeof fetch = fetch) {
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App private key must be RSA.");
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function issueToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: now - 60, exp: now + 9 * 60, iss: config.appId,
    })}`;
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    const response = await fetcher(
      `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
      {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json",
          "Content-Type": "application/json", "User-Agent": "sdk-js-worker-activity" },
        body: JSON.stringify({
          repositories: [config.repository.split("/")[1]],
          permissions: { contents: "write" },
        }),
      },
    );
    if (!response.ok) throw new ActivityError(503, "GitHub App installation authentication failed.");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("token" in value) ||
        typeof value.token !== "string" || !value.token ||
        !("expires_at" in value) || typeof value.expires_at !== "string" ||
        !Number.isFinite(Date.parse(value.expires_at)) ||
        Date.parse(value.expires_at) <= Date.now() + 60_000) {
      throw new ActivityError(503, "GitHub returned an invalid installation token.");
    }
    cached = { token: value.token, expiresAt: Date.parse(value.expires_at) };
    return value.token;
  }

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    pending ??= issueToken();
    try { return await pending; } finally { pending = undefined; }
  }

  return {
    async request(path: string, init: RequestInit = {}): Promise<Response> {
      const repositoryPath = `/repos/${config.repository}`;
      if (path !== repositoryPath && !path.startsWith(`${repositoryPath}/`)) {
        throw new Error("GitHub request is outside the configured state repository.");
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await token()}`);
      headers.set("Accept", "application/vnd.github+json");
      headers.set("User-Agent", "sdk-js-worker-activity");
      headers.set("X-GitHub-Api-Version", "2022-11-28");
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetcher(`https://api.github.com${path}`, {
        ...init, headers, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) cached = undefined;
      return response;
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
