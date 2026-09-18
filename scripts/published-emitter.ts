import { isEmitterSnapshot } from "../src/data/emitter-contracts.ts";

export async function fetchPublishedEmitter(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("cacheBust", Date.now().toString());
  const response = await fetcher(requestUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  // Before the first emitter collection, leave this view explicitly unavailable.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Published emitter download failed: HTTP ${response.status}`);
  const text = await response.text();
  if (!isEmitterSnapshot(JSON.parse(text))) {
    throw new Error("Published emitter snapshot is invalid; refusing to replace the deployment.");
  }
  return text;
}
