import type { IncomingHttpHeaders } from "node:http";
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import { ActivityError } from "../engine";

const issuer = "https://token.actions.githubusercontent.com";
const branch = "refs/heads/main";
const workflows = {
  activity: "collect-and-deploy.yml",
  "emitter-activity": "collect-emitter.yml",
} as const;
export type CollectorFeature = keyof typeof workflows;

export interface CollectorAuthConfig {
  audience: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
}

export function readCollectorAuthConfig(env: NodeJS.ProcessEnv): CollectorAuthConfig | undefined {
  if (env.ACTIVITY_COLLECTOR_AUTH === undefined || env.ACTIVITY_COLLECTOR_AUTH === "disabled") return undefined;
  if (env.ACTIVITY_COLLECTOR_AUTH !== "github-oidc") throw new Error("ACTIVITY_COLLECTOR_AUTH is invalid.");
  const origin = env.ACTIVITY_ORIGIN ?? "";
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("ACTIVITY_ORIGIN must be an HTTPS origin.");
  }
  const overrides = [
    env.ACTIVITY_COLLECTOR_REPOSITORY, env.ACTIVITY_COLLECTOR_REPOSITORY_ID,
    env.ACTIVITY_COLLECTOR_REPOSITORY_OWNER_ID,
  ];
  if (overrides.some((value) => value !== undefined) && overrides.some((value) => value === undefined)) {
    throw new Error("All three ACTIVITY_COLLECTOR_REPOSITORY identity settings must be configured together.");
  }
  const [repository = "JialinHuang803/sdk-js-worker", repositoryId = "1370752026",
    repositoryOwnerId = "139532647"] = overrides;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[1-9]\d*$/.test(repositoryId) || !/^[1-9]\d*$/.test(repositoryOwnerId)) {
    throw new Error("Collector repository identity is invalid.");
  }
  return { audience: `${origin}/api/collector`, repository, repositoryId, repositoryOwnerId };
}

export function createGithubCollectorAuth(config: CollectorAuthConfig, trustedKeys?: JSONWebKeySet) {
  // Static keys are an injection boundary for offline tests, never configuration supplied by a request.
  const keys = trustedKeys ? createLocalJWKSet(trustedKeys) : createRemoteJWKSet(
    new URL(`${issuer}/.well-known/jwks`),
    { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
  );
  return {
    async requireCollector(headers: IncomingHttpHeaders, feature: CollectorFeature): Promise<void> {
      const authorization = headers.authorization;
      if (headers.cookie || headers["x-functions-key"] || !authorization ||
        authorization.length > 16 * 1024 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) {
        throw new ActivityError(401, "A GitHub collector bearer token is required.");
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(authorization.slice(7), keys, {
          algorithms: ["RS256"], issuer, audience: config.audience,
          requiredClaims: ["exp", "nbf", "iat", "sub"],
          maxTokenAge: "10 minutes",
        }));
      } catch (error) {
        if (error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed ||
          error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
          error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed ||
          error instanceof errors.JOSENotSupported || error instanceof errors.JWKSNoMatchingKey) {
          throw new ActivityError(401, "Invalid GitHub collector token.");
        }
        throw new ActivityError(503, "Collector authentication is unavailable.");
      }
      if (payload.aud !== config.audience) throw new ActivityError(401, "Invalid GitHub collector token.");
      if (payload.sub !== `repo:${config.repository}:ref:${branch}` ||
        payload.repository !== config.repository || payload.repository_id !== config.repositoryId ||
        payload.repository_owner_id !== config.repositoryOwnerId || payload.ref !== branch ||
        payload.workflow_ref !== `${config.repository}/.github/workflows/${workflows[feature]}@${branch}` ||
        !["schedule", "workflow_dispatch"].includes(String(payload.event_name))) {
        throw new ActivityError(403, "This workflow is not authorized for this collector.");
      }
    },
  };
}
