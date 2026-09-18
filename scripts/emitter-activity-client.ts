import { isEmitterSnapshot } from "../src/data/emitter-contracts.ts";
import type { EmitterActivityBaseline, EmitterActivityIngestRequest } from "../src/data/emitter-activity-contracts.ts";

export function emitterActivityClient(
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
  if (!key) throw new Error("ACTIVITY_INGEST_KEY is required for shared emitter activity collection.");
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "x-functions-key": key, "Content-Type": "application/json" };

  async function send(path: string, body?: EmitterActivityIngestRequest): Promise<Response> {
    const response = await fetcher(`${base}/emitter-activity/${path}`, {
      method: body ? "POST" : "GET", headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store", signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Shared emitter activity ${path} failed (HTTP ${response.status}).`);
    return response;
  }

  return {
    async baseline(): Promise<EmitterActivityBaseline> {
      const value: unknown = await (await send("baseline")).json();
      if (!value || typeof value !== "object" || !("snapshot" in value) ||
        (value.snapshot !== null && !isEmitterSnapshot(value.snapshot))) {
        throw new Error("Shared emitter activity baseline is invalid; collection stopped.");
      }
      return { snapshot: value.snapshot?.activity ? value.snapshot : null };
    },
    async ingest(body: EmitterActivityIngestRequest): Promise<void> {
      await send("ingest", body);
    },
  };
}
