import { useEffect, useState } from "react";
import {
  isEmitterActivityFeed, type EmitterActivityFeed,
  type EmitterActivityAcknowledgeRequest, type EmitterActivityRestoreRequest,
} from "../../data/emitter-activity-contracts";
import { fetchActivityResponse } from "../sdk-prs/sharedActivity";

export type EmitterAcknowledgeRequest = EmitterActivityAcknowledgeRequest;
export type EmitterRestoreRequest = EmitterActivityRestoreRequest;
export interface EmitterActivityState {
  feed: EmitterActivityFeed | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  configured: boolean;
  canWrite: boolean;
}
export interface EmitterActivityActions {
  retry: () => void;
  acknowledge: (request: EmitterAcknowledgeRequest) => void;
  restore: (request: EmitterRestoreRequest) => void;
}
export const unavailableEmitterActivity: EmitterActivityState = {
  feed: null, loading: false, pending: false, error: null, configured: false, canWrite: false,
};

export function parseEmitterFeed(value: unknown): EmitterActivityFeed {
  if (!isEmitterActivityFeed(value)) throw new Error("Invalid emitter activity response. Retry loading before making changes.");
  return value;
}

export function parseEmitterMutation(value: unknown): EmitterActivityFeed {
  if (typeof value !== "object" || value === null || !("feed" in value) ||
    !("acknowledgementId" in value) ||
    !(value.acknowledgementId === null ||
      (typeof value.acknowledgementId === "string" && value.acknowledgementId.trim()))) {
    throw new Error("Invalid emitter activity update. Retry loading before making changes.");
  }
  return parseEmitterFeed(value.feed);
}

// Kept independent of React so request ordering and uncertain writes are testable.
export function createEmitterActivityClient(
  baseUrl: string | undefined,
  publish: (state: EmitterActivityState) => void,
) {
  const endpoint = baseUrl?.replace(/\/+$/, "");
  let state: EmitterActivityState = { ...unavailableEmitterActivity, configured: Boolean(endpoint) };
  let disposed = false;
  let version = 0;
  let controller: AbortController | undefined;
  const retiredGenerations = new Set<string>();
  const update = (patch: Partial<EmitterActivityState>) => {
    state = { ...state, ...patch };
    if (!disposed) publish(state);
  };
  function accept(next: EmitterActivityFeed, mutationGeneration?: string) {
    const previous = state.feed;
    if (retiredGenerations.has(next.generation) ||
      (previous?.generation === next.generation && next.revision < previous.revision) ||
      (mutationGeneration !== undefined && next.generation !== mutationGeneration)) {
      throw new Error("The emitter activity service returned an older or changed feed. Retry loading to reconnect.");
    }
    if (previous && previous.generation !== next.generation) retiredGenerations.add(previous.generation);
    update({ feed: next, error: null, canWrite: next.collectedAt !== null });
  }
  async function request(action?: "ack" | "restore", body?: EmitterAcknowledgeRequest | EmitterRestoreRequest) {
    if (!endpoint || disposed || state.pending ||
      (action && (!state.canWrite || body?.generation !== state.feed?.generation))) return;
    const requestVersion = ++version;
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    update({ loading: !action, pending: Boolean(action), canWrite: false });
    try {
      const value = await fetchActivityResponse(`${endpoint}/emitter-activity${action ? `/${action}` : ""}`, {
        cache: "no-store", credentials: "omit",
        ...(action ? {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        } : {}),
      }, currentController.signal);
      if (disposed || requestVersion !== version || currentController.signal.aborted) return;
      accept(action ? parseEmitterMutation(value) : parseEmitterFeed(value), action ? body?.generation : undefined);
    } catch (cause) {
      if (disposed || requestVersion !== version || currentController.signal.aborted) return;
      const detail = cause instanceof Error ? cause.message : "Unable to load emitter activity.";
      update({ error: action
        ? `${detail} The action may not have been saved. Retry loading before another action.`
        : detail, canWrite: false });
    } finally {
      if (!disposed && requestVersion === version) update({ loading: false, pending: false });
    }
  }
  return {
    refresh: () => request(),
    acknowledge: (body: EmitterAcknowledgeRequest) => request("ack", body),
    restore: (body: EmitterRestoreRequest) => request("restore", body),
    dispose: () => { disposed = true; ++version; controller?.abort(); },
  };
}

export function useEmitterActivity(baseUrl: string | undefined): EmitterActivityState & EmitterActivityActions {
  const [state, setState] = useState<EmitterActivityState>({
    ...unavailableEmitterActivity, configured: Boolean(baseUrl), loading: Boolean(baseUrl),
  });
  const [client, setClient] = useState<ReturnType<typeof createEmitterActivityClient> | null>(null);
  useEffect(() => {
    setState({ ...unavailableEmitterActivity, configured: Boolean(baseUrl), loading: Boolean(baseUrl) });
    const next = createEmitterActivityClient(baseUrl, setState);
    setClient(next);
    void next.refresh();
    const timer = window.setInterval(() => void next.refresh(), 60_000);
    const onFocus = () => { void next.refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      next.dispose();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [baseUrl]);
  return {
    ...state,
    retry: () => { void client?.refresh(); },
    acknowledge: (request) => { void client?.acknowledge(request); },
    restore: (request) => { void client?.restore(request); },
  };
}
