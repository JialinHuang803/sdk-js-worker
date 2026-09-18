import { isDashboardSnapshot } from "../src/data/contracts.ts";
import type {
  ActivityBaseline,
  ActivityIngestRequest,
  SharedActivityPull,
} from "../src/data/activity-contracts.ts";

export function sharedActivityClient(
  baseUrl: string | undefined,
  key: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  if (!baseUrl) {
    if (key) throw new Error("ACTIVITY_API_URL is required when ACTIVITY_INGEST_KEY is set.");
    return null;
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("ACTIVITY_API_URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ACTIVITY_API_URL must not contain credentials, query, or fragment.");
  }
  if (!key) throw new Error("ACTIVITY_INGEST_KEY is required for shared activity collection.");
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "x-functions-key": key, "Content-Type": "application/json" };

  async function send(path: string, body?: ActivityIngestRequest): Promise<Response> {
    const response = await fetcher(`${base}/activity/${path}`, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // Do not echo response bodies, which could contain sensitive infrastructure details.
      throw new Error(`Shared activity ${path} failed (HTTP ${response.status}).`);
    }
    return response;
  }

  return {
    async baseline(): Promise<ActivityBaseline> {
      const value: unknown = await (await send("baseline")).json();
      if (!value || typeof value !== "object" ||
          !("snapshot" in value) || !("trackedPullRequests" in value) ||
          (value.snapshot !== null && (!isDashboardSnapshot(value.snapshot) ||
            !Number.isFinite(Date.parse(value.snapshot.generatedAt)))) ||
          !Array.isArray(value.trackedPullRequests) ||
          !value.trackedPullRequests.every(isTrackedPull)) {
        throw new Error("Shared activity baseline is invalid; collection stopped.");
      }
      return { snapshot: value.snapshot, trackedPullRequests: value.trackedPullRequests };
    },
    async ingest(body: ActivityIngestRequest): Promise<void> {
      await send("ingest", body);
    },
  };
}

function isTrackedPull(value: unknown): value is SharedActivityPull {
  if (!value || typeof value !== "object") return false;
  const pull = value as Partial<SharedActivityPull>;
  return typeof pull.repository === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(pull.repository) &&
    Number.isSafeInteger(pull.number) && Number(pull.number) > 0 &&
    typeof pull.title === "string" && typeof pull.url === "string" &&
    (pull.plane === "management" || pull.plane === "data") &&
    typeof pull.draft === "boolean" && typeof pull.holdOn === "boolean" &&
    (pull.state === "open" || pull.state === "merged" || pull.state === "closed") &&
    Array.isArray(pull.packages);
}
