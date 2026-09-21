import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthorizationCodeRequest, AuthorizationUrlRequest } from "@azure/msal-node";
import { ActivityError } from "../engine";
import { InvalidSessionRecord, type SessionStore, type StoredRecord, type RecordPurpose } from "./session-store";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = "__Host-activity_session";
const STATE_COOKIE = "__Host-activity_oauth";
const STATE_TTL = 10 * 60_000;
const SESSION_TTL = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 1_000;
const MAX_LOGIN_STARTS_PER_MINUTE = 100;
const MAX_CONCURRENT_LOGIN_STARTS = 20;
const ISSUANCE_BACKDATE_ALLOWANCE = 6 * 60_000;
const scopes = ["openid", "profile", "offline_access"];

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
  acquireTokenByCode(request: AuthorizationCodeRequest): Promise<EntraTokens>;
  renew(cache: string, accountId: string): Promise<EntraTokens>;
}
export interface EntraTokens { idTokenClaims: unknown; cache: string; accountId: string }
export class InteractiveSignInRequired extends Error {
  constructor() { super("Microsoft Entra sign-in is required."); }
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
  return typeof value === "string" && tokenPattern.test(value) && typeof expected === "string" && tokenPattern.test(expected) &&
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
  version: 1; state: string; browserToken: string; verifier: string; nonce: string; createdAt: number; expiresAt: number;
}
interface Session {
  version: 1; id: string; objectId: string; tenantMember: boolean; login: string; displayName?: string;
  csrfToken: string; createdAt: number; expiresAt: number; verifiedAt: number; renewAt: number;
  tenantId: string; clientId: string; issuedAt: number;
  cache: string; accountId: string; refresh?: { owner: string; until: number };
}

