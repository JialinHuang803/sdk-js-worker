import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthorizationCodeRequest, AuthorizationUrlRequest } from "@azure/msal-node";
import { ActivityError } from "../engine";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = "__Host-activity_session";
const STATE_COOKIE = "__Host-activity_oauth";
const STATE_TTL = 10 * 60_000;
const SESSION_TTL = 60 * 60_000;
const MAX_ENTRIES = 1_000;
const scopes = ["openid", "profile"];

export interface AzureAuthConfig {
  mode: "entra-federated";
  tenantId: string;
  clientId: string;
  managedIdentityClientId: string;
  accessPolicy: "allowlist" | "tenant-members";
  allowedObjectIds: string[];
  origin: string;
}

export interface EntraClient {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
  acquireTokenByCode(request: AuthorizationCodeRequest): Promise<{ idTokenClaims: unknown }>;
}

export function readAzureAuthConfig(env: NodeJS.ProcessEnv): AzureAuthConfig {
  if (env.ACTIVITY_AUTH_MODE !== "entra-federated") {
    throw new Error("ACTIVITY_AUTH_MODE must explicitly enable entra-federated.");
  }
  const tenantId = env.ACTIVITY_ENTRA_TENANT_ID ?? "";
  const clientId = env.ACTIVITY_ENTRA_CLIENT_ID ?? "";
  const managedIdentityClientId = env.ACTIVITY_ENTRA_MANAGED_IDENTITY_CLIENT_ID ?? "";
  const accessPolicy = env.ACTIVITY_ENTRA_ACCESS_POLICY ?? "allowlist";
  if (accessPolicy !== "allowlist" && accessPolicy !== "tenant-members") {
    throw new Error("ACTIVITY_ENTRA_ACCESS_POLICY must be allowlist or tenant-members.");
  }
  const configuredIds = env.ACTIVITY_ALLOWED_OBJECT_IDS?.trim();
  const allowedObjectIds = configuredIds ? configuredIds.split(",").map((id) => id.trim().toLowerCase()) : [];
  if (![tenantId, clientId, managedIdentityClientId].every((id) => uuid.test(id)) ||
    allowedObjectIds.some((id) => !uuid.test(id)) ||
    (accessPolicy === "allowlist" ? !allowedObjectIds.length : allowedObjectIds.length > 0)) {
    throw new Error("Valid Entra IDs are required. Configure object IDs for allowlist access, or omit them for tenant-members access.");
  }
  const origin = env.ACTIVITY_ORIGIN ?? "";
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    throw new Error("ACTIVITY_ORIGIN must be an exact HTTPS origin without a trailing slash.");
  }
  return { mode: "entra-federated", tenantId: tenantId.toLowerCase(), clientId: clientId.toLowerCase(),
    managedIdentityClientId, accessPolicy, allowedObjectIds, origin };
}

const randomToken = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
function matches(value: unknown, expected: string): boolean {
  return typeof value === "string" && tokenPattern.test(value) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 16_384) return undefined;
  const values = header.split(";").map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf("=")) === name);
  const value = values.length === 1 ? values[0].slice(name.length + 1) : undefined;
  return value && tokenPattern.test(value) ? value : undefined;
}
function cookie(name: string, value: string, milliseconds: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(milliseconds / 1000))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Authentication timed out.")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
interface Pending {
  state: string; browserToken: string; verifier: string; nonce: string; expiresAt: number;
}
interface Session {
  id: string; objectId: string; tenantMember: boolean; login: string; displayName?: string; csrfToken: string; expiresAt: number;
}

