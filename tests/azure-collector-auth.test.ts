import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubCollectorAuth, readCollectorAuthConfig } from "../api/src/azure/collector-auth";

const origin = "https://dashboard.example";
const env = { ACTIVITY_COLLECTOR_AUTH: "github-oidc", ACTIVITY_ORIGIN: origin };
const config = readCollectorAuthConfig(env)!;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const auth = createGithubCollectorAuth(config, {
  keys: [{ ...key.publicKey.export({ format: "jwk" }), kty: "RSA", kid: "test", alg: "RS256", use: "sig" }],
});
function claims() {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com", aud: config.audience,
    sub: "repo:JialinHuang803@139532647/sdk-js-worker@1370752026:ref:refs/heads/main",
    repository: config.repository,
    repository_id: config.repositoryId, repository_owner_id: config.repositoryOwnerId,
    ref: "refs/heads/main",
    workflow_ref: `${config.repository}/.github/workflows/collect-and-deploy.yml@refs/heads/main`,
    event_name: "schedule", exp: now + 300, iat: now - 10, nbf: now - 10,
  };
}
function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, privateKey = key.privateKey) {
  const encoded = [JSON.stringify({ alg: "RS256", kid: "test", ...header }), JSON.stringify({ ...claims(), ...changes })]
    .map((value) => Buffer.from(value).toString("base64url")).join(".");
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
}
const verify = (jwt: string) => auth.requireCollector({ authorization: `Bearer ${jwt}` }, "activity");

