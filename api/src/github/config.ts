import { readFileSync } from "node:fs";
import type { GitHubAppConfig } from "./client";
import type { GitHubStateConfig } from "./blob";

export function loadGitHubConfig(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required. See docs/github-activity-local.md.`);
    return value;
  }
  const repository = required("GITHUB_STATE_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GITHUB_STATE_REPOSITORY must be owner/repo.");
  const branch = env.GITHUB_STATE_BRANCH ?? "dashboard-state";
  if (!/^[a-zA-Z0-9][\w-]{0,99}$/.test(branch)) throw new Error("Use a simple dedicated state branch name.");
  const appId = required("GITHUB_APP_ID");
  const installationId = required("GITHUB_APP_INSTALLATION_ID");
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) throw new Error("GitHub App and installation IDs must be numeric.");
  const origin = new URL(env.ACTIVITY_WEB_ORIGIN ?? "http://127.0.0.1:5173");
  if (origin.origin !== origin.href.replace(/\/$/, "") ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)))) {
    throw new Error("ACTIVITY_WEB_ORIGIN must be an HTTPS origin or a loopback HTTP origin.");
  }
  const allowedUsers = required("GITHUB_ALLOWED_USERS").split(",").map((user) => user.trim().toLowerCase());
  if (allowedUsers.some((user) => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(user))) {
    throw new Error("GITHUB_ALLOWED_USERS must contain explicit GitHub logins, not wildcards.");
  }
  const ingestKey = required("ACTIVITY_INGEST_KEY");
  if (Buffer.byteLength(ingestKey) < 32) throw new Error("ACTIVITY_INGEST_KEY must contain at least 32 bytes.");
  const port = Number(env.ACTIVITY_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ACTIVITY_PORT is invalid.");
  const app: GitHubAppConfig = {
    appId, installationId, repository, privateKey: readFileSync(required("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8"),
  };
  const state: GitHubStateConfig = { repository, branch, allowPublic: env.GITHUB_STATE_ALLOW_PUBLIC === "true" };
  return {
    app, state, port, ingestKey, origin: origin.origin,
    auth: {
      clientId: required("GITHUB_APP_CLIENT_ID"), clientSecret: required("GITHUB_APP_CLIENT_SECRET"),
      allowedUsers, callbackUrl: `${origin.origin}/api/auth/callback`,
      dashboardUrl: `${origin.origin}/sdk-js-worker/`,
      secureCookies: origin.protocol === "https:",
    },
  };
}
