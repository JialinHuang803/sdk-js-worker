import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, type GitHubClient } from "../api/src/github/client";
import { createGitHubState, MAX_STATE_BYTES } from "../api/src/github/blob";
import { createState } from "../api/src/engine";
import { updateState } from "../api/src/store";
import { createEmitterState } from "../api/src/emitter-engine";
import { updateEmitterState } from "../api/src/emitter-store";

const config = { repository: "example/state", branch: "dashboard-state", allowPublic: false };
const root = "/repos/example/state";
function gitHub(privateRepo = true) {
  const files = new Map<string, string>();
  const sha = (text: string) => createHash("sha1").update(text).digest("hex");
  const request = vi.fn<GitHubClient["request"]>(async (path, init) => {
    if (path === `${root}/`) return Response.json({ private: privateRepo, default_branch: "main" });
    if (path === `${root}/git/ref/heads/dashboard-state`) return Response.json({ ref: "refs/heads/dashboard-state" });
    const file = path.split("?")[0];
    const current = files.get(file);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      expect(body.branch).toBe("dashboard-state");
      if ((current ? sha(current) : undefined) !== body.sha) return Response.json({}, { status: 409 });
      files.set(file, Buffer.from(body.content, "base64").toString());
      return Response.json({}, { status: 200 });
    }
    return current === undefined ? Response.json({}, { status: 404 }) :
      Response.json({ type: "file", encoding: "base64", sha: sha(current),
        size: Buffer.byteLength(current), content: Buffer.from(current).toString("base64") });
  });
  return { files, client: { request }, request };
}

describe("GitHub state branch", () => {
  it("requires explicit initialization, never silently resetting a missing state file", async () => {
    const mock = gitHub();
    const storage = createGitHubState(mock.client, config);
    await expect(storage.blob("sdk").read()).rejects.toThrow("missing");
    expect(await storage.blob("sdk", true).read()).toBeNull();
    await storage.blob("sdk", true).write(JSON.stringify(createState()), null);
    expect(await storage.blob("sdk").read()).not.toBeNull();
    await expect(storage.blob("sdk").write("{}", null)).rejects.toThrow("initialized");
  });

  it("does not treat an inaccessible repository or deleted branch as empty state", async () => {
    const mock = gitHub();
    mock.request.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(createGitHubState(mock.client, config).blob("sdk", true).read()).rejects.toThrow("unavailable");
    const branchMissing: GitHubClient = {
      request: async (path) => path === `${root}/` ?
        Response.json({ private: true, default_branch: "main" }) : Response.json({}, { status: 404 }),
    };
    await expect(createGitHubState(branchMissing, config).blob("sdk", true).read()).rejects.toThrow("branch");
  });

  it("requires opt-in for public Git history and never writes to the default branch", async () => {
    await expect(createGitHubState(gitHub(false).client, config).blob("sdk").read()).rejects.toThrow("private");
    await expect(createGitHubState(gitHub().client, { ...config, branch: "main" }).blob("sdk").read())
      .rejects.toThrow("default branch");
    expect(await createGitHubState(gitHub(false).client, { ...config, allowPublic: true }).blob("sdk", true).read())
      .toBeNull();
  });

  it("retries concurrent updates without losing either SDK or emitter changes", async () => {
    const mock = gitHub();
    mock.files.set(`${root}/contents/activity/sdk.json`, JSON.stringify(createState()));
    mock.files.set(`${root}/contents/activity/emitter.json`, JSON.stringify(createEmitterState()));
    const storage = createGitHubState(mock.client, config);
    await Promise.all([
      updateState(storage.blob("sdk"), (state) => { state.rate.count++; }),
      updateState(storage.blob("sdk"), (state) => { state.rate.count++; }),
      updateEmitterState(storage.blob("emitter"), (state) => { state.rate.count++; }),
    ]);
    expect(JSON.parse((await storage.blob("sdk").read())!.text).rate.count).toBe(2);
    expect(JSON.parse((await storage.blob("emitter").read())!.text).rate.count).toBe(1);
  });

  it("rejects corrupt and oversized history rather than resetting it", async () => {
    const mock = gitHub();
    mock.files.set(`${root}/contents/activity/sdk.json`, "not JSON");
    const blob = createGitHubState(mock.client, config).blob("sdk");
    await expect(updateState(blob, () => {})).rejects.toThrow("unreadable");
    await expect(blob.write("x".repeat(MAX_STATE_BYTES + 1), "a".repeat(40))).rejects.toThrow("archival");
    expect(mock.files.get(`${root}/contents/activity/sdk.json`)).toBe("not JSON");
  });

  it("propagates rate limits instead of pretending an acknowledgement saved", async () => {
    const mock = gitHub();
    const storage = createGitHubState(mock.client, config);
    await storage.blob("sdk", true).read();
    mock.request.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    await expect(storage.blob("sdk").write("{}", "a".repeat(40))).rejects.toThrow("write failed");
  });
});

describe("GitHub App installation credentials", () => {
  it("signs a short-lived JWT and scopes/caches the installation token", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    let issuances = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("Authorization")!;
      if (url.endsWith("/access_tokens")) {
        issuances++;
        const jwt = auth.slice("Bearer ".length);
        const [header, payload, signature] = jwt.split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims.exp - claims.iat).toBe(600);
        expect(claims.iss).toBe("123");
        expect(JSON.parse(String(init?.body))).toEqual({ repositories: ["state"], permissions: { contents: "write" } });
        return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      expect(auth).toBe("Bearer installation-token");
      expect(init?.redirect).toBe("error");
      return Response.json({});
    });
    const client = createGitHubClient({ appId: "123", installationId: "456", privateKey, repository: config.repository }, fetcher);
    await Promise.all([client.request(`${root}/`), client.request(`${root}/git/ref/heads/dashboard-state`)]);
    expect(issuances).toBe(1);
    await expect(client.request("/repos/elsewhere/code/")).rejects.toThrow("outside");
  });

  it("discards rejected tokens without automatically replaying a write", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    let issued = 0, writes = 0;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("/access_tokens")) {
        issued++;
        return Response.json({ token: `token-${issued}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      writes++;
      return Response.json({}, { status: writes === 1 ? 401 : 200 });
    };
    const client = createGitHubClient({ appId: "123", installationId: "456", privateKey, repository: config.repository }, fetcher);
    expect((await client.request(`${root}/contents/activity/sdk.json`, { method: "PUT", body: "{}" })).status).toBe(401);
    expect(writes).toBe(1);
    expect((await client.request(`${root}/`)).status).toBe(200);
    expect(issued).toBe(2);
  });
});
