import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAuth } from "../api/src/github/auth";
import { createActivityServer } from "../api/src/github/server";
import { createState, ingest } from "../api/src/engine";
import { createEmitterState, ingestEmitter } from "../api/src/emitter-engine";
import { createHash } from "node:crypto";
import { createGitHubState } from "../api/src/github/blob";
import type { GitHubClient } from "../api/src/github/client";
import { initialState } from "../api/src/github/initialize";
import type { DashboardSnapshot } from "../src/data/contracts";
import type { EmitterSnapshot } from "../src/data/emitter-contracts";

const origin = "http://127.0.0.1:5173";
const ingestKey = "local-test-key-not-a-real-credential-123";
const repository = "example/sdk";
const time = new Date().toISOString();
function sdkSnapshot(head = "head-1", generatedAt = time): DashboardSnapshot {
  return {
    schemaVersion: 3, generatedAt, stale: false,
    source: { repository, fetchedAt: generatedAt, query: "AutoPR" },
    pullRequests: [{
      repository, number: 1, url: "https://github.com/example/sdk/pull/1",
      title: "[AutoPR test]", plane: "management", draft: false, holdOn: false,
      headSha: head, createdAt: time, updatedAt: generatedAt, releasePlanUrl: null, packages: [],
      reviewDecision: "review-required", checks: { failedCount: 0, qualification: "complete", observedCount: 1 },
      conflicts: false, completeness: { changedFiles: "complete", checks: "complete", reviews: "complete", metadata: "complete" },
      warnings: [],
    }],
    inbox: { generatedAt, comparisonFrom: time, baselineAvailable: true, defaultPlane: "management",
      items: [{ repository, pullRequestNumber: 1, activityAt: generatedAt, reasons: ["new-commit"], comments: [] }] },
  };
}
function emitterSnapshot(): EmitterSnapshot {
  return {
    schemaVersion: 1, generatedAt: time,
    source: { repository: "example/emitter", label: "emitter", fetchedAt: time },
    package: { name: "@example/emitter", version: "1.0.0", publishedAt: null, url: "https://www.npmjs.com/package/emitter" },
    issues: [{ number: 2, title: "Example issue", url: "https://github.com/example/emitter/issues/2",
      createdAt: time, updatedAt: time, author: "writer", assignees: [], labels: [], comments: 0 }],
    pullRequests: [],
    activity: { comparisonFrom: new Date(Date.parse(time) - 60_000).toISOString(), excludedIssueNumbers: [],
      events: [{ id: "opened:2", number: 2, kind: "new-issue", occurredAt: time,
        url: "https://github.com/example/emitter/issues/2" }] },
  };
}
function storage(sdk: unknown, emitter: unknown) {
  const files = new Map([
    ["/repos/example/state/contents/activity/sdk.json", JSON.stringify(sdk)],
    ["/repos/example/state/contents/activity/emitter.json", JSON.stringify(emitter)],
  ]);
  const sha = (text: string) => createHash("sha1").update(text).digest("hex");
  const client: GitHubClient = {
    async request(path, init) {
      if (path === "/repos/example/state") return Response.json({ private: true, default_branch: "main" });
      if (path.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/dashboard-state" });
      const file = path.split("?")[0], text = files.get(file);
      if (text === undefined) return Response.json({}, { status: 404 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        if (body.sha !== sha(text)) return Response.json({}, { status: 409 });
        files.set(file, Buffer.from(body.content, "base64").toString());
        return Response.json({}, { status: 200 });
      }
      return Response.json({ type: "file", encoding: "base64", sha: sha(text),
        size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") });
    },
  };
  return createGitHubState(client, { repository: "example/state", branch: "dashboard-state", allowPublic: false });
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});
async function setup() {
  const sdk = createState(), emitter = createEmitterState();
  ingest(sdk, { snapshot: sdkSnapshot(), inactivePullRequests: [] }, time);
  const baseline = emitterSnapshot();
  baseline.generatedAt = baseline.activity!.comparisonFrom!;
  baseline.source.fetchedAt = baseline.generatedAt;
  baseline.activity = { comparisonFrom: null, excludedIssueNumbers: [], events: [] };
  ingestEmitter(emitter, { snapshot: baseline }, time);
  ingestEmitter(emitter, { snapshot: emitterSnapshot() }, time);
  const auth = createAuth({
    clientId: "client", clientSecret: "not-real-secret", callbackUrl: `${origin}/api/auth/callback`,
    dashboardUrl: `${origin}/sdk-js-worker/`, allowedUsers: ["reviewer"], secureCookies: false,
  }, async (input) => String(input).includes("/login/oauth/access_token") ?
    Response.json({ access_token: "test-oauth-token", token_type: "bearer" }) :
    Response.json({ login: "reviewer", id: 123 }));
  const state = storage(sdk, emitter);
  const server = createActivityServer({ auth, sdk: state.blob("sdk"), emitter: state.blob("emitter"), origin, ingestKey });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener.");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (path: string, init: RequestInit = {}) => fetch(`${base}/api/${path}`, {
    ...init, redirect: "manual", headers: { Host: new URL(origin).host, ...init.headers },
  });
  async function login() {
    const start = await send("auth/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await send(`auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${origin}/sdk-js-worker/`);
    const cookie = callback.headers.get("set-cookie")!.split(";")[0];
    const session = await (await send("auth/session", { headers: { Cookie: cookie } })).json();
    expect(session.authenticated).toBe(true);
    return { Cookie: cookie, Origin: origin, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" };
  }
  const badHost = () => new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${base}/api/activity`, { headers: { Host: "untrusted.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on("error", reject);
    request.end();
  });
  return { send, login, sdk, emitter, badHost };
}

describe("local GitHub activity HTTP integration", () => {
  it("initializes test snapshots explicitly and imports complete state without changing identities", () => {
    const sdk = initialState("sdk", "snapshot", sdkSnapshot());
    const emitter = initialState("emitter", "snapshot", emitterSnapshot());
    expect(sdk.feed.events).toHaveLength(1);
    expect(emitter.feed.events).toHaveLength(0);
    expect(emitter.feed.collectedAt).toBe(time);
    expect(initialState("sdk", "import", sdk)).toEqual(sdk);
    expect(initialState("emitter", "import", emitter)).toEqual(emitter);
    expect(() => initialState("sdk", "import", sdk.feed)).toThrow("invalid");
    expect(() => initialState("emitter", "import", emitter.feed)).toThrow("invalid");
  });

  it("serves public feeds but rejects unauthenticated writes, collector reads and cross-origin requests", async () => {
    const { send, sdk, badHost } = await setup();
    expect((await send("activity")).status).toBe(200);
    expect((await send("emitter-activity")).status).toBe(200);
    expect((await send("activity/baseline")).status).toBe(401);
    expect((await send("activity/baseline", { headers: { "x-functions-key": ingestKey } })).status).toBe(200);
    const body = JSON.stringify({ generation: sdk.feed.generation, repository, pullRequestNumber: 1, throughSequence: 1 });
    expect((await send("activity/ack", { method: "POST", headers: { Origin: origin }, body })).status).toBe(401);
    expect((await send("activity/ack", { method: "POST", headers: { Origin: "https://untrusted.example" }, body })).status).toBe(403);
    expect(await badHost()).toBe(403);
    expect((await send("activity", { method: "OPTIONS" })).status).toBe(405);
  });

  it("signs in, saves/restores shared SDK and emitter state, and invalidates logout", async () => {
    const { send, login, sdk, emitter } = await setup();
    const headers = await login();
    const ack = await send("activity/ack", { method: "POST", headers,
      body: JSON.stringify({ generation: sdk.feed.generation, repository, pullRequestNumber: 1, throughSequence: 1 }) });
    expect(ack.status).toBe(200);
    const result = await ack.json();
    expect(result.feed.events[0].readAt).not.toBeNull();
    const anotherBrowser = await (await send("activity")).json();
    expect(anotherBrowser.events[0].readAt).toBe(result.feed.events[0].readAt);
    const restored = await send("activity/restore", { method: "POST", headers,
      body: JSON.stringify({ generation: sdk.feed.generation, acknowledgementIds: [result.acknowledgementId] }) });
    expect((await restored.json()).feed.events[0].readAt).toBeNull();
    const emitterAck = await send("emitter-activity/ack", { method: "POST", headers,
      body: JSON.stringify({ generation: emitter.feed.generation, number: 2, throughSequence: 1 }) });
    expect(emitterAck.status).toBe(200);
    expect((await emitterAck.json()).feed.events[0].readAt).not.toBeNull();
    expect((await send("auth/logout", { method: "POST", headers })).status).toBe(200);
    expect((await (await send("auth/session", { headers })).json()).authenticated).toBe(false);
    expect((await send("activity/restore", { method: "POST", headers, body: "{}" })).status).toBe(401);
  });

  it("preserves activity collected after the displayed acknowledgement boundary", async () => {
    const { send, login, sdk } = await setup();
    const headers = await login();
    const snapshot = sdkSnapshot("head-2", new Date(Date.parse(time) + 60_000).toISOString());
    expect((await send("activity/ingest", { method: "POST",
      headers: { "x-functions-key": ingestKey, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, inactivePullRequests: [] }) })).status).toBe(200);
    const result = await (await send("activity/ack", { method: "POST", headers,
      body: JSON.stringify({ generation: sdk.feed.generation, repository, pullRequestNumber: 1, throughSequence: 1 }) })).json();
    expect(result.feed.events.map((event: { readAt: string | null }) => event.readAt !== null)).toEqual([true, false]);
  });

  it("rejects wrong CSRF tokens and bounds mutation bodies without revealing credentials", async () => {
    const { send, login } = await setup();
    const headers = await login();
    expect((await send("activity/ack", { method: "POST", headers: { ...headers, "x-csrf-token": "wrong" }, body: "{}" })).status).toBe(403);
    expect((await send("activity/ack", { method: "POST", headers, body: JSON.stringify({ extra: "x".repeat(20_000) }) })).status).toBe(413);
    expect((await send("activity/ack", { method: "POST", headers, body: "invalid" })).status).toBe(400);
  });
});
