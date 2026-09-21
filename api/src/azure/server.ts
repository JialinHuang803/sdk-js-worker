import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ActivityError, acknowledge, ingest, parseIngest, parseAcknowledge, parseRestore, pruneReadActivities, restore, validateStoredState } from "../engine";
import { acknowledgeEmitter, ingestEmitter, parseEmitterIngest, parseEmitterAcknowledge, parseEmitterRestore, pruneEmitterReadActivities, restoreEmitter, validateEmitterState } from "../emitter-engine";
import { updateState, type StateBlob } from "../store";
import { updateEmitterState } from "../emitter-store";
import type { createEntraAuth } from "./auth";
import { requireExistingState } from "./blob";
import type { createGithubCollectorAuth } from "./collector-auth";

interface Dependencies {
  auth: ReturnType<typeof createEntraAuth>;
  collectorAuth?: ReturnType<typeof createGithubCollectorAuth>;
  origin: string;
  sdk: StateBlob;
  emitter: StateBlob;
  staticDirectory: string;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

async function readBody(request: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ActivityError(413, "Request is too large.");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ActivityError(400, "Invalid JSON."); }
}

export function createAzureActivityServer(deps: Dependencies) {
  const sdk = requireExistingState(deps.sdk), emitter = requireExistingState(deps.emitter);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      let path: string;
      try { path = decodeURIComponent((request.url ?? "/").split("?")[0]); }
      catch { throw new ActivityError(400, "Invalid request path."); }
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") ||
        path.includes("\0") || path.split("/").some((part) => part.startsWith("."))) {
        throw new ActivityError(404, "Route not found.");
      }
      const method = request.method;
      const collectorRoute = /^\/api\/(activity|emitter-activity)\/(baseline|ingest)$/.exec(path);
      if (collectorRoute) {
        const feature = collectorRoute[1] === "activity" ? "activity" : "emitter-activity";
        const action = collectorRoute[2];
        if (method !== (action === "baseline" ? "GET" : "POST")) throw new ActivityError(405, "Method not allowed.");
        if (!deps.collectorAuth) {
          if (!request.headers.authorization) throw new ActivityError(401, "A GitHub collector bearer token is required.");
          throw new ActivityError(503, "Hosted collector integration is disabled.");
        }
        await deps.collectorAuth.requireCollector(request.headers, feature);
        if (action === "baseline") {
          if (feature === "activity") {
            const state = validateStoredState(JSON.parse((await sdk.read())!.text));
            return json({ snapshot: state.snapshot, trackedPullRequests: state.feed.pullRequests });
          }
          const state = validateEmitterState(JSON.parse((await emitter.read())!.text));
          return json({ snapshot: state.snapshot?.activity ? state.snapshot : null });
        }
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new ActivityError(415, "Use application/json.");
        }
        const input = await readBody(request, 4 * 1024 * 1024);
        const now = new Date().toISOString();
        if (feature === "activity") {
          const parsed = parseIngest(input);
          const { state } = await updateState(sdk, (state) => {
            const previous = state.snapshot;
            const next = parsed.snapshot;
            // The legacy SDK engine ignores old timestamps; hosted collectors must detect lost baselines.
            const retry = previous && JSON.stringify(next) === JSON.stringify(previous);
            if (!retry && ((previous && Date.parse(next.generatedAt) <= Date.parse(previous.generatedAt)) ||
              next.inbox.comparisonFrom !== (previous?.generatedAt ?? null))) {
              throw new ActivityError(409, "Activity baseline changed. Collect again from the shared baseline.");
            }
            ingest(state, parsed, now);
          });
          return json({ collectedAt: state.feed.collectedAt, revision: state.feed.revision });
        }
        const parsed = parseEmitterIngest(input);
        const { state } = await updateEmitterState(emitter, (state) => ingestEmitter(state, parsed, now));
        return json({ collectedAt: state.feed.collectedAt, revision: state.feed.revision });
      }
      // A bearer token is never an alternate login, even when a browser cookie is also present.
      if (request.headers.authorization) throw new ActivityError(401, "Browser session authentication is required.");
      const redirect = (location: string, cookies: string[] = []) => {
        response.writeHead(302, { Location: location, ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
        response.end();
      };
      if (path === "/api/auth/login" && method === "GET") {
        const result = await deps.auth.start();
        return redirect(result.location, result.cookies);
      }
      if (path === "/api/auth/callback" && method === "GET") {
        const result = await deps.auth.callback(new URL(request.url!, deps.origin), request.headers.cookie);
        return redirect(result.location, result.cookies);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        await deps.auth.requireMutation(request.headers, false);
        await readBody(request);
        response.setHeader("Set-Cookie", await deps.auth.logout(request.headers));
        return json({ authenticated: false, login: null, csrfToken: null });
      }
      try { await deps.auth.requireSession(request.headers.cookie); }
      catch (error) {
        if (error instanceof ActivityError && error.status === 401 && path === "/" && method === "GET") {
          return redirect("/api/auth/login");
        }
        throw error;
      }
      if (path === "/api/auth/session" && method === "GET") {
        return json(await deps.auth.session(request.headers.cookie));
      }
      if (path === "/api/health" && method === "GET") return json({ status: "running", mode: "entra-federated" });
      if (path.startsWith("/api/")) {
        const route = /^\/api\/(activity|emitter-activity)(?:\/(ack|restore))?$/.exec(path);
        if (!route) throw new ActivityError(404, "Route not found.");
        const [, feature, action] = route;
        if (method !== (action ? "POST" : "GET")) throw new ActivityError(405, "Method not allowed.");
        const actor = action ? await deps.auth.requireMutation(request.headers) : undefined;
        const input = action ? await readBody(request) : null;
        const now = new Date().toISOString();
        if (feature === "activity") {
          if (action === "ack") {
            const parsed = parseAcknowledge(input);
            const { state, result } = await updateState(sdk, (state) => acknowledge(state, parsed, now, actor!.displayName));
            return json({ feed: state.feed, acknowledgementId: result });
          }
          if (action === "restore") {
            const parsed = parseRestore(input);
            const { state } = await updateState(sdk, (state) => restore(state, parsed, now));
            return json({ feed: state.feed, acknowledgementId: null });
          }
          return json((await updateState(sdk, (state) => pruneReadActivities(state, now))).state.feed);
        }
        if (action === "ack") {
          const parsed = parseEmitterAcknowledge(input);
          const { state, result } = await updateEmitterState(emitter, (state) => acknowledgeEmitter(state, parsed, now, actor!.displayName));
          return json({ feed: state.feed, acknowledgementId: result });
        }
        if (action === "restore") {
          const parsed = parseEmitterRestore(input);
          const { state } = await updateEmitterState(emitter, (state) => restoreEmitter(state, parsed, now));
          return json({ feed: state.feed, acknowledgementId: null });
        }
        return json((await updateEmitterState(emitter, (state) => pruneEmitterReadActivities(state, now))).state.feed);
      }
      if (method !== "GET" && method !== "HEAD") throw new ActivityError(405, "Method not allowed.");
      if (path === "/data/sdk-prs.json" || path === "/data/emitter.json") {
        const state = path === "/data/sdk-prs.json"
          ? validateStoredState(JSON.parse((await sdk.read())!.text))
          : validateEmitterState(JSON.parse((await emitter.read())!.text));
        if (!state.snapshot) throw new ActivityError(503, "Activity snapshot is unavailable.");
        // Preserve timestamps: both dashboards already warn when canonical data is over 26 hours old.
        const body = JSON.stringify(state.snapshot);
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(method === "HEAD" ? undefined : body);
        return;
      }
      const root = await realpath(deps.staticDirectory);
      let file: string;
      try { file = await realpath(resolve(root, path === "/" ? "index.html" : path.slice(1))); }
      catch { throw new ActivityError(404, "File not found."); }
      const within = relative(root, file);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        throw new ActivityError(404, "File not found.");
      }
      const contentType = contentTypes[extname(file)];
      if (!contentType || !(await stat(file)).isFile()) throw new ActivityError(404, "File not found.");
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": body.byteLength });
      response.end(method === "HEAD" ? undefined : body);
    } catch (error) {
      if (error instanceof ActivityError) return json({ error: error.message }, error.status);
      console.error("Azure dashboard request failed; no state reset was attempted.");
      json({ error: "Activity storage or dashboard files are unavailable. No state was reset." }, 503);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
