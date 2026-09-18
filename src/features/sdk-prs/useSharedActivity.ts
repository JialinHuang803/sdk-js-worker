import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActivityAcknowledgeRequest,
  ActivityRestoreRequest,
  SharedActivityFeed,
} from "../../data/activity-contracts";
import { fetchActivityResponse, parseActivityFeed, parseActivityMutation } from "./sharedActivity";

export interface SharedActivityState {
  feed: SharedActivityFeed | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  retry: () => void;
  acknowledge: (request: ActivityAcknowledgeRequest) => void;
  restore: (request: ActivityRestoreRequest) => void;
}

export function useSharedActivity(baseUrl: string | undefined): SharedActivityState {
  const [feed, setFeed] = useState<SharedActivityFeed | null>(null);
  const [loading, setLoading] = useState(Boolean(baseUrl));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const version = useRef(0);
  const busy = useRef(false);
  const available = useRef(false);
  const getController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const endpoint = baseUrl?.replace(/\/+$/, "");
  const acceptFeed = useCallback((next: SharedActivityFeed) => {
    setFeed((current) => current?.generation === next.generation && current.revision > next.revision ? current : next);
  }, []);

  const refresh = useCallback(async () => {
    if (!endpoint || !active.current || busy.current) return;
    const requestVersion = ++version.current;
    getController.current?.abort();
    const controller = new AbortController();
    getController.current = controller;
    available.current = false;
    setLoading(true);
    try {
      const response = await fetchActivityResponse(`${endpoint}/activity`, {
        cache: "no-store", credentials: "omit",
      }, controller.signal);
      const next = parseActivityFeed(response);
      if (!active.current || controller.signal.aborted || requestVersion !== version.current) return;
      acceptFeed(next);
      available.current = next.collectedAt !== null;
      setError(null);
    } catch (cause) {
      if (!active.current || controller.signal.aborted || requestVersion !== version.current) return;
      setError(cause instanceof Error ? cause.message : "Unable to load shared activities. Retry to reconnect.");
    } finally {
      if (active.current && requestVersion === version.current) setLoading(false);
    }
  }, [endpoint, acceptFeed]);

  useEffect(() => {
    if (!endpoint) {
      setLoading(false);
      return;
    }
    active.current = true;
    setFeed(null);
    setError(null);
    setPending(false);
    busy.current = false;
    available.current = false;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      active.current = false;
      ++version.current;
      getController.current?.abort();
      mutationController.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, endpoint]);

  const mutate = useCallback(async (
    action: "ack" | "restore",
    request: ActivityAcknowledgeRequest | ActivityRestoreRequest,
  ) => {
    if (!endpoint || !active.current || busy.current || !available.current) return;
    busy.current = true;
    available.current = false;
    const requestVersion = ++version.current;
    getController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    setPending(true);
    setLoading(false);
    try {
      const response = await fetchActivityResponse(`${endpoint}/activity/${action}`, {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }, controller.signal);
      const result = parseActivityMutation(response);
      if (!active.current || controller.signal.aborted || requestVersion !== version.current) return;
      acceptFeed(result.feed);
      available.current = result.feed.collectedAt !== null;
      setError(null);
    } catch (cause) {
      if (!active.current || controller.signal.aborted || requestVersion !== version.current) return;
      const detail = cause instanceof Error ? cause.message : "Unable to save shared read state.";
      setError(`${detail} The action may not have been saved. Retry loading before another action.`);
    } finally {
      if (active.current && requestVersion === version.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [endpoint, acceptFeed]);

  return {
    feed, loading, pending, error,
    retry: () => { void refresh(); },
    acknowledge: (request) => { void mutate("ack", request); },
    restore: (request) => { void mutate("restore", request); },
  };
}
