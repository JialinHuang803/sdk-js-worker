import { useEffect, useState } from "react";

export interface SnapshotState<T> {
  snapshot: T | null;
  loading: boolean;
  error: string | null;
}

export function createSnapshotLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  update: (state: SnapshotState<T>) => void,
) {
  const controller = new AbortController();
  let pending = false;
  return {
    async refresh() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const snapshot = await load(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
        if (!controller.signal.aborted) update({ snapshot, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) update({
          snapshot: null, loading: false,
          error: error instanceof Error ? error.message : "Snapshot data is unavailable.",
        });
      } finally {
        pending = false;
      }
    },
    dispose() { controller.abort(); },
  };
}

export function useSnapshot<T>(load: (signal: AbortSignal) => Promise<T>): SnapshotState<T> {
  const [state, setState] = useState<SnapshotState<T>>({ snapshot: null, loading: true, error: null });
  useEffect(() => {
    const loader = createSnapshotLoader(load, setState);
    void loader.refresh();
    if (import.meta.env.VITE_ACTIVITY_AUTH !== "entra") return () => loader.dispose();
    const timer = window.setInterval(() => void loader.refresh(), 60_000);
    const onFocus = () => void loader.refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      loader.dispose();
    };
  }, [load]);
  return state;
}