export function createEntraAuth(config: AzureAuthConfig, client: EntraClient, store: SessionStore) {
  if (config.mode !== "entra-federated") throw new Error("Federated Entra authentication must be explicitly enabled.");
  if (!store) throw new Error("A durable encrypted authentication store is required.");
  const callbackUrl = `${config.origin}/api/auth/callback`;
  const inflight = new Map<string, Promise<Session>>();
  let loginWindowStart = Date.now(), loginStarts = 0, activeLoginStarts = 0;
  const authorized = (objectId: string, tenantMember: boolean) =>
    config.accessPolicy === "tenant-members" ? tenantMember : config.allowedObjectIds.includes(objectId);
  const unauthorized = () => new ActivityError(401, "Microsoft Entra sign-in is required.");
  const storageUnavailable = () => new ActivityError(503, "Authentication storage is unavailable.");
  const read = async (purpose: RecordPurpose, key: string): Promise<StoredRecord | undefined> => {
    try { return await bounded(store.read(purpose, key)); }
    catch (error) {
      if (error instanceof InvalidSessionRecord) {
        // Retain the ETag so a successful interactive login can revoke an old/corrupt record.
        if (error.etag) return { value: undefined, etag: error.etag };
        throw purpose === "pending" ? new ActivityError(400, "Invalid or expired sign-in state.") : unauthorized();
      }
      throw storageUnavailable();
    }
  };
  const change = async (operation: Promise<boolean>) => {
    try { return await bounded(operation); } catch { throw storageUnavailable(); }
  };
  const validTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const validTokens = (result: Pick<EntraTokens, "cache" | "accountId">) => typeof result.cache === "string" && result.cache.length > 0 &&
    Buffer.byteLength(result.cache) <= 512 * 1024 && typeof result.accountId === "string" &&
    result.accountId.length > 0 && result.accountId.length <= 512;
  const parseSession = (value: unknown, id: string): Session => {
    const s = value as Session | undefined;
    if (!s || s.version !== 1 || !matches(id, s.id) || !uuid.test(s.objectId) ||
      s.tenantId !== config.tenantId || s.clientId !== config.clientId || !validTime(s.issuedAt) ||
      typeof s.tenantMember !== "boolean" || typeof s.login !== "string" || s.login.length > 512 ||
      (s.displayName !== undefined && (typeof s.displayName !== "string" || s.displayName.length > 512)) ||
      !tokenPattern.test(s.csrfToken) || !validTime(s.createdAt) || !validTime(s.expiresAt) ||
      s.expiresAt !== s.createdAt + SESSION_TTL || s.createdAt > Date.now() + 60_000 ||
      !validTime(s.verifiedAt) || s.verifiedAt < s.createdAt || s.verifiedAt > Date.now() + 60_000 ||
      !validTime(s.renewAt) || s.renewAt <= s.verifiedAt || s.renewAt > s.verifiedAt + 30 * 60_000 ||
      !validTokens(s) ||
      (s.refresh !== undefined && (!s.refresh || !tokenPattern.test(s.refresh.owner) || !validTime(s.refresh.until) ||
        s.refresh.until > Date.now() + 60_000))) throw unauthorized();
    return s;
  };
  const revoke = async (id: string) => {
    const key = digest(id);
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await read("sessions", key);
      if (!record || await change(store.remove("sessions", key, record.etag))) return;
    }
    throw storageUnavailable();
  };
  const validateIdentity = (result: EntraTokens, nonce?: string, prior?: Session, startedAt?: number) => {
    if (!result || !validTokens(result) || !result.idTokenClaims || typeof result.idTokenClaims !== "object") {
      throw unauthorized();
    }
    const identity = result.idTokenClaims as Record<string, unknown>;
    const now = Date.now();
    if (identity.tid !== config.tenantId || identity.aud !== config.clientId ||
      identity.iss !== `https://login.microsoftonline.com/${config.tenantId}/v2.0` ||
      typeof identity.oid !== "string" || !uuid.test(identity.oid) ||
      (nonce !== undefined && !matches(identity.nonce, nonce)) ||
      !validTime(identity.exp) || !Number.isSafeInteger(identity.exp * 1000) ||
      identity.exp * 1000 <= now + 5 * 60_000 + 1_000 ||
      !validTime(identity.iat) || identity.iat * 1000 > now + 60_000 || identity.iat >= identity.exp ||
      // Entra can backdate freshly issued ID tokens by five minutes.
      (startedAt !== undefined && identity.iat * 1000 < startedAt - ISSUANCE_BACKDATE_ALLOWANCE) ||
      (identity.nbf !== undefined && (!validTime(identity.nbf) || identity.nbf * 1000 > now + 60_000)) ||
      (prior && (identity.oid.toLowerCase() !== prior.objectId || result.accountId !== prior.accountId ||
        identity.iat <= prior.issuedAt))) {
      throw unauthorized();
    }
    const objectId = identity.oid.toLowerCase();
    const tenantMember = identity.acct === 0 || identity.acct === "0";
    if (!authorized(objectId, tenantMember)) {
      throw new ActivityError(prior ? 401 : 403, config.accessPolicy === "tenant-members"
        ? "A confirmed member account in this Microsoft Entra tenant is required."
        : "This Microsoft Entra user is not authorized.");
    }
    const displayName = typeof identity.name === "string" && identity.name.trim() && identity.name.length <= 512
      ? identity.name : undefined;
    return { objectId, tenantMember, displayName, login: displayName ?? objectId,
      tenantId: config.tenantId, clientId: config.clientId, issuedAt: identity.iat,
      verifiedAt: now, renewAt: Math.min(now + 30 * 60_000, identity.exp * 1000 - 5 * 60_000) };
  };
  const load = async (id: string, renew: boolean): Promise<Session> => {
    const key = digest(id);
    const deadline = Date.now() + 15_000;
    for (let attempt = 0; attempt < 150 && Date.now() < deadline; attempt++) {
      const record = await read("sessions", key);
      if (!record) throw unauthorized();
      const session = parseSession(record.value, id);
      if (session.expiresAt <= Date.now() || !authorized(session.objectId, session.tenantMember)) {
        await revoke(id);
        throw unauthorized();
      }
      if (!renew || session.renewAt > Date.now()) return session;
      if (session.refresh && session.refresh.until > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const owner = randomToken();
      const locked = { ...session, refresh: { owner, until: Date.now() + 30_000 } };
      if (!await change(store.replace("sessions", key, locked, record.etag))) continue;
      const lockRecord = await read("sessions", key);
      if (!lockRecord) throw unauthorized();
      if (parseSession(lockRecord.value, id).refresh?.owner !== owner) continue;
      let updated: Session;
      try {
        const startedAt = Date.now();
        const result = await bounded(client.renew(session.cache, session.accountId));
        updated = { ...session, ...validateIdentity(result, undefined, session, startedAt),
          cache: result.cache, accountId: result.accountId };
        delete updated.refresh;
        if (updated.expiresAt <= Date.now()) throw unauthorized();
      } catch (error) {
        if (error instanceof InteractiveSignInRequired || (error instanceof ActivityError && error.status === 401)) {
          await change(store.remove("sessions", key, lockRecord.etag));
          throw unauthorized();
        }
        // Release only our lock. A concurrent logout must never be undone by this write.
        await change(store.replace("sessions", key, session, lockRecord.etag));
        throw new ActivityError(503, "Microsoft Entra session verification is unavailable. Try again.");
      }
      if (!await change(store.replace("sessions", key, updated, lockRecord.etag))) continue;
      // Re-read after CAS to observe a concurrent logout before authorizing this request.
      const current = await read("sessions", key);
      if (!current) throw unauthorized();
      const verified = parseSession(current.value, id);
      if (verified.expiresAt <= Date.now()) throw unauthorized();
      return verified;
    }
    throw new ActivityError(503, "Microsoft Entra session verification is busy. Try again.");
  };
  const requireSession = async (header: string | undefined) => {
    const id = readCookie(header, SESSION_COOKIE);
    if (!id) throw unauthorized();
    const key = digest(id);
    let operation = inflight.get(key);
    if (!operation) {
      if (inflight.size >= MAX_ENTRIES) throw new ActivityError(503, "Too many authentication requests.");
      operation = load(id, true).finally(() => inflight.delete(key));
      inflight.set(key, operation);
    }
    return operation;
  };
  const requireMutation = async (headers: IncomingHttpHeaders, renew = true) => {
    const id = readCookie(headers.cookie, SESSION_COOKIE);
    if (!id) throw unauthorized();
    const session = renew ? await requireSession(headers.cookie) : await load(id, false);
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
      const now = Date.now();
      if (now - loginWindowStart >= 60_000 || now < loginWindowStart) {
        loginWindowStart = now;
        loginStarts = 0;
      }
      if (loginStarts >= MAX_LOGIN_STARTS_PER_MINUTE || activeLoginStarts >= MAX_CONCURRENT_LOGIN_STARTS) {
        throw new ActivityError(503, "Too many sign-in attempts. Try again shortly.");
      }
      loginStarts++;
      activeLoginStarts++;
      try {
        const entry: Pending = { version: 1, state: randomToken(), browserToken: randomToken(), verifier: randomToken(),
          nonce: randomToken(), createdAt: now, expiresAt: now + STATE_TTL };
        let location: string;
        try {
          location = await bounded(client.getAuthCodeUrl({
            scopes, redirectUri: callbackUrl, responseMode: "query", state: entry.state, nonce: entry.nonce,
            codeChallenge: digest(entry.verifier), codeChallengeMethod: "S256", prompt: "select_account",
          }));
        } catch { throw new ActivityError(503, "Microsoft Entra sign-in is unavailable."); }
        if (!await change(store.create("pending", digest(entry.state), entry))) throw storageUnavailable();
        return { location, cookies: [cookie(STATE_COOKIE, entry.browserToken, STATE_TTL)] };
      } finally { activeLoginStarts--; }
    },
    async callback(url: URL, header: string | undefined) {
      const state = url.searchParams.get("state");
      if (url.origin !== config.origin || url.pathname !== "/api/auth/callback" || url.hash ||
        url.searchParams.getAll("state").length !== 1 || !state || !tokenPattern.test(state)) {
        throw new ActivityError(400, "Invalid or expired sign-in state.");
      }
      const record = await read("pending", digest(state));
      const entry = record?.value as Pending | undefined;
      if (!entry || entry.version !== 1 || !matches(state, entry.state) ||
        !matches(readCookie(header, STATE_COOKIE), entry.browserToken) ||
        !tokenPattern.test(entry.verifier) || !tokenPattern.test(entry.nonce) ||
        !validTime(entry.createdAt) || !validTime(entry.expiresAt) || entry.expiresAt !== entry.createdAt + STATE_TTL ||
        entry.createdAt > Date.now() + 60_000 || entry.expiresAt <= Date.now()) {
        throw new ActivityError(400, "Invalid or expired sign-in state.");
      }
      if (!await change(store.remove("pending", digest(state), record!.etag))) {
        throw new ActivityError(400, "Invalid or expired sign-in state.");
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 ||
        !code || code.length > 8_192 || /[^\x21-\x7e]/.test(code)) {
        throw new ActivityError(400, "Microsoft Entra sign-in was not completed.");
      }
      let result: EntraTokens;
      try {
        result = await bounded(client.acquireTokenByCode({
          scopes, redirectUri: callbackUrl, code, codeVerifier: entry.verifier, nonce: entry.nonce,
        }));
      } catch { throw new ActivityError(503, "Microsoft Entra code exchange is unavailable."); }
      const identity = validateIdentity(result, entry.nonce);
      const now = Date.now();
      if (entry.expiresAt <= now) throw new ActivityError(400, "Invalid or expired sign-in state.");
      const previous = readCookie(header, SESSION_COOKIE);
      if (previous) await revoke(previous);
      const session: Session = { version: 1, id: randomToken(), ...identity,
        cache: result.cache, accountId: result.accountId, verifiedAt: now,
        csrfToken: randomToken(), createdAt: now, expiresAt: now + SESSION_TTL };
      if (!await change(store.create("sessions", digest(session.id), session))) throw storageUnavailable();
      return { location: `${config.origin}/`, cookies: [
        cookie(SESSION_COOKIE, session.id, session.expiresAt - now), cookie(STATE_COOKIE, "", 0),
      ] };
    },
    requireSession,
    requireMutation,
    async session(header: string | undefined) {
      const session = await requireSession(header);
      return { authenticated: true, login: session.login, csrfToken: session.csrfToken };
    },
    async logout(headers: IncomingHttpHeaders) {
      const session = await requireMutation(headers, false);
      await revoke(session.id);
      return [cookie(SESSION_COOKIE, "", 0), cookie(STATE_COOKIE, "", 0)];
    },
  };
}
