import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntraAuth, readAzureAuthConfig, type AzureAuthConfig, type EntraClient } from "../api/src/azure/auth";
import { azureStateBlob, requireExistingState } from "../api/src/azure/blob";
import { createAzureActivityServer } from "../api/src/azure/server";
import { acknowledge, createState } from "../api/src/engine";
import { acknowledgeEmitter, createEmitterState } from "../api/src/emitter-engine";
import { createGithubCollectorAuth, readCollectorAuthConfig } from "../api/src/azure/collector-auth";
import type { StateBlob } from "../api/src/store";
import { memorySessionStore } from "./helpers/session-store";

const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const objectId = "1c15547f-ea83-425d-aeaf-7312df6f6148";
const otherId = "11111111-1111-4111-8111-111111111111";
const clientId = "d8714cdb-8d6d-443e-969a-5beab691ce59";
const origin = "https://dashboard.example";
const config: AzureAuthConfig = { mode: "entra-federated", tenantId, clientId,
  managedIdentityClientId: otherId, accessPolicy: "allowlist", allowedObjectIds: [objectId], origin };
const repository = "example/sdk";
const now = new Date().toISOString();
const collectorConfig = readCollectorAuthConfig({ ACTIVITY_COLLECTOR_AUTH: "github-oidc", ACTIVITY_ORIGIN: origin })!;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const collectorAuth = createGithubCollectorAuth(collectorConfig, {
  keys: [{ ...key.publicKey.export({ format: "jwk" }), kty: "RSA", kid: "runtime", alg: "RS256" }],
});
function collectorHeaders(feature: string) {
  const seconds = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://token.actions.githubusercontent.com", aud: collectorConfig.audience,
    sub: "repo:JialinHuang803@139532647/sdk-js-worker@1370752026:ref:refs/heads/main",
    repository: collectorConfig.repository,
    repository_id: collectorConfig.repositoryId, repository_owner_id: collectorConfig.repositoryOwnerId,
    ref: "refs/heads/main", event_name: "schedule", exp: seconds + 300, nbf: seconds - 10, iat: seconds - 10,
    workflow_ref: `${collectorConfig.repository}/.github/workflows/${feature === "activity" ? "collect-and-deploy" : "collect-emitter"}.yml@refs/heads/main` };
  const data = [JSON.stringify({ alg: "RS256", kid: "runtime" }), JSON.stringify(payload)]
    .map((value) => Buffer.from(value).toString("base64url")).join(".");
  return { Authorization: `Bearer ${data}.${sign("RSA-SHA256", Buffer.from(data), key.privateKey).toString("base64url")}`,
    "Content-Type": "application/json" };
}

function sdkState() {
  const state = createState();
  state.nextSequence = 2;
  state.feed.pullRequests.push({
    repository, number: 1, title: "Test PR", url: "https://github.com/example/sdk/pull/1",
    plane: "management", draft: false, holdOn: false, state: "open", packages: [],
  });
  state.feed.events.push({ id: "sdk-event", sequence: 1, repository, pullRequestNumber: 1,
    kind: "new-pr", occurredAt: now, readAt: null, acknowledgementId: null });
  state.feed.collectedAt = now;
  state.snapshot = { schemaVersion: 3, generatedAt: now, stale: false,
    source: { repository, query: "AutoPR", fetchedAt: now },
    pullRequests: [{ repository, number: 1, title: "Test PR", url: "https://github.com/example/sdk/pull/1",
      plane: "management", draft: false, holdOn: false, packages: [], headSha: "head1",
      createdAt: now, updatedAt: now, releasePlanUrl: null, reviewDecision: "review-required",
      checks: { failedCount: 0, qualification: "complete", observedCount: 1 }, conflicts: false,
      completeness: { changedFiles: "complete", checks: "complete", reviews: "complete", metadata: "complete" }, warnings: [] }],
    inbox: { comparisonFrom: null, generatedAt: now, baselineAvailable: false, defaultPlane: "management", items: [] } };
  return state;
}
function emitterState() {
  const state = createEmitterState();
  state.nextSequence = 2;
  state.feed.issues.push({ number: 2, title: "Test issue", url: "https://github.com/example/emitter/issues/2",
    createdAt: now, updatedAt: now, author: "reviewer", assignees: [], labels: [], comments: 0 });
  state.feed.events.push({ id: "emitter-event", sequence: 1, number: 2, kind: "new-issue",
    url: "https://github.com/example/emitter/issues/2", occurredAt: now, readAt: null, acknowledgementId: null });
  state.feed.collectedAt = now;
  state.snapshot = { schemaVersion: 1, generatedAt: now,
    source: { repository: "example/emitter", label: "emitter", fetchedAt: now },
    package: { name: "@example/emitter", version: "1.0.0", publishedAt: null, url: "https://www.npmjs.com/package/emitter" },
    issues: state.feed.issues, pullRequests: [],
    activity: { comparisonFrom: null, excludedIssueNumbers: [], events: [] } };
  return state;
}
function memory(initial: unknown) {
  let text = initial === null ? null : JSON.stringify(initial), revision = 0;
  const blob: StateBlob = {
    read: vi.fn(async () => text === null ? null : { text, etag: `"${revision}"` }),
    write: vi.fn(async (next, etag) => {
      expect(etag).toBe(`"${revision}"`);
      text = next;
      revision++;
    }),
  };
  return blob;
}