describe("GitHub collector OIDC authentication", () => {
  it("opts in explicitly and validates a coherent immutable repository configuration", () => {
    expect(readCollectorAuthConfig({})).toBeUndefined();
    expect(readCollectorAuthConfig({ ACTIVITY_COLLECTOR_AUTH: "disabled" })).toBeUndefined();
    expect(config).toEqual({ audience: `${origin}/api/collector`, repository: "JialinHuang803/sdk-js-worker",
      repositoryId: "1370752026", repositoryOwnerId: "139532647" });
    for (const changes of [
      { ACTIVITY_COLLECTOR_AUTH: "" }, { ACTIVITY_COLLECTOR_AUTH: "function-key" },
      { ACTIVITY_ORIGIN: `${origin}/` }, { ACTIVITY_ORIGIN: "http://dashboard.example" },
      { ACTIVITY_ORIGIN: "https://user:pass@dashboard.example" },
      { ACTIVITY_COLLECTOR_REPOSITORY: "Other/repo" },
      { ACTIVITY_COLLECTOR_REPOSITORY: "Other/repo", ACTIVITY_COLLECTOR_REPOSITORY_ID: "123",
        ACTIVITY_COLLECTOR_REPOSITORY_OWNER_ID: "invalid" },
    ]) expect(() => readCollectorAuthConfig({ ...env, ...changes })).toThrow();
    expect(readCollectorAuthConfig({ ...env, ACTIVITY_COLLECTOR_REPOSITORY: "Other/repo",
      ACTIVITY_COLLECTOR_REPOSITORY_ID: "123", ACTIVITY_COLLECTOR_REPOSITORY_OWNER_ID: "456" }))
      .toMatchObject({ repository: "Other/repo", repositoryId: "123", repositoryOwnerId: "456" });
  });

  it("verifies actual RSA signatures and scopes both scheduled and manual jobs to their feature", async () => {
    await expect(verify(token())).resolves.toBeUndefined();
    await expect(verify(token({ event_name: "workflow_dispatch" }))).resolves.toBeUndefined();
    const issued = Math.floor(Date.now() / 1000);
    await expect(verify(token({ iat: issued, nbf: issued - 300, exp: issued + 300 }))).resolves.toBeUndefined();
    const emitter = token({ workflow_ref: `${config.repository}/.github/workflows/collect-emitter.yml@refs/heads/main` });
    await expect(auth.requireCollector({ authorization: `Bearer ${emitter}` }, "emitter-activity")).resolves.toBeUndefined();
    await expect(verify(emitter)).rejects.toMatchObject({ status: 403 });
    await expect(auth.requireCollector({ authorization: `Bearer ${token()}` }, "emitter-activity")).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { iss: "https://attacker.example" }, { aud: "https://other.example/api/collector" },
    { aud: [config.audience] }, { exp: 1 }, { exp: undefined }, { nbf: undefined }, { iat: undefined },
    { sub: undefined }, { exp: "9999999999" }, { nbf: 9999999999 }, { iat: 9999999999 },
    { iat: Math.floor(Date.now() / 1000) - 601 },
  ])("rejects missing or invalid registered claims: %j", async (changes) => {
    await expect(verify(token(changes))).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    { sub: "repo:JialinHuang803/sdk-js-worker:ref:refs/heads/main" },
    { sub: "repo:JialinHuang803@1/sdk-js-worker@1370752026:ref:refs/heads/main" },
    { sub: "repo:JialinHuang803@139532647/sdk-js-worker@1:ref:refs/heads/main" },
    { sub: "repo:JialinHuang803/sdk-js-worker:environment:github-pages" },
    { sub: "repo:JialinHuang803/sdk-js-worker:ref:refs/heads/other" },
    { ref: "refs/heads/other" }, { repository: "attacker/sdk-js-worker" },
    { repository_id: "1" }, { repository_owner_id: "1" }, { repository_id: 1370752026 },
    { repository_owner_id: undefined }, { workflow_ref: "arbitrary" },
    { workflow_ref: `${config.repository}/.github/workflows/collect-and-deploy.yml@refs/heads/other` },
    { event_name: "push" }, { event_name: "pull_request" }, { event_name: "pull_request_target" },
    { event_name: ["schedule"] },
  ])("rejects signed but unauthorized identities: %j", async (changes) => {
    await expect(verify(token(changes))).rejects.toMatchObject({ status: 403 });
  });

  it("rejects forged signatures, algorithms, key URLs, malformed tokens and legacy credentials", async () => {
    await expect(verify(token({}, {}, wrongKey.privateKey))).rejects.toMatchObject({ status: 401 });
    await expect(verify(token({}, { jku: "https://attacker.example/jwks", kid: "attacker" }, wrongKey.privateKey)))
      .rejects.toMatchObject({ status: 401 });
    for (const alg of ["none", "HS256", "RS512"]) {
      await expect(verify(token({}, { alg }))).rejects.toMatchObject({ status: 401 });
    }
    for (const authorization of [undefined, "", "Basic abc", "Bearer abc", "Bearer a.b.c", "Bearer " + "a".repeat(17000)]) {
      await expect(auth.requireCollector({ authorization }, "activity")).rejects.toMatchObject({ status: 401 });
    }
    await expect(auth.requireCollector({ "x-functions-key": "old-key" }, "activity")).rejects.toMatchObject({ status: 401 });
    await expect(auth.requireCollector({ authorization: `Bearer ${token()}`, cookie: "browser=session" }, "activity"))
      .rejects.toMatchObject({ status: 401 });
    await expect(auth.requireCollector({ authorization: `Bearer ${token()}`, "x-functions-key": "old-key" }, "activity"))
      .rejects.toMatchObject({ status: 401 });
  });

  it("distinguishes unknown signing keys from unusable trusted JWKS without exposing internals", async () => {
    await expect(verify(token({}, { kid: "unknown" }))).rejects.toMatchObject({
      status: 401, message: "Invalid GitHub collector token.",
    });
    const unavailable = createGithubCollectorAuth(config, { keys: [{ kty: "RSA", kid: "test", alg: "RS256" }] });
    await expect(unavailable.requireCollector({ authorization: `Bearer ${token()}` }, "activity")).rejects.toMatchObject({
      status: 503, message: "Collector authentication is unavailable.",
    });
  });
});
