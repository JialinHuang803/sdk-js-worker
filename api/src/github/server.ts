import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  ActivityError, acknowledge, ingest, parseAcknowledge, parseIngest, parseRestore, pruneReadActivities, restore,
} from "../engine";
import {
  acknowledgeEmitter, ingestEmitter, parseEmitterAcknowledge, parseEmitterIngest,
  parseEmitterRestore, pruneEmitterReadActivities, restoreEmitter,
} from "../emitter-engine";
import { updateState, type StateBlob } from "../store";
import { updateEmitterState } from "../emitter-store";
import { publicActivityFeed } from "../public-feed";
import type { createAuth } from "./auth";

interface Dependencies {
  auth: ReturnType<typeof createAuth>;
  sdk: StateBlob;
  emitter: StateBlob;
  origin: string;
  ingestKey: string;
}

function matches(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ActivityError(415, "Use application/json.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new ActivityError(413, "Request is too large."));
      } else chunks.push(chunk);
    });
    request.on("error", () => reject(new ActivityError(400, "Request body was interrupted.")));
    request.on("end", () => {
      if (size > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ActivityError(400, "Invalid JSON.")); }
    });
  });
}

export function createActivityServer(deps: Dependencies) {
  let minute = 0, requests = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const redirect = (location: string, cookie: string) => {
      response.writeHead(302, { Location: location, "Set-Cookie": cookie });
      response.end();
    };
    try {
      const host = request.headers.host;
      if (host !== new URL(deps.origin).host && host !== `127.0.0.1:${request.socket.localPort}`) {
        throw new ActivityError(403, "Unrecognized request host.");
      }
      const currentMinute = Math.floor(Date.now() / 60_000);
      if (minute !== currentMinute) { minute = currentMinute; requests = 0; }
      if (++requests > 300) throw new ActivityError(429, "Local API request limit reached. Retry later.");
      const url = new URL(request.url ?? "/", deps.origin);
      const path = url.pathname;
      const method = request.method;
      const cookie = request.headers.cookie;
      const csrf = request.headers["x-csrf-token"];
      const authorizeWrite = () => {
        if (request.headers.origin !== deps.origin) throw new ActivityError(403, "Untrusted request origin.");
        return deps.auth.requireMutation(cookie, typeof csrf === "string" ? csrf : undefined);
      };
      if (path === "/api/health" && method === "GET") {
        return json({ status: "running", mode: "github-local" });
      }
      if (path === "/api/auth/session" && method === "GET") return json(deps.auth.session(cookie));
      if (path === "/api/auth/login" && method === "GET") {
        const result = deps.auth.start();
        return redirect(result.location, result.cookie);
      }
      if (path === "/api/auth/callback" && method === "GET") {
        const result = await deps.auth.callback(url, cookie);
        return redirect(result.location, result.cookie);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        authorizeWrite();
        response.setHeader("Set-Cookie", deps.auth.logout(cookie, typeof csrf === "string" ? csrf : undefined));
        return json({ authenticated: false, login: null, csrfToken: null });
      }
      const route = /^\/api\/(activity|emitter-activity)(?:\/(baseline|ingest|ack|restore))?$/.exec(path);
      if (!route) throw new ActivityError(404, "Route not found.");
      const [, feature, action] = route;
      if ((action === undefined || action === "baseline") ? method !== "GET" : method !== "POST") {
        throw new ActivityError(405, "Method not allowed.");
      }
      let reader: string | undefined;
      if (action === "baseline" || action === "ingest") {
        const key = request.headers["x-functions-key"];
        if (typeof key !== "string" || !matches(key, deps.ingestKey)) {
          throw new ActivityError(401, "Collector authentication is required.");
        }
      } else if (action) reader = authorizeWrite();
      const now = new Date().toISOString();
      const input = method === "POST" ? await readBody(request, action === "ingest" ? 4 * 1024 * 1024 : 16 * 1024) : null;
      if (feature === "activity") {
        if (action === "ack") {
          const parsed = parseAcknowledge(input);
          const { state, result } = await updateState(deps.sdk, (state) => acknowledge(state, parsed, now, reader));
          return json({ feed: state.feed, acknowledgementId: result });
        }
        if (action === "restore") {
          const parsed = parseRestore(input);
          const { state } = await updateState(deps.sdk, (state) => restore(state, parsed, now));
          return json({ feed: state.feed, acknowledgementId: null });
        }
        if (action === "ingest") {
          const parsed = parseIngest(input);
          const { state } = await updateState(deps.sdk, (state) => ingest(state, parsed, now));
          return json({ collectedAt: state.feed.collectedAt, revision: state.feed.revision });
        }
        const { state } = await updateState(deps.sdk, (state) => pruneReadActivities(state, now));
        return json(action === "baseline" ?
          { snapshot: state.snapshot, trackedPullRequests: state.feed.pullRequests } :
          deps.auth.session(cookie).authenticated ? state.feed : publicActivityFeed(state.feed));
      }
      if (action === "ack") {
        const parsed = parseEmitterAcknowledge(input);
        const { state, result } = await updateEmitterState(deps.emitter, (state) => acknowledgeEmitter(state, parsed, now, reader));
        return json({ feed: state.feed, acknowledgementId: result });
      }
      if (action === "restore") {
        const parsed = parseEmitterRestore(input);
        const { state } = await updateEmitterState(deps.emitter, (state) => restoreEmitter(state, parsed, now));
        return json({ feed: state.feed, acknowledgementId: null });
      }
      if (action === "ingest") {
        const parsed = parseEmitterIngest(input);
        const { state } = await updateEmitterState(deps.emitter, (state) => ingestEmitter(state, parsed, now));
        return json({ collectedAt: state.feed.collectedAt, revision: state.feed.revision });
      }
      const { state } = await updateEmitterState(deps.emitter, (state) => pruneEmitterReadActivities(state, now));
      return json(action === "baseline" ? { snapshot: state.snapshot?.activity ? state.snapshot : null } :
        deps.auth.session(cookie).authenticated ? state.feed : publicActivityFeed(state.feed));
    } catch (error) {
      if (error instanceof ActivityError) {
        if (error.status === 429) response.setHeader("Retry-After", "60");
        json({ error: error.message }, error.status);
      } else {
        console.error("GitHub activity request failed; no state reset was attempted.");
        json({ error: "GitHub activity service is unavailable. Reload before retrying." }, 503);
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