export function createEntraAuth(config: AzureAuthConfig, client: EntraClient) {
  if (config.mode !== "entra-federated") throw new Error("Federated Entra authentication must be explicitly enabled.");
  const callbackUrl = `${config.origin}/api/auth/callback`;
  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Session>();
  const authorized = (objectId: string, tenantMember: boolean) =>
    config.accessPolicy === "tenant-members" ? tenantMember : config.allowedObjectIds.includes(objectId);
  const prune = <T extends { expiresAt: number }>(entries: Map<string, T>) => {
    for (const [key, value] of entries) if (value.expiresAt <= Date.now()) entries.delete(key);
  };
  const findSession = (header: string | undefined) => {
    prune(sessions);
    const id = readCookie(header, SESSION_COOKIE);
    const session = id ? sessions.get(digest(id)) : undefined;
    return session && matches(id, session.id) && authorized(session.objectId, session.tenantMember) ? session : undefined;
  };
  const requireSession = (header: string | undefined) => {
    const session = findSession(header);
    if (!session) throw new ActivityError(401, "Microsoft Entra sign-in is required.");
    return session;
  };
  const requireMutation = (headers: IncomingHttpHeaders) => {
    const session = requireSession(headers.cookie);
    if (headers.origin !== config.origin || !matches(headers["x-csrf-token"], session.csrfToken)) {
      throw new ActivityError(403, "An exact same-origin request with the session CSRF token is required.");
    }
    if (headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new ActivityError(415, "Use application/json.");
    }
    return session;
  };
  return {
    async start() {
      prune(pending);
      if (pending.size >= MAX_ENTRIES) throw new ActivityError(503, "Too many pending sign-ins.");
      const entry: Pending = { state: randomToken(), browserToken: randomToken(), verifier: randomToken(),
        nonce: randomToken(), expiresAt: Date.now() + STATE_TTL };
      pending.set(digest(entry.state), entry);
      try {
        const location = await bounded(client.getAuthCodeUrl({
          scopes, redirectUri: callbackUrl, responseMode: "query", state: entry.state, nonce: entry.nonce,
          codeChallenge: digest(entry.verifier), codeChallengeMethod: "S256", prompt: "select_account",
        }));
        return { location, cookies: [cookie(STATE_COOKIE, entry.browserToken, STATE_TTL)] };
      } catch {
        pending.delete(digest(entry.state));
        throw new ActivityError(503, "Microsoft Entra sign-in is unavailable.");
      }
    },
    async callback(url: URL, header: string | undefined) {
      prune(pending);
      const state = url.searchParams.get("state");
      const entry = state && tokenPattern.test(state) ? pending.get(digest(state)) : undefined;
      if (url.origin !== config.origin || url.pathname !== "/api/auth/callback" || url.hash ||
        url.searchParams.getAll("state").length !== 1 || !entry || !matches(state, entry.state) ||
        !matches(readCookie(header, STATE_COOKIE), entry.browserToken)) {
        throw new ActivityError(400, "Invalid or expired sign-in state.");
      }
      pending.delete(digest(entry.state));
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 ||
        !code || code.length > 8_192 || /[^\x21-\x7e]/.test(code)) {
        throw new ActivityError(400, "Microsoft Entra sign-in was not completed.");
      }
      let claims: unknown;
      try {
        claims = (await bounded(client.acquireTokenByCode({
          scopes, redirectUri: callbackUrl, code, codeVerifier: entry.verifier, nonce: entry.nonce,
        }))).idTokenClaims;
      } catch { throw new ActivityError(503, "Microsoft Entra code exchange is unavailable."); }
      const now = Date.now();
      if (!claims || typeof claims !== "object") throw new ActivityError(401, "Invalid Microsoft Entra identity.");
      const identity = claims as Record<string, unknown>;
      if (identity.tid !== config.tenantId || identity.aud !== config.clientId ||
        identity.iss !== `https://login.microsoftonline.com/${config.tenantId}/v2.0` ||
        typeof identity.oid !== "string" || !uuid.test(identity.oid) || !matches(identity.nonce, entry.nonce) ||
        typeof identity.exp !== "number" || !Number.isSafeInteger(identity.exp) || identity.exp * 1000 <= now ||
        typeof identity.iat !== "number" || !Number.isSafeInteger(identity.iat) || identity.iat * 1000 > now + 60_000 ||
        (identity.nbf !== undefined && (typeof identity.nbf !== "number" ||
          !Number.isSafeInteger(identity.nbf) || identity.nbf * 1000 > now + 60_000))) {
        throw new ActivityError(401, "Invalid Microsoft Entra identity.");
      }
      const objectId = identity.oid.toLowerCase();
      const tenantMember = identity.acct === 0 || identity.acct === "0";
      if (!authorized(objectId, tenantMember)) {
        throw new ActivityError(403, config.accessPolicy === "tenant-members"
          ? "A confirmed member account in this Microsoft Entra tenant is required."
          : "This Microsoft Entra user is not authorized.");
      }
      if (entry.expiresAt <= now) throw new ActivityError(400, "Invalid or expired sign-in state.");
      prune(sessions);
      const previous = findSession(header);
      if (!previous && sessions.size >= MAX_ENTRIES) throw new ActivityError(503, "Too many active sessions.");
      if (previous) sessions.delete(digest(previous.id));
      const displayName = typeof identity.name === "string" && identity.name.trim() ? identity.name : undefined;
      const session: Session = { id: randomToken(), objectId, tenantMember, displayName,
        login: displayName ?? objectId,
        csrfToken: randomToken(), expiresAt: Math.min(now + SESSION_TTL, identity.exp * 1000) };
      sessions.set(digest(session.id), session);
      return { location: `${config.origin}/`, cookies: [
        cookie(SESSION_COOKIE, session.id, session.expiresAt - now), cookie(STATE_COOKIE, "", 0),
      ] };
    },
    requireSession,
    requireMutation,
    session(header: string | undefined) {
      const session = requireSession(header);
      return { authenticated: true, login: session.login, csrfToken: session.csrfToken };
    },
    logout(headers: IncomingHttpHeaders) {
      const session = requireMutation(headers);
      sessions.delete(digest(session.id));
      return [cookie(SESSION_COOKIE, "", 0), cookie(STATE_COOKIE, "", 0)];
    },
  };
}
