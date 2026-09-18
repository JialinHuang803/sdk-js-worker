import { sharedActivityClient } from "./shared-activity-client.ts";
import { fetchPublishedSnapshot } from "./published-snapshot.ts";
import { isDashboardSnapshot } from "../src/data/contracts.ts";

async function main() {
  const client = sharedActivityClient(process.env.ACTIVITY_API_URL, process.env.ACTIVITY_INGEST_KEY);
  if (!client) throw new Error("Configure ACTIVITY_API_URL and ACTIVITY_INGEST_KEY to seed shared activity.");
  if ((await client.baseline()).snapshot !== null) {
    throw new Error("Shared activity already has a baseline. Seed does not replace existing state.");
  }
  const text = await fetchPublishedSnapshot(process.env.PREVIOUS_SNAPSHOT_URL ??
    "https://jialinhuang803.github.io/sdk-js-worker/data/sdk-prs.json");
  const snapshot: unknown = JSON.parse(text);
  if (!isDashboardSnapshot(snapshot) || snapshot.stale) {
    throw new Error("Seed requires a valid, non-stale published snapshot.");
  }
  await client.ingest({ snapshot, inactivePullRequests: [] });
  console.log("Seeded shared activity from the existing published snapshot. No GitHub collection or Pages data refresh performed.");
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Activity seed failed.");
  process.exitCode = 1;
});