const servers: Server[] = [];
const directory = resolve("tests", ".azure-runtime-fixtures");
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
  await rm(directory, { recursive: true, force: true });
});
async function setup(sdk = memory(sdkState()), emitter = memory(emitterState()), enableCollector = true) {
  await mkdir(resolve(directory, "public", "data"), { recursive: true });
  await mkdir(resolve(directory, "outside"), { recursive: true });
  await writeFile(resolve(directory, "public", "index.html"), "<!doctype html><h1>Test dashboard</h1>");
  await writeFile(resolve(directory, "public", "data", "sdk-prs.json"), '{ "exact": "published bytes" }\r\n');
  await writeFile(resolve(directory, "outside", "private.json"), '{"not":"public"}');
  await symlink(resolve(directory, "outside"), resolve(directory, "public", "escape"), "junction");
  const client: EntraClient = {
    async getAuthCodeUrl(request) {
      return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?state=${request.state}`;
    },
    async acquireTokenByCode(request) {
      return { cache: '{"test":"cache"}', accountId: "test-account", idTokenClaims: { tid: tenantId, oid: objectId, aud: clientId,
        iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, name: "Test reviewer",
        nonce: request.nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) } };
    },
    async renew() { throw new Error("Unexpected renewal."); },
  };
  const sessionStore = memorySessionStore();
  const auth = createEntraAuth(config, client, sessionStore);
  const server = createAzureActivityServer({ auth, origin, sdk, emitter, staticDirectory: resolve(directory, "public"),
    collectorAuth: enableCollector ? collectorAuth : undefined });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server.");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
  const start = await send("/api/auth/login");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await send(`/api/auth/callback?state=${state}&code=test-code`, {
    headers: { Cookie: start.headers.getSetCookie()[0].split(";")[0] },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${origin}/`);
  const signedIn = { Cookie: callback.headers.getSetCookie()[0].split(";")[0] };
  const session = await (await send("/api/auth/session", { headers: signedIn })).json();
  const mutations = { ...signedIn, Origin: origin, "Content-Type": "application/json", "x-csrf-token": session.csrfToken };
  const raw = (path: string) => new Promise<number>((done, reject) => {
    const request = httpRequest(base, { path, headers: signedIn }, (response) => {
      response.resume(); done(response.statusCode!);
    });
    request.on("error", reject); request.end();
  });
  return { send, raw, sdk, emitter, signedIn, mutations, client, sessionStore };
}

describe("federated BFF trust boundary", () => {
  it("renews expired ID tokens before serving HTTP data, preserves CSRF, and fails closed on outages/revocation", async () => {
    const { send, client, signedIn, mutations, sdk } = await setup();
    const session = await (await send("/api/auth/session", { headers: signedIn })).json();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    const renew = vi.spyOn(client, "renew").mockImplementation(async () => ({
      cache: '{"test":"fresh-cache"}', accountId: "test-account",
      idTokenClaims: { tid: tenantId, oid: objectId, aud: clientId,
        iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, name: "Test reviewer",
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) },
    }));
    const renewed = await send("/api/auth/session", { headers: signedIn });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual(session);
    expect(renewed.headers.get("set-cookie")).toBeNull();
    expect(renew).toHaveBeenCalledOnce();
    clock.mockReturnValue(Date.now() + 60 * 60_000);
    renew.mockRejectedValueOnce(new Error("private upstream response"));
    const before = vi.mocked(sdk.write).mock.calls.length;
    const blocked = await send("/api/activity/ack", { method: "POST", headers: mutations, body: "{}" });
    expect(blocked.status).toBe(503);
    expect(JSON.stringify(await blocked.json())).not.toContain("private");
    expect(vi.mocked(sdk.write).mock.calls).toHaveLength(before);
    renew.mockResolvedValueOnce({ cache: '{"test":"cache"}', accountId: "test-account",
      idTokenClaims: { tid: tenantId, oid: otherId, aud: clientId,
        iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) } });
    expect((await send("/api/auth/session", { headers: signedIn })).status).toBe(401);
    expect((await send("/api/activity", { headers: signedIn })).status).toBe(401);
  });

  it("allows CSRF-protected durable logout even when online renewal is unavailable", async () => {
    const { send, client, signedIn, mutations } = await setup();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    const renew = vi.spyOn(client, "renew").mockRejectedValue(new Error("Entra unavailable"));
    expect((await send("/api/auth/logout", { method: "POST", headers: mutations, body: "{}" })).status).toBe(200);
    expect(renew).not.toHaveBeenCalled();
    expect((await send("/api/auth/session", { headers: signedIn })).status).toBe(401);
  });

  it("requires explicit federated mode, HTTPS origin, fixed IDs and nonempty object allowlist", () => {
    const env = { ACTIVITY_AUTH_MODE: "entra-federated", ACTIVITY_ENTRA_TENANT_ID: tenantId,
      ACTIVITY_ENTRA_CLIENT_ID: clientId, ACTIVITY_ENTRA_MANAGED_IDENTITY_CLIENT_ID: otherId,
      ACTIVITY_ALLOWED_OBJECT_IDS: objectId, ACTIVITY_ORIGIN: origin };
    expect(readAzureAuthConfig(env)).toEqual(config);
    expect(readAzureAuthConfig({ ...env, ACTIVITY_ENTRA_ACCESS_POLICY: "tenant-members",
      ACTIVITY_ALLOWED_OBJECT_IDS: undefined })).toEqual({
      ...config, accessPolicy: "tenant-members", allowedObjectIds: [],
    });
    for (const changes of [
      { ACTIVITY_AUTH_MODE: undefined }, { ACTIVITY_AUTH_MODE: "anonymous" },
      { ACTIVITY_AUTH_MODE: "aca-easyauth" }, { ACTIVITY_ENTRA_CLIENT_ID: undefined },
      { ACTIVITY_ENTRA_MANAGED_IDENTITY_CLIENT_ID: "" },
      { ACTIVITY_ENTRA_TENANT_ID: "bad" }, { ACTIVITY_ALLOWED_OBJECT_IDS: "" },
      { ACTIVITY_ENTRA_ACCESS_POLICY: "all" }, { ACTIVITY_ENTRA_ACCESS_POLICY: "" },
      { ACTIVITY_ENTRA_ACCESS_POLICY: "tenant-members" },
      { ACTIVITY_ORIGIN: "http://dashboard.example" }, { ACTIVITY_ORIGIN: `${origin}/` },
    ]) expect(() => readAzureAuthConfig({ ...env, ...changes })).toThrow();
  });

  it("protects all content and APIs; only login/callback accept unauthenticated requests", async () => {
    const { send, signedIn } = await setup();
    expect((await send("/")).status).toBe(302);
    expect((await send("/")).headers.get("location")).toBe("/api/auth/login");
    for (const path of ["/data/sdk-prs.json", "/assets/app.js", "/api/health", "/api/auth/session",
      "/api/activity", "/api/emitter-activity", "/api/activity/baseline"]) {
      expect((await send(path)).status).toBe(401);
      expect((await send(path, { headers: { Authorization: "Bearer ignored", "x-ms-client-principal-id": objectId,
        "x-ms-client-principal": Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [
          { typ: "tid", val: tenantId }, { typ: "oid", val: objectId },
        ] })).toString("base64") } })).status).toBe(401);
    }
    expect((await send("/api/auth/callback?code=forged&state=forged")).status).toBe(400);
    const response = await send("/api/auth/session", { headers: signedIn });
    expect(await response.json()).toEqual({ authenticated: true, login: "Test reviewer", csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires origin, JSON and session CSRF for logout and invalidates the cookie immediately", async () => {
    const { send, signedIn, mutations } = await setup();
    expect((await send("/api/auth/logout", { method: "POST", headers: signedIn, body: "{}" })).status).toBe(403);
    const logout = await send("/api/auth/logout", { method: "POST", headers: mutations, body: "{}" });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ authenticated: false, login: null, csrfToken: null });
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    expect(logout.headers.getSetCookie().every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect((await send("/api/auth/session", { headers: signedIn })).status).toBe(401);
    expect((await send("/data/sdk-prs.json", { headers: signedIn })).status).toBe(401);
  });
});

