import { once } from "node:events";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntraAuth, readAzureAuthConfig, type AzureAuthConfig, type EntraClient } from "../api/src/azure/auth";
import { azureStateBlob, requireExistingState } from "../api/src/azure/blob";
import { createAzureActivityServer } from "../api/src/azure/server";
import { createState } from "../api/src/engine";
import { createEmitterState } from "../api/src/emitter-engine";
import type { StateBlob } from "../api/src/store";

const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const objectId = "1c15547f-ea83-425d-aeaf-7312df6f6148";
const otherId = "11111111-1111-4111-8111-111111111111";
const clientId = "d8714cdb-8d6d-443e-969a-5beab691ce59";
const origin = "https://dashboard.example";
const config: AzureAuthConfig = { mode: "entra-federated", tenantId, clientId,
  managedIdentityClientId: otherId, accessPolicy: "allowlist", allowedObjectIds: [objectId], origin };
const repository = "example/sdk";
const now = new Date().toISOString();

function sdkState() {
  const state = createState();
  state.nextSequence = 2;
  state.feed.pullRequests.push({
    repository, number: 1, title: "Test PR", url: "https://github.com/example/sdk/pull/1",
    plane: "management", draft: false, holdOn: false, state: "open", packages: [],
  });
  state.feed.events.push({ id: "sdk-event", sequence: 1, repository, pullRequestNumber: 1,
    kind: "new-pr", occurredAt: now, readAt: null, acknowledgementId: null });
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
  await rm(directory, { recursive: true, force: true });
});
async function setup(sdk = memory(sdkState()), emitter = memory(emitterState())) {
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
      return { idTokenClaims: { tid: tenantId, oid: objectId, aud: clientId,
        iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, name: "Test reviewer",
        nonce: request.nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) } };
    },
  };
  const auth = createEntraAuth(config, client);
  const server = createAzureActivityServer({ auth, origin, sdk, emitter, staticDirectory: resolve(directory, "public") });
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
  return { send, raw, sdk, emitter, signedIn, mutations };
}

describe("federated BFF trust boundary", () => {
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
      "/api/activity", "/api/emitter-activity", "/api/activity/baseline", "/api/activity/ingest"]) {
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
    const { send, sdk, emitter, mutations } = await setup();
    for (const feature of ["activity", "emitter-activity"]) {
      for (const action of ["baseline", "ingest"]) {
        const response = await send(`/api/${feature}/${action}`, { headers: mutations, method: action === "baseline" ? "GET" : "POST" });
        expect(response.status).toBe(503);
        expect((await response.json()).error).toContain("collector integration is disabled");
      }
    }
    expect(sdk.read).not.toHaveBeenCalled();
    expect(emitter.read).not.toHaveBeenCalled();
  });

  it("serves exact snapshot bytes and rejects traversal, symlink escapes and absent files", async () => {
    const { send, raw, signedIn } = await setup();
    expect((await send("/", { headers: signedIn })).status).toBe(200);
    const data = await send("/data/sdk-prs.json", { headers: signedIn });
    expect(Buffer.from(await data.arrayBuffer())).toEqual(await readFile(resolve(directory, "public", "data", "sdk-prs.json")));
    expect((await send("/data/sdk-prs.json", { method: "HEAD", headers: signedIn })).status).toBe(200);
    for (const path of ["/../outside/private.json", "/%2e%2e/outside/private.json", "/%2e%2e%5coutside%5cprivate.json",
      "//outside/private.json", "/escape/private.json", "/.env", "/api/unknown", "/missing.js"]) {
      expect(await raw(path), path).toBe(404);
    }
    expect(await raw("/%xx")).toBe(400);
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
