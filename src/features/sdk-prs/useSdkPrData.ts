import { useEffect, useState } from "react";
import {
  isDashboardSnapshot,
  type DashboardSnapshot,
} from "../../data/contracts";

interface DataState {
  snapshot: DashboardSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function useSdkPrData(): DataState {
  const [state, setState] = useState<DataState>({
    snapshot: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const url = `${import.meta.env.BASE_URL}data/sdk-prs.json`;
    fetch(url, { signal: controller.signal, cache: "no-cache",
      ...(import.meta.env.VITE_ACTIVITY_AUTH === "entra" ? { credentials: "same-origin", redirect: "error" } : {}) })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Snapshot request failed (${response.status})`);
        }
        const value: unknown = await response.json();
        if (!isDashboardSnapshot(value)) {
          throw new Error("Snapshot uses an unsupported data contract");
        }
        setState({ snapshot: value, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          snapshot: null,
          loading: false,
          error: error instanceof Error ? error.message : "Unknown data error",
        });
      });
    return () => controller.abort();
  }, []);

  return state;
}
