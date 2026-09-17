import { isDashboardSnapshot } from "../src/data/contracts.ts";

export async function fetchPublishedSnapshot(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("cacheBust", Date.now().toString());
  const response = await fetcher(requestUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Published snapshot download failed: HTTP ${response.status}`);
  }

  const text = await response.text();
  const value: unknown = JSON.parse(text);
  if (
    !isDashboardSnapshot(value) ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    value.inbox.generatedAt !== value.generatedAt ||
    typeof value.inbox.baselineAvailable !== "boolean" ||
    (value.inbox.defaultPlane !== "management" &&
      value.inbox.defaultPlane !== "data") ||
    (value.inbox.comparisonFrom !== null &&
      (typeof value.inbox.comparisonFrom !== "string" ||
        !Number.isFinite(Date.parse(value.inbox.comparisonFrom))))
  ) {
    throw new Error(
      "Published snapshot is invalid or incompatible with this UI. " +
        "Run Collect and deploy dashboard explicitly to publish compatible data.",
    );
  }
  // Preserve activity, freshness and stale state byte-for-byte across UI deploys.
  return text;
}
