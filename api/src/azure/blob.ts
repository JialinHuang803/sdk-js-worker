import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type BlockBlobClient } from "@azure/storage-blob";
import { ActivityError } from "../engine";
import type { StateBlob } from "../store";

// Hosted reads must never trigger the shared engines' explicit initialization path.
export function requireExistingState(blob: StateBlob): StateBlob {
  return {
    async read() {
      const source = await blob.read();
      if (!source) throw new ActivityError(503, "Activity state is missing. No state was initialized or changed.");
      return source;
    },
    async write(text, etag) {
      if (!etag) throw new ActivityError(503, "An existing activity state ETag is required.");
      await blob.write(text, etag);
    },
  };
}

export function azureStateBlob(client: Pick<BlockBlobClient, "download" | "upload">): StateBlob {
  return requireExistingState({
    async read() {
      const response = await client.download();
      if (!response.etag || !response.readableStreamBody) throw new Error("Incomplete state download.");
      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
      return { text: Buffer.concat(chunks).toString("utf8"), etag: response.etag };
    },
    async write(text, etag) {
      await client.upload(text, Buffer.byteLength(text), {
        conditions: { ifMatch: etag! },
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    },
  });
}

export function createAzureState(env: NodeJS.ProcessEnv) {
  const account = env.ACTIVITY_STORAGE_ACCOUNT ?? "";
  const container = env.ACTIVITY_STORAGE_CONTAINER ?? "activity";
  if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error("ACTIVITY_STORAGE_ACCOUNT is invalid.");
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) {
    throw new Error("ACTIVITY_STORAGE_CONTAINER is invalid.");
  }
  const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential(), {
    retryOptions: { maxTries: 3, tryTimeoutInMs: 10_000 },
  });
  const client = service.getContainerClient(container);
  return {
    sdk: azureStateBlob(client.getBlockBlobClient("state.json")),
    emitter: azureStateBlob(client.getBlockBlobClient("emitter-state.json")),
  };
}
