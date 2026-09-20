import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityResponseError, fetchActivityResponse } from "../features/sdk-prs/sharedActivity";

export interface ActivitySession {
  authenticated: boolean;
  login: string | null;
  csrfToken: string | null;
}
export interface ActivityAuthState {
  session: ActivitySession | null;
  loading: boolean;
  error: string | null;
}
export interface ActivityAuthTransport {
  options: (mutation?: boolean) => RequestInit;
  failed: (cause: unknown) => void;
}
const initialState: ActivityAuthState = { session: null, loading: true, error: null };
export const publicActivityTransport: ActivityAuthTransport = {
  options: () => ({ credentials: "omit" }),
  failed: () => {},
};
export function canChangeActivity(state: ActivityAuthState): boolean {
  return !state.loading && !state.error && state.session?.authenticated === true &&
    Boolean(state.session.csrfToken);
}
export function parseActivitySession(value: unknown): ActivitySession {
  if (typeof value !== "object" || value === null || !("authenticated" in value) ||
    !("login" in value) || !("csrfToken" in value) ||
    !(value.authenticated === true
      ? typeof value.login === "string" && Boolean(value.login.trim()) &&
        typeof value.csrfToken === "string" && Boolean(value.csrfToken.trim())
      : value.authenticated === false && value.login === null && value.csrfToken === null)) {
    throw new Error("Invalid sign-in session response. Retry checking sign-in.");
  }
  return value as ActivitySession;
}

export function createActivityAuthClient(
  baseUrl: string | undefined,
  publish: (state: ActivityAuthState) => void,
  provider: "github" | "entra" = "github",
) {
  const endpoint = baseUrl?.trim().replace(/\/+$/, "");
  const label = provider === "entra" ? "Microsoft Entra" : "GitHub";
  let state = initialState;
  let disposed = false;
  let version = 0;
  let controller: AbortController | undefined;
  let signingOut = false;
  const update = (next: ActivityAuthState) => {
    state = next;
    if (!disposed) publish(state);
  };
  const options = (mutation = false): RequestInit => {
    if (mutation && (disposed || !canChangeActivity(state))) {
      throw new Error(`Sign in with ${label} and successfully check your session before changing shared read state.`);
    }
    return { credentials: "same-origin", ...(provider === "entra" ? { redirect: "error" } : {}),
      ...(mutation ? { headers: { "x-csrf-token": state.session!.csrfToken! } } : {}) };
  };
  const failed = (cause: unknown) => {
    if (disposed || !(cause instanceof ActivityResponseError) || ![401, 403].includes(cause.status)) return;
    ++version;
    controller?.abort();
    signingOut = false;
    update({ session: null, loading: false, error: `Your ${label} session expired or permission was denied. Sign in again or retry checking sign-in. Shared read changes are disabled.` });
  };
  async function request(logout = false) {
    if (disposed || signingOut || (!logout && state.loading && controller)) return;
    let requestOptions: RequestInit;
    try { requestOptions = options(logout); } catch (cause) {
      update({ session: null, loading: false, error: (cause as Error).message });
      return;
    }
    const currentVersion = ++version;
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    signingOut = logout;
    update({ ...state, loading: true, error: null });
    try {
      if (!endpoint || (provider === "entra" && endpoint !== "/api")) {
        throw new Error(`Configure VITE_ACTIVITY_API_URL=/api to connect ${label} sign-in.`);
      }
      const result = await fetchActivityResponse(`${endpoint}/auth/${logout ? "logout" : "session"}`, {
        ...requestOptions, cache: "no-store", method: logout ? "POST" : "GET",
        ...(provider === "entra" && logout ? {
          headers: { ...requestOptions.headers, "Content-Type": "application/json" }, body: "{}",
        } : {}),
      }, currentController.signal);
      const session = parseActivitySession(result);
      if (logout && session.authenticated) throw new Error("Sign out was not confirmed. Retry checking sign-in.");
      if (!disposed && currentVersion === version) update({ session, loading: false, error: null });
    } catch (cause) {
      if (disposed || currentVersion !== version || currentController.signal.aborted) return;
      update({ session: null, loading: false, error: `${logout ? "Unable to confirm sign out." : `Unable to check ${label} sign-in.`} ${cause instanceof Error ? cause.message : "Service unavailable."} Retry checking sign-in.` });
    } finally {
      if (currentVersion === version) { signingOut = false; controller = undefined; }
    }
  }
  return {
    options, failed,
    refresh: () => request(),
    logout: () => request(true),
    dispose: () => { disposed = true; ++version; controller?.abort(); },
  };
}

