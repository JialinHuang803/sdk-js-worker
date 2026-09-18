import { useEffect, useState } from "react";
import { isEmitterSnapshot, type EmitterSnapshot } from "../../data/emitter-contracts";

export interface EmitterDataState {
  snapshot: EmitterSnapshot | null;
  loading: boolean;
  error: string | null;
}

export async function fetchEmitterSnapshot(signal?: AbortSignal): Promise<EmitterSnapshot> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/emitter.json`, {
    signal,
    cache: "no-cache",
    credentials: "omit",
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
  const [state, setState] = useState<EmitterDataState>({
    snapshot: null, loading: true, error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    fetchEmitterSnapshot(controller.signal).then((snapshot) => {
      if (!controller.signal.aborted) setState({ snapshot, loading: false, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        snapshot: null,
        loading: false,
        error: error instanceof Error ? error.message : "Unknown emitter data error",
      });
    });
    return () => controller.abort();
  }, []);
  return state;
}
