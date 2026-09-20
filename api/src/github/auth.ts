import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ActivityError } from "../engine";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  dashboardUrl: string;
  allowedUsers: string[];
  secureCookies: boolean;
}

const SESSION_TTL = 8 * 60 * 60 * 1_000;
const STATE_TTL = 10 * 60 * 1_000;
const MAX_ENTRIES = 1_000;
const SESSION_COOKIE = "activity_session";
const STATE_COOKIE = "activity_oauth";
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}(?![\s\S])/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface Pending {
  state: string;
  browserToken: string;
  verifier: string;
  expiresAt: number;
}

interface Session {
  id: string;
  login: string;
  csrfToken: string;
  expiresAt: number;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function equalToken(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual.length === 43 && TOKEN_PATTERN.test(actual) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 16_384) return undefined;
  const values = header.split(";").map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf("=")) === name);
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return value.length === 43 && TOKEN_PATTERN.test(value) ? value : undefined;
}

function trustedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid authentication URL configuration."); }
  if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Authentication URLs must use HTTPS or loopback HTTP without credentials or fragments.");
  }
  return url;
}

export function createAuth(config: AuthConfig, fetcher: typeof fetch = fetch) {
  const callbackUrl = trustedUrl(config.callbackUrl);
  const dashboardUrl = trustedUrl(config.dashboardUrl);
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  const allowedUsers = new Set(config.allowedUsers.map((login) => login.trim().toLowerCase()));
  if (!clientId.trim() || !clientSecret.trim() || !allowedUsers.size ||
      [...allowedUsers].some((login) => !LOGIN_PATTERN.test(login)) ||
      callbackUrl.origin !== dashboardUrl.origin || callbackUrl.search ||
      !callbackUrl.pathname.startsWith("/api/") ||
      config.secureCookies !== (callbackUrl.protocol === "https:")) {
    throw new Error("Invalid authentication configuration.");
  }
  const cookieSuffix = `; Path=/api; HttpOnly; SameSite=Lax${config.secureCookies ? "; Secure" : ""}`;
  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Session>();

  function cookie(name: string, value: string, ttl: number): string {
    return `${name}=${value}; Max-Age=${ttl / 1_000}${cookieSuffix}`;
  }

  function prune<T extends { expiresAt: number }>(entries: Map<string, T>): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function findSession(cookieHeader: string | undefined): Session | undefined {
    prune(sessions);
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (!id) return undefined;
    const session = sessions.get(digest(id));
    return session && equalToken(id, session.id) ? session : undefined;
  }

  async function githubJson(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetcher(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Upstream authentication failed.");
      return await response.json();
    } catch {
      throw new ActivityError(503, "GitHub authentication is unavailable.");
    }
  }

  function requireMutation(cookieHeader: string | undefined, csrfToken: string | undefined): string {
    const session = findSession(cookieHeader);
    if (!session) throw new ActivityError(401, "Authentication required.");
    if (!equalToken(csrfToken, session.csrfToken)) throw new ActivityError(403, "Invalid CSRF token.");
    return session.login;
  }

  return {
    start(): { location: string; cookie: string } {
      prune(pending);
      if (pending.size >= MAX_ENTRIES) throw new ActivityError(503, "Too many pending sign-ins.");
      const entry: Pending = {
        state: randomToken(), browserToken: randomToken(), verifier: randomToken(),
        expiresAt: Date.now() + STATE_TTL,
      };
      pending.set(digest(entry.state), entry);
      const location = new URL("https://github.com/login/oauth/authorize");
      location.search = new URLSearchParams({
        client_id: clientId, redirect_uri: callbackUrl.href, state: entry.state,
        code_challenge: digest(entry.verifier), code_challenge_method: "S256",
      }).toString();
      return { location: location.href, cookie: cookie(STATE_COOKIE, entry.browserToken, STATE_TTL) };
    },

    async callback(url: URL, cookieHeader: string | undefined): Promise<{ location: string; cookie: string }> {
      prune(pending);
      const state = url.searchParams.get("state");
      const browserToken = readCookie(cookieHeader, STATE_COOKIE);
      const entry = state && TOKEN_PATTERN.test(state) ? pending.get(digest(state)) : undefined;
      if (url.origin !== callbackUrl.origin || url.pathname !== callbackUrl.pathname ||
          url.username || url.password || url.hash || url.searchParams.getAll("state").length !== 1 ||
          !entry || !equalToken(state ?? undefined, entry.state) ||
          !equalToken(browserToken, entry.browserToken)) {
        throw new ActivityError(400, "Invalid or expired OAuth state.");
      }
      // Consume before any asynchronous work so concurrent callbacks cannot reuse this state.
      pending.delete(digest(entry.state));
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 ||
          !code || code.length > 1_024 || /[^\x21-\x7e]/.test(code)) {
        throw new ActivityError(400, "GitHub sign-in was not completed.");
      }
      const token: unknown = await githubJson("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl.href,
          code_verifier: entry.verifier,
        }).toString(),
      });
      if (!token || typeof token !== "object" || "error" in token ||
          !("access_token" in token) || typeof token.access_token !== "string" ||
          !token.access_token || token.access_token.length > 4_096 || /[^\x21-\x7e]/.test(token.access_token) ||
          !("token_type" in token) || typeof token.token_type !== "string" ||
          token.token_type.toLowerCase() !== "bearer") {
        throw new ActivityError(503, "GitHub returned an invalid authentication response.");
      }
      const user: unknown = await githubJson("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sdk-js-worker-activity",
        },
      });
      if (!user || typeof user !== "object" || !("login" in user) || typeof user.login !== "string" ||
          !LOGIN_PATTERN.test(user.login.toLowerCase()) || !("id" in user) ||
          typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
        throw new ActivityError(503, "GitHub returned an invalid user identity.");
      }
      const login = user.login.toLowerCase();
      if (!allowedUsers.has(login)) throw new ActivityError(403, "This GitHub account is not authorized.");
      // A request begun before expiration must also finish within the state lifetime.
      if (entry.expiresAt <= Date.now()) throw new ActivityError(400, "Invalid or expired OAuth state.");
      prune(sessions);
      const previous = findSession(cookieHeader);
      if (!previous && sessions.size >= MAX_ENTRIES) throw new ActivityError(503, "Too many active sessions.");
      if (previous) sessions.delete(digest(previous.id));
      const session: Session = {
        id: randomToken(), login, csrfToken: randomToken(), expiresAt: Date.now() + SESSION_TTL,
      };
      sessions.set(digest(session.id), session);
      return { location: dashboardUrl.href, cookie: cookie(SESSION_COOKIE, session.id, SESSION_TTL) };
    },

    session(cookieHeader: string | undefined): { authenticated: boolean; login: string | null; csrfToken: string | null } {
      const session = findSession(cookieHeader);
      return session
        ? { authenticated: true, login: session.login, csrfToken: session.csrfToken }
        : { authenticated: false, login: null, csrfToken: null };
    },

    requireMutation,

    logout(cookieHeader: string | undefined, csrfToken: string | undefined): string {
      requireMutation(cookieHeader, csrfToken);
      const id = readCookie(cookieHeader, SESSION_COOKIE);
      if (id) sessions.delete(digest(id));
      return cookie(SESSION_COOKIE, "", 0);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
