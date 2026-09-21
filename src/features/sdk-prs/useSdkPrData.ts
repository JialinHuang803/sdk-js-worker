import {
  isDashboardSnapshot,
  type DashboardSnapshot,
} from "../../data/contracts";
import { useSnapshot, type SnapshotState } from "../../shared/useSnapshot";

export async function fetchSdkPrSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/sdk-prs.json`, {
    signal, cache: "no-cache",
    ...(import.meta.env.VITE_ACTIVITY_AUTH === "entra" ? { credentials: "same-origin", redirect: "error" } : {}),
  });
  if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isDashboardSnapshot(value)) throw new Error("Snapshot uses an unsupported data contract");
  return value;
}

export function useSdkPrData(): SnapshotState<DashboardSnapshot> {
  return useSnapshot(fetchSdkPrSnapshot);
}
