import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  ActivityError, acknowledge, ingest, parseAcknowledge, parseIngest, parseRestore, pruneReadActivities, restore,
} from "./engine";
import { updateState, type StateBlob } from "./store";
import {
  acknowledgeEmitter, ingestEmitter, parseEmitterAcknowledge, parseEmitterIngest,
  parseEmitterRestore, pruneEmitterReadActivities, restoreEmitter,
} from "./emitter-engine";
import { updateEmitterState } from "./emitter-store";
import { publicActivityFeed } from "./public-feed";

const cachedBlobs = new Map<string, StateBlob>();
function blob(name = "state.json"): StateBlob {
  const cached = cachedBlobs.get(name);
  if (cached) return cached;
  const account = process.env.ACTIVITY_STORAGE_ACCOUNT;
  if (!account || !/^[a-z0-9]{3,24}$/.test(account)) {
    throw new Error("ACTIVITY_STORAGE_ACCOUNT is not configured.");
  }
  const container = process.env.ACTIVITY_STORAGE_CONTAINER ?? "activity";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) {
    throw new Error("ACTIVITY_STORAGE_CONTAINER is invalid.");
  }
  const client = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential(),
    { retryOptions: { maxTries: 3, tryTimeoutInMs: 10_000 } },
  ).getContainerClient(container).getBlockBlobClient(name);
  const result: StateBlob = {
    async read() {
      try {
        const response = await client.download();
        if (!response.etag || !response.readableStreamBody) throw new Error("Incomplete state download.");
        const chunks: Buffer[] = [];
        for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
        return { text: Buffer.concat(chunks).toString("utf8"), etag: response.etag };
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error &&
            error.statusCode === 404 && "code" in error && error.code === "BlobNotFound") return null;
        throw error;
      }
    },
    async write(text, etag) {
      await client.upload(text, Buffer.byteLength(text), {
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    },
  };
  cachedBlobs.set(name, result);
  return result;
}

async function body(request: HttpRequest, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ActivityError(415, "Use application/json.");
  }
  if (!request.body) throw new ActivityError(400, "A JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ActivityError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ActivityError(400, "Invalid JSON."); }
}

function handler(
  action: (request: HttpRequest) => Promise<unknown>,
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  return async (request, context) => {
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    try {
      return { status: 200, jsonBody: await action(request), headers };
    } catch (error) {
      if (error instanceof ActivityError) {
        return { status: error.status, jsonBody: { error: error.message },
          headers: error.status === 429 ? { ...headers, "Retry-After": "60" } : headers };
      }
      context.error("Activity request failed; persisted state was not reset.");
      return { status: 503, jsonBody: { error: "Activity storage is unavailable. Retry later." }, headers };
    }
  };
}

app.http("activity", {
  methods: ["GET"], authLevel: "anonymous", route: "activity",
  handler: handler(async () => publicActivityFeed((await updateState(
    blob(), (state) => pruneReadActivities(state, new Date().toISOString()),
  )).state.feed)),
});
app.http("activity-baseline", {
  methods: ["GET"], authLevel: "function", route: "activity/baseline",
  handler: handler(async () => {
    const { state } = await updateState(blob(), (state) => pruneReadActivities(state, new Date().toISOString()));
    return { snapshot: state.snapshot, trackedPullRequests: state.feed.pullRequests };
  }),
});
app.http("activity-ingest", {
  methods: ["POST"], authLevel: "function", route: "activity/ingest",
  handler: handler(async (request) => {
    const input = parseIngest(await body(request, 4 * 1024 * 1024));
    const { state } = await updateState(blob(), (state) => ingest(state, input, new Date().toISOString()));
    return { collectedAt: state.feed.collectedAt, revision: state.feed.revision };
  }),
});
app.http("activity-ack", {
  methods: ["POST"], authLevel: "anonymous", route: "activity/ack",
  handler: handler(async (request) => {
    const input = parseAcknowledge(await body(request, 16 * 1024));
    const { state, result } = await updateState(blob(), (state) => acknowledge(state, input, new Date().toISOString()));
    return { feed: publicActivityFeed(state.feed), acknowledgementId: result };
  }),
});
app.http("activity-restore", {
  methods: ["POST"], authLevel: "anonymous", route: "activity/restore",
  handler: handler(async (request) => {
    const input = parseRestore(await body(request, 16 * 1024));
    const { state } = await updateState(blob(), (state) => restore(state, input, new Date().toISOString()));
    return { feed: publicActivityFeed(state.feed), acknowledgementId: null };
  }),
});

app.http("emitter-activity", {
  methods: ["GET"], authLevel: "anonymous", route: "emitter-activity",
  handler: handler(async () => publicActivityFeed((await updateEmitterState(
    blob("emitter-state.json"), (state) => pruneEmitterReadActivities(state, new Date().toISOString()),
  )).state.feed)),
});
app.http("emitter-activity-baseline", {
  methods: ["GET"], authLevel: "function", route: "emitter-activity/baseline",
  handler: handler(async () => {
    const { state } = await updateEmitterState(
      blob("emitter-state.json"), (state) => pruneEmitterReadActivities(state, new Date().toISOString()),
    );
    return { snapshot: state.snapshot?.activity ? state.snapshot : null };
  }),
});
app.http("emitter-activity-ingest", {
  methods: ["POST"], authLevel: "function", route: "emitter-activity/ingest",
  handler: handler(async (request) => {
    const input = parseEmitterIngest(await body(request, 4 * 1024 * 1024));
    const { state } = await updateEmitterState(
      blob("emitter-state.json"), (state) => ingestEmitter(state, input, new Date().toISOString()),
    );
    return { collectedAt: state.feed.collectedAt, revision: state.feed.revision };
  }),
});
app.http("emitter-activity-ack", {
  methods: ["POST"], authLevel: "anonymous", route: "emitter-activity/ack",
  handler: handler(async (request) => {
    const input = parseEmitterAcknowledge(await body(request, 16 * 1024));
    const { state, result } = await updateEmitterState(
      blob("emitter-state.json"), (state) => acknowledgeEmitter(state, input, new Date().toISOString()),
    );
    return { feed: publicActivityFeed(state.feed), acknowledgementId: result };
  }),
});
app.http("emitter-activity-restore", {
  methods: ["POST"], authLevel: "anonymous", route: "emitter-activity/restore",
  handler: handler(async (request) => {
    const input = parseEmitterRestore(await body(request, 16 * 1024));
    const { state } = await updateEmitterState(
      blob("emitter-state.json"), (state) => restoreEmitter(state, input, new Date().toISOString()),
    );
    return { feed: publicActivityFeed(state.feed), acknowledgementId: null };
  }),
});
