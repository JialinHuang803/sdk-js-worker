import { isEmitterSnapshot, type EmitterSnapshot } from "../../data/emitter-contracts";
import { useSnapshot, type SnapshotState } from "../../shared/useSnapshot";

export type EmitterDataState = SnapshotState<EmitterSnapshot>;

export async function fetchEmitterSnapshot(signal?: AbortSignal): Promise<EmitterSnapshot> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/emitter.json`, {
    signal,
    cache: "no-cache",
    credentials: import.meta.env.VITE_ACTIVITY_AUTH === "entra" ? "same-origin" : "omit",
    ...(import.meta.env.VITE_ACTIVITY_AUTH === "entra" ? { redirect: "error" as const } : {}),
  });
  if (response.status === 404) {
    throw new Error(
      "Emitter snapshot not found (404). Select Refresh data, then choose Run workflow in GitHub Actions to initialize it.",
    );
  }
  if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isEmitterSnapshot(value)) throw new Error("Snapshot uses an unsupported emitter data contract");
  return value;
}

export function useEmitterData(): EmitterDataState {
  return useSnapshot(fetchEmitterSnapshot);
}