const configuredProvider = import.meta.env.VITE_ACTIVITY_AUTH === "entra" ? "entra" : "github";
const authEnabled = ["github", "entra"].includes(import.meta.env.VITE_ACTIVITY_AUTH);
const unavailableTransport: ActivityAuthTransport = {
  options: (mutation) => {
    if (mutation) throw new Error("Sign-in is not ready.");
    return { credentials: "same-origin" };
  },
  failed: () => {},
};
interface ActivityAuthContextValue {
  enabled: boolean;
  provider?: "github" | "entra";
  state: ActivityAuthState;
  transport: ActivityAuthTransport;
  loginUrl: string | null;
  refresh: () => void;
  logout: () => void;
}
export const ActivityAuthContext = createContext<ActivityAuthContextValue>({
  enabled: authEnabled, provider: configuredProvider, state: initialState,
  transport: authEnabled ? unavailableTransport : publicActivityTransport,
  loginUrl: null, refresh: () => {}, logout: () => {},
});
export const useActivityAuth = () => useContext(ActivityAuthContext);

export function ActivityAuthProvider({ children, enabled = authEnabled, baseUrl = import.meta.env.VITE_ACTIVITY_API_URL,
  provider = configuredProvider }: {
  children: ReactNode; enabled?: boolean; baseUrl?: string; provider?: "github" | "entra";
}) {
  const [state, setState] = useState(initialState);
  const client = useRef<ReturnType<typeof createActivityAuthClient> | null>(null);
  const transport = useMemo<ActivityAuthTransport>(() => enabled ? {
    options: (mutation) => (client.current ?? unavailableTransport).options(mutation),
    failed: (cause) => client.current?.failed(cause),
  } : publicActivityTransport, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    setState(initialState);
    const next = createActivityAuthClient(baseUrl, setState, provider);
    client.current = next;
    void next.refresh();
    const timer = window.setInterval(() => void next.refresh(), 60_000);
    const onFocus = () => { void next.refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      next.dispose();
      client.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, baseUrl, provider]);
  const endpoint = baseUrl?.trim().replace(/\/+$/, "");
  return <ActivityAuthContext.Provider value={{
    enabled, provider, state, transport,
    loginUrl: endpoint ? `${endpoint}/auth/login` : null,
    refresh: () => { void client.current?.refresh(); },
    logout: () => { void client.current?.logout(); },
  }}>{children}</ActivityAuthContext.Provider>;
}

export function ActivityAuthControls() {
  const auth = useActivityAuth();
  if (!auth.enabled) return null;
  const label = auth.provider === "entra" ? "Microsoft Entra" : "GitHub";
  return <section className="activity-auth" aria-label="Shared inbox sign-in">
    <p>{auth.provider === "entra"
      ? "Only assigned Microsoft Entra users can view this dashboard and change shared read state."
      : "Anyone can view both inboxes. Sign in with GitHub to mark or restore shared read state for everyone."}
      {" "}Attention signals are independent of read state.</p>
    {auth.state.loading && <p role="status">Checking {label} sign-in… Shared read changes are disabled.</p>}
    {auth.state.error && <p role="alert">{auth.state.error} Shared read changes are disabled.</p>}
    {!auth.state.loading && !auth.state.error && <p role="status">{canChangeActivity(auth.state)
      ? `Signed in as ${auth.state.session!.login}. Shared read changes are enabled when the activity service is ready.`
      : "Not signed in. Shared read changes are disabled."}</p>}
    <div className="activity-auth__actions">
      {auth.loginUrl && <a className="button-secondary" href={auth.loginUrl}>Sign in with {label}</a>}
      {canChangeActivity(auth.state) && <button type="button" className="button-secondary" onClick={auth.logout}>Sign out</button>}
      <button type="button" className="button-secondary" disabled={auth.state.loading} onClick={auth.refresh}>Retry checking sign-in</button>
    </div>
  </section>;
}