describe("hosted state and static HTTP integration", () => {
  it("acknowledges and restores SDK and emitter state through shared engines with ETags", async () => {
    const { send, sdk, emitter, signedIn, mutations } = await setup();
    for (const feature of ["activity", "emitter-activity"]) {
      const response = await send(`/api/${feature}`, { headers: signedIn });
      const feed = await response.json();
      expect(response.status, JSON.stringify(feed)).toBe(200);
      expect(feed.events[0].readAt).toBeNull();
      const body = { generation: feed.generation, throughSequence: 1, readBy: "Forged reader",
        ...(feature === "activity" ? { repository, pullRequestNumber: 1 } : { number: 2 }) };
      const ack = await send(`/api/${feature}/ack`, { method: "POST", headers: mutations, body: JSON.stringify(body) });
      expect(ack.status).toBe(200);
      const result = await ack.json();
      expect(result.feed.events[0].readAt).not.toBeNull();
      expect(result.feed.events[0].readBy).toEqual({ name: "Test reviewer", acknowledgementId: result.acknowledgementId });
      const read = await (await send(`/api/${feature}`, { headers: signedIn })).json();
      expect(read.events[0].acknowledgementId).toBe(result.acknowledgementId);
      expect(read.events[0].readBy.name).toBe("Test reviewer");
      const restored = await send(`/api/${feature}/restore`, { method: "POST", headers: mutations,
        body: JSON.stringify({ generation: feed.generation, acknowledgementIds: [result.acknowledgementId] }) });
      expect(restored.status).toBe(200);
      const restoredEvent = (await restored.json()).feed.events[0];
      expect(restoredEvent.readAt).toBeNull();
      expect(restoredEvent).not.toHaveProperty("readBy");
    }
    expect(sdk.write).toHaveBeenCalled();
    expect(emitter.write).toHaveBeenCalled();
  });

  it("rejects absent/wrong origins, custom headers, media types, JSON and oversized bodies", async () => {
    const { send, sdk, signedIn, mutations } = await setup();
    for (const headers of [
      signedIn, { ...mutations, Origin: `${origin}/` }, { ...mutations, Origin: "https://attacker.example" },
      { ...mutations, Origin: "null" }, { ...mutations, "x-csrf-token": "wrong" },
    ]) expect((await send("/api/activity/ack", { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await send("/api/activity/ack", { method: "POST", headers: { ...mutations, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    for (const body of ["not-json", "{}"]) {
      expect((await send("/api/activity/ack", { method: "POST", headers: mutations, body })).status).toBe(400);
    }
    expect((await send("/api/activity/ack", { method: "POST", headers: mutations, body: JSON.stringify("x".repeat(20_000)) })).status).toBe(413);
    expect((await send("/api/activity", { method: "OPTIONS", headers: signedIn })).status).toBe(405);
    expect(sdk.write).not.toHaveBeenCalled();
  });

  it("retries storage precondition failures without replacing state or changing generations", async () => {
    const { send, sdk, emitter, signedIn, mutations } = await setup();
    for (const [feature, blob] of [["activity", sdk], ["emitter-activity", emitter]] as const) {
      const feed = await (await send(`/api/${feature}`, { headers: signedIn })).json();
      vi.mocked(blob.write).mockClear();
      vi.mocked(blob.read).mockClear();
      vi.mocked(blob.write).mockRejectedValueOnce({ statusCode: 412 });
      const response = await send(`/api/${feature}/ack`, { method: "POST", headers: mutations,
        body: JSON.stringify({ generation: feed.generation, throughSequence: 1, repository, pullRequestNumber: 1, number: 2 }) });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.feed.generation).toBe(feed.generation);
      expect(result.feed.events[0].id).toBe(feed.events[0].id);
      expect(result.feed.events[0].readAt).not.toBeNull();
      expect(result.feed.events[0].readBy).toEqual({ name: "Test reviewer", acknowledgementId: result.acknowledgementId });
      expect(blob.write).toHaveBeenCalledTimes(2);
      expect(blob.read).toHaveBeenCalledTimes(2);
    }
  });

  it("never initializes missing, invalid or unavailable SDK/emitter state", async () => {
    const sdk = memory(null), emitter = memory(null);
    const { send, signedIn, mutations } = await setup(sdk, emitter);
    for (const feature of ["activity", "emitter-activity"]) {
      const response = await send(`/api/${feature}`, { headers: signedIn });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("missing");
      const ack = await send(`/api/${feature}/ack`, { method: "POST", headers: mutations,
        body: JSON.stringify({ generation: "test", throughSequence: 1, repository, pullRequestNumber: 1, number: 2 }) });
      expect(ack.status).toBe(503);
    }
    vi.mocked(sdk.read).mockResolvedValue({ text: "{invalid", etag: '"1"' });
    expect((await send("/api/activity", { headers: signedIn })).status).toBe(503);
    vi.mocked(emitter.read).mockRejectedValue(new Error("storage unavailable"));
    expect((await send("/api/emitter-activity", { headers: signedIn })).status).toBe(503);
    expect(sdk.write).not.toHaveBeenCalled();
    expect(emitter.write).not.toHaveBeenCalled();
  });

  it("disables all collectors even for approved users, without touching storage", async () => {
    const { send, sdk, emitter, mutations } = await setup(undefined, undefined, false);
    for (const feature of ["activity", "emitter-activity"]) {
      for (const action of ["baseline", "ingest"]) {
        const response = await send(`/api/${feature}/${action}`, { headers: mutations, method: action === "baseline" ? "GET" : "POST" });
        expect(response.status).toBe(401);
        const machine = await send(`/api/${feature}/${action}`, { headers: collectorHeaders(feature),
          method: action === "baseline" ? "GET" : "POST" });
        expect(machine.status).toBe(503);
        expect((await machine.json()).error).toContain("collector integration is disabled");
      }
    }
    expect(sdk.read).not.toHaveBeenCalled();
    expect(emitter.read).not.toHaveBeenCalled();
  });

  it("serves canonical snapshots rather than bundled files and rejects traversal and symlink escapes", async () => {
    const { send, raw, signedIn } = await setup();
    expect((await send("/", { headers: signedIn })).status).toBe(200);
    const data = await send("/data/sdk-prs.json", { headers: signedIn });
    expect(await data.json()).toEqual(sdkState().snapshot);
    expect(await (await send("/data/emitter.json", { headers: signedIn })).json()).toEqual(emitterState().snapshot);
    expect((await send("/data/sdk-prs.json", { method: "HEAD", headers: signedIn })).status).toBe(200);
    for (const path of ["/../outside/private.json", "/%2e%2e/outside/private.json", "/%2e%2e%5coutside%5cprivate.json",
      "//outside/private.json", "/escape/private.json", "/.env", "/api/unknown", "/missing.js"]) {
      expect(await raw(path), path).toBe(404);
    }
    expect(await raw("/%xx")).toBe(400);
  });
});

describe("hosted collectors and live snapshots", () => {
  it("separates bearer collectors, browser sessions and Function keys on every route", async () => {
    const { send, mutations, sdk, emitter } = await setup();
    for (const feature of ["activity", "emitter-activity"]) {
      const headers = collectorHeaders(feature);
      for (const path of [`/api/${feature}`, "/data/sdk-prs.json", "/data/emitter.json", "/",
        "/api/auth/session", "/api/auth/login", "/api/auth/callback"]) {
        expect((await send(path, { headers })).status, path).toBe(401);
        expect((await send(path, { headers: { ...mutations, ...headers } })).status, path).toBe(401);
      }
      for (const path of [`/api/${feature}/ack`, `/api/${feature}/restore`, "/api/auth/logout"]) {
        expect((await send(path, { method: "POST", headers, body: "{}" })).status, path).toBe(401);
      }
      for (const action of ["baseline", "ingest"]) {
        const method = action === "baseline" ? "GET" : "POST";
        const credentialsToReject: HeadersInit[] = [mutations, { "x-functions-key": "spoof" }, {}];
        for (const credentials of credentialsToReject) {
          expect((await send(`/api/${feature}/${action}`, { method, headers: credentials })).status).toBe(401);
        }
      }
      expect((await send(`/api/${feature}/baseline`, { headers, method: "POST" })).status).toBe(405);
      expect((await send(`/api/${feature}/ingest`, { headers })).status).toBe(405);
      expect((await send(`/api/${feature}/ingest`, { headers, method: "OPTIONS" })).status).toBe(405);
    }
    expect((await send("/api/emitter-activity/baseline", { headers: collectorHeaders("activity") })).status).toBe(403);
    expect(sdk.read).not.toHaveBeenCalled();
    expect(emitter.read).not.toHaveBeenCalled();
  });

  it("returns only the established collector baseline contracts without feed or reader attribution", async () => {
    const sdk = sdkState(), emitter = emitterState();
    acknowledge(sdk, { generation: sdk.feed.generation, repository, pullRequestNumber: 1, throughSequence: 1 }, now, "Private reader");
    acknowledgeEmitter(emitter, { generation: emitter.feed.generation, number: 2, throughSequence: 1 }, now, "Private reader");
    const { send } = await setup(memory(sdk), memory(emitter));
    for (const feature of ["activity", "emitter-activity"]) {
      const response = await send(`/api/${feature}/baseline`, { headers: collectorHeaders(feature) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(feature === "activity"
        ? { snapshot: sdk.snapshot, trackedPullRequests: sdk.feed.pullRequests } : { snapshot: emitter.snapshot });
      expect(JSON.stringify(body)).not.toContain("readBy");
      expect(JSON.stringify(body)).not.toContain("Private reader");
      expect(body).not.toHaveProperty("feed");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it.each(["activity", "emitter-activity"])("atomically ingests %s while retaining a racing browser acknowledgement", async (feature) => {
    const sdk = sdkState(), emitter = emitterState();
    const { send, signedIn, sdk: sdkBlob, emitter: emitterBlob } = await setup(memory(sdk), memory(emitter));
    const blob = feature === "activity" ? sdkBlob : emitterBlob;
    const headers = collectorHeaders(feature);
    const baseline = await (await send(`/api/${feature}/baseline`, { headers })).json();
    const next = structuredClone(baseline.snapshot);
    const collectedAt = new Date(Date.parse(now) + 1000).toISOString();
    next.generatedAt = next.source.fetchedAt = collectedAt;
    if (feature === "activity") {
      next.inbox.comparisonFrom = baseline.snapshot.generatedAt;
      next.inbox.generatedAt = collectedAt;
      next.inbox.items = [{ repository, pullRequestNumber: 1, activityAt: collectedAt,
        reasons: ["new-commit"], comments: [] }];
      next.pullRequests[0].headSha = "new-head";
      next.pullRequests[0].updatedAt = collectedAt;
    } else {
      next.activity.comparisonFrom = baseline.snapshot.generatedAt;
      next.activity.events = [{ id: "new-comment", number: 2, kind: "new-comment", occurredAt: collectedAt,
        url: "https://github.com/example/emitter/issues/2#issuecomment-1" }];
    }
    const write = vi.mocked(blob.write).getMockImplementation()!;
    vi.mocked(blob.write).mockImplementationOnce(async (_text, etag) => {
      if (feature === "activity") {
        acknowledge(sdk, { generation: sdk.feed.generation, repository, pullRequestNumber: 1, throughSequence: 1 }, now, "Racing reviewer");
      } else {
        acknowledgeEmitter(emitter, { generation: emitter.feed.generation, number: 2, throughSequence: 1 }, now, "Racing reviewer");
      }
      await write(JSON.stringify(feature === "activity" ? sdk : emitter), etag);
      throw { statusCode: 412 };
    });
    const response = await send(`/api/${feature}/ingest`, { method: "POST", headers,
      body: JSON.stringify({ snapshot: next, inactivePullRequests: [] }) });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toEqual({ collectedAt, revision: 2 });
    expect(blob.write).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse((await blob.read())!.text);
    expect(persisted.snapshot).toEqual(next);
    expect(persisted.feed.generation).toBe((feature === "activity" ? sdk : emitter).feed.generation);
    expect(persisted.feed.events).toHaveLength(2);
    expect(persisted.feed.events[0].readBy).toEqual({ name: "Racing reviewer",
      acknowledgementId: persisted.feed.events[0].acknowledgementId });
    expect(persisted.feed.events[1]).not.toHaveProperty("readBy");
    expect(persisted.feed.events[1].readAt).toBeNull();
    const snapshotPath = feature === "activity" ? "/data/sdk-prs.json" : "/data/emitter.json";
    const visible = await (await send(snapshotPath, { headers: signedIn })).json();
    expect(visible).toEqual(next);
    expect(JSON.stringify(visible)).not.toContain("Racing reviewer");
    expect(visible).not.toHaveProperty("feed");
    const retry = await send(`/api/${feature}/ingest`, { method: "POST", headers,
      body: JSON.stringify({ snapshot: next, inactivePullRequests: [] }) });
    expect(retry.status).toBe(200);
    expect(blob.write).toHaveBeenCalledTimes(2);
    for (const bad of [
      baseline.snapshot,
      { ...next, generatedAt: new Date(Date.parse(collectedAt) + 1000).toISOString() },
    ]) {
      const stale = await send(`/api/${feature}/ingest`, { method: "POST", headers,
        body: JSON.stringify({ snapshot: bad, inactivePullRequests: [] }) });
      expect(stale.status).toBe(409);
    }
    expect(JSON.parse((await blob.read())!.text)).toEqual(persisted);
  });

  it("fails closed for missing, corrupt and unavailable canonical blobs without serving bundled snapshots", async () => {
    const sdk = memory(null), emitter = memory(null);
    const { send, signedIn } = await setup(sdk, emitter);
    for (const [feature, path, blob] of [
      ["activity", "/data/sdk-prs.json", sdk], ["emitter-activity", "/data/emitter.json", emitter],
    ] as const) {
      for (const source of [null, { text: "{broken", etag: '"1"' }, { text: '{"schemaVersion":99}', etag: '"1"' }]) {
        vi.mocked(blob.read).mockResolvedValue(source);
        expect((await send(path, { headers: signedIn })).status).toBe(503);
        expect((await send(`/api/${feature}/baseline`, { headers: collectorHeaders(feature) })).status).toBe(503);
      }
      vi.mocked(blob.read).mockRejectedValue(new Error("SECRET storage account error"));
      const failed = await send(path, { headers: signedIn });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("SECRET");
      expect(blob.write).not.toHaveBeenCalled();
    }
  });

  it("does not fall back to bundled data when an existing state has no snapshot", async () => {
    const { send, signedIn, sdk, emitter } = await setup(memory(createState()), memory(createEmitterState()));
    for (const path of ["/data/sdk-prs.json", "/data/emitter.json"]) {
      expect((await send(path, { headers: signedIn })).status).toBe(503);
    }
    expect(sdk.write).not.toHaveBeenCalled();
    expect(emitter.write).not.toHaveBeenCalled();
  });

  it("retains the last good snapshot and feed when storage rejects an ingest write", async () => {
    const { send, sdk, signedIn } = await setup();
    const before = await sdk.read();
    const next = structuredClone(sdkState().snapshot);
    if (!next) throw new Error("Expected fixture snapshot.");
    next.inbox.comparisonFrom = next.generatedAt;
    next.generatedAt = next.source.fetchedAt = new Date(Date.parse(now) + 1000).toISOString();
    vi.mocked(sdk.write).mockRejectedValueOnce(new Error("SECRET storage credentials"));
    const response = await send("/api/activity/ingest", { method: "POST", headers: collectorHeaders("activity"),
      body: JSON.stringify({ snapshot: next, inactivePullRequests: [] }) });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
    expect(await sdk.read()).toEqual(before);
    expect(await (await send("/data/sdk-prs.json", { headers: signedIn })).json()).toEqual(sdkState().snapshot);
  });

  it("preserves old canonical freshness timestamps and never persists synthetic stale metadata", async () => {
    const sdk = sdkState(), emitter = emitterState();
    const old = new Date(Date.now() - 27 * 60 * 60_000).toISOString();
    if (!sdk.snapshot || !emitter.snapshot) throw new Error("Expected fixture snapshots.");
    sdk.feed.collectedAt = sdk.snapshot.generatedAt = sdk.snapshot.source.fetchedAt = old;
    emitter.feed.collectedAt = emitter.snapshot.generatedAt = emitter.snapshot.source.fetchedAt = old;
    sdk.feed.events[0].occurredAt = emitter.feed.events[0].occurredAt = old;
    const { send, signedIn, sdk: sdkBlob, emitter: emitterBlob } = await setup(memory(sdk), memory(emitter));
    for (const path of ["/data/sdk-prs.json", "/data/emitter.json"]) {
      const snapshot = await (await send(path, { headers: signedIn })).json();
      expect(snapshot.generatedAt).toBe(old);
      expect(snapshot.source.fetchedAt).toBe(old);
      expect(Date.now() - Date.parse(snapshot.generatedAt)).toBeGreaterThan(26 * 60 * 60_000);
      const head = await send(path, { method: "HEAD", headers: signedIn });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("cache-control")).toBe("no-store");
    }
    expect(sdkBlob.write).not.toHaveBeenCalled();
    expect(emitterBlob.write).not.toHaveBeenCalled();
  });

  it("bounds ingest at 4 MiB while keeping acknowledgement limits at 16 KiB", async () => {
    const { send, mutations, sdk } = await setup();
    const headers = collectorHeaders("activity");
    const input = { snapshot: sdkState().snapshot, inactivePullRequests: [], padding: "x".repeat(20_000) };
    expect((await send("/api/activity/ingest", { method: "POST", headers, body: JSON.stringify(input) })).status).toBe(200);
    expect((await send("/api/activity/ack", { method: "POST", headers: mutations, body: JSON.stringify(input) })).status).toBe(413);
    for (const body of ["", "not json", "{}"]) {
      expect((await send("/api/activity/ingest", { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await send("/api/activity/ingest", { method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await send("/api/activity/ingest", { method: "POST", headers,
      body: JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024) }) })).status).toBe(413);
    expect(sdk.write).not.toHaveBeenCalled();
  });
});

describe("Azure Blob CAS adapter", () => {
  it("preserves exact ETags and uses conditional overwrite only", async () => {
    const download = vi.fn().mockResolvedValue({ etag: '"azure-etag"', readableStreamBody: Readable.from(['{"state":1}']) });
    const upload = vi.fn().mockResolvedValue({});
    const blob = azureStateBlob({ download, upload });
    expect(await blob.read()).toEqual({ text: '{"state":1}', etag: '"azure-etag"' });
    await blob.write('{"state":2}', '"azure-etag"');
    expect(upload).toHaveBeenCalledWith('{"state":2}', 11, {
      conditions: { ifMatch: '"azure-etag"' }, blobHTTPHeaders: { blobContentType: "application/json" },
    });
    await expect(blob.write("{}", null)).rejects.toThrow("ETag");
    upload.mockRejectedValueOnce({ statusCode: 412 });
    await expect(blob.write("{}", '"stale"')).rejects.toEqual({ statusCode: 412 });
    download.mockRejectedValueOnce({ statusCode: 404, code: "BlobNotFound" });
    await expect(blob.read()).rejects.toEqual({ statusCode: 404, code: "BlobNotFound" });
    expect(upload).toHaveBeenCalledTimes(2);
    await expect(requireExistingState(memory(null)).read()).rejects.toThrow("missing");
  });
});
