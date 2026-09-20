import { ActivityError } from "../engine";
import type { StateBlob } from "../store";
import type { GitHubClient } from "./client";

// Contents API JSON responses support files up to 1 MiB; fail before outgrowing that format.
export const MAX_STATE_BYTES = 900_000;
export interface GitHubStateConfig {
  repository: string;
  branch: string;
  allowPublic: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function createGitHubState(client: GitHubClient, config: GitHubStateConfig) {
  const root = `/repos/${config.repository}`;
  let verified: Promise<void> | undefined;

  async function verify(): Promise<void> {
    // A missing/inaccessible repo or branch must not be mistaken for new activity state.
    const repo = await client.request(root);
    if (!repo.ok) throw new ActivityError(503, "State repository is unavailable to the GitHub App.");
    const info: unknown = await repo.json();
    if (!object(info) || typeof info.private !== "boolean" || typeof info.default_branch !== "string") {
      throw new ActivityError(503, "Invalid state repository response.");
    }
    if (!info.private && !config.allowPublic) {
      throw new ActivityError(503, "State repository must be private unless public history is explicitly accepted.");
    }
    if (config.branch === info.default_branch) {
      throw new ActivityError(503, "Use a dedicated state branch, not the repository default branch.");
    }
    const branch = await client.request(`${root}/git/ref/heads/${encodeURIComponent(config.branch)}`);
    if (!branch.ok) throw new ActivityError(503, "State branch is missing or inaccessible. Initialize it explicitly.");
  }
  async function ready() {
    verified ??= verify();
    try { await verified; } catch (error) { verified = undefined; throw error; }
  }

  function blob(source: "sdk" | "emitter", initialization = false): StateBlob {
    const path = `${root}/contents/activity/${source}.json`;
    return {
      async read() {
        await ready();
        const response = await client.request(`${path}?ref=${encodeURIComponent(config.branch)}`);
        if (response.status === 404) {
          // Recheck access and branch before interpreting a missing file during explicit initialization.
          await verify();
          if (initialization) return null;
          throw new ActivityError(503, "Activity state is missing. Import or initialize it explicitly; it was not reset.");
        }
        if (!response.ok) throw new ActivityError(503, "GitHub activity state could not be read.");
        const value: unknown = await response.json();
        if (!object(value) || value.type !== "file" || value.encoding !== "base64" ||
            typeof value.content !== "string" || typeof value.sha !== "string" ||
            !/^[a-f0-9]{40}$/.test(value.sha) || typeof value.size !== "number" ||
            value.size > MAX_STATE_BYTES) {
          throw new ActivityError(503, "GitHub activity state is invalid or too large. No data was changed.");
        }
        const text = Buffer.from(value.content, "base64").toString("utf8");
        if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new ActivityError(503, "Activity state is too large.");
        return { text, etag: value.sha };
      },
      async write(text, etag) {
        await ready();
        if (!etag && !initialization) throw new ActivityError(503, "Activity state must be initialized explicitly.");
        if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
          throw new ActivityError(503, "Activity history needs archival before accepting more writes.");
        }
        const response = await client.request(path, {
          method: "PUT",
          body: JSON.stringify({
            message: `Update ${source} shared activity state`,
            content: Buffer.from(text).toString("base64"), branch: config.branch,
            ...(etag ? { sha: etag } : {}),
          }),
        });
        if (response.status === 409 || (initialization && !etag && response.status === 422)) {
          // Reuse the existing optimistic-concurrency retry in both activity engines.
          throw Object.assign(new Error("GitHub state changed concurrently."), { statusCode: 412 });
        }
        if (!response.ok) throw new ActivityError(503, "GitHub activity state write failed. Reload before retrying.");
      },
    };
  }
  return { blob };
}
