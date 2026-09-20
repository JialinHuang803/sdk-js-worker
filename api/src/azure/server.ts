import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ActivityError, acknowledge, parseAcknowledge, parseRestore, pruneReadActivities, restore } from "../engine";
import { acknowledgeEmitter, parseEmitterAcknowledge, parseEmitterRestore, pruneEmitterReadActivities, restoreEmitter } from "../emitter-engine";
import { updateState, type StateBlob } from "../store";
import { updateEmitterState } from "../emitter-store";
import type { createEntraAuth } from "./auth";
import { requireExistingState } from "./blob";

interface Dependencies {
  auth: ReturnType<typeof createEntraAuth>;
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

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 16 * 1024) throw new ActivityError(413, "Request is too large.");
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
      try { deps.auth.requireSession(request.headers.cookie); }
      catch (error) {
        if (error instanceof ActivityError && error.status === 401 && path === "/" && method === "GET") {
          return redirect("/api/auth/login");
        }
        throw error;
      }
      if (path === "/api/auth/session" && method === "GET") {
        return json(deps.auth.session(request.headers.cookie));
      }
      if (path === "/api/auth/logout" && method === "POST") {
        deps.auth.requireMutation(request.headers);
        await readBody(request);
        response.setHeader("Set-Cookie", deps.auth.logout(request.headers));
        return json({ authenticated: false, login: null, csrfToken: null });
      }
      if (path === "/api/health" && method === "GET") return json({ status: "running", mode: "entra-federated" });
      if (path.startsWith("/api/")) {
        const route = /^\/api\/(activity|emitter-activity)(?:\/(baseline|ingest|ack|restore))?$/.exec(path);
        if (!route) throw new ActivityError(404, "Route not found.");
        const [, feature, action] = route;
        if (action === "baseline" || action === "ingest") {
          throw new ActivityError(503, "Hosted collector integration is disabled. This deployment does not collect activity.");
        }
        if (method !== (action ? "POST" : "GET")) throw new ActivityError(405, "Method not allowed.");
        const actor = action ? deps.auth.requireMutation(request.headers) : undefined;
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
