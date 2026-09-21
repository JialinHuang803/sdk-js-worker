import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { ActivityError } from "../engine";

export type RecordPurpose = "pending" | "sessions";
export interface StoredRecord { value: unknown; etag: string }
export interface SessionStore {
  read(purpose: RecordPurpose, key: string): Promise<StoredRecord | undefined>;
  create(purpose: RecordPurpose, key: string, value: unknown): Promise<boolean>;
  replace(purpose: RecordPurpose, key: string, value: unknown, etag: string): Promise<boolean>;
  remove(purpose: RecordPurpose, key: string, etag: string): Promise<boolean>;
}
export class InvalidSessionRecord extends Error {
  constructor(readonly etag?: string) { super("Invalid authentication record."); }
}
const MAX_PLAINTEXT = 768 * 1024;
const MAX_ENVELOPE = 1024 * 1024 + 1024;
const identifier = /^[A-Za-z0-9_-]{43}$/;
const unavailable = () => new ActivityError(503, "Authentication storage is unavailable.");

export function readSessionEncryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("ACTIVITY_SESSION_ENCRYPTION_KEY must be base64 encoding of 32 random bytes.");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("ACTIVITY_SESSION_ENCRYPTION_KEY must be base64 encoding of 32 random bytes.");
  }
  return key;
}

export function encryptedSessionStore(container: Pick<ContainerClient, "getBlockBlobClient">, key: Buffer): SessionStore {
  if (key.length !== 32) throw new Error("A 32-byte session encryption key is required.");
  const name = (purpose: RecordPurpose, id: string) => {
    if (!["pending", "sessions"].includes(purpose) || !identifier.test(id)) throw new InvalidSessionRecord();
    return `${purpose}/${id}.json`;
  };
  const encrypt = (purpose: RecordPurpose, id: string, value: unknown) => {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > MAX_PLAINTEXT) throw new InvalidSessionRecord();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`activity-auth:v1:${name(purpose, id)}`));
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64") });
  };
  const decrypt = (purpose: RecordPurpose, id: string, text: string): unknown => {
    try {
      if (Buffer.byteLength(text) > MAX_ENVELOPE) throw new InvalidSessionRecord();
      const record = JSON.parse(text);
      if (!record || record.version !== 1 || typeof record.nonce !== "string" ||
        typeof record.tag !== "string" || typeof record.ciphertext !== "string" ||
        !/^[A-Za-z0-9+/]{16}$/.test(record.nonce) || !/^[A-Za-z0-9+/]{22}==$/.test(record.tag) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.ciphertext)) {
        throw new InvalidSessionRecord();
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "base64"));
      decipher.setAAD(Buffer.from(`activity-auth:v1:${name(purpose, id)}`));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
      if (plaintext.length > MAX_PLAINTEXT) throw new InvalidSessionRecord();
      return JSON.parse(plaintext.toString("utf8"));
    } catch { throw new InvalidSessionRecord(); }
  };
  const status = (error: unknown) => (error as { statusCode?: number })?.statusCode;
  const missingBlob = (error: unknown) => status(error) === 404 &&
    typeof error === "object" && error !== null && "code" in error && error.code === "BlobNotFound";
  const write = async (purpose: RecordPurpose, id: string, value: unknown, etag?: string) => {
    const text = encrypt(purpose, id, value);
    try {
      await container.getBlockBlobClient(name(purpose, id)).upload(text, Buffer.byteLength(text), {
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
        abortSignal: AbortSignal.timeout(10_000),
        blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "no-store" },
      });
      return true;
    } catch (error) {
      if (status(error) === 412 || (etag && missingBlob(error))) return false;
      throw unavailable();
    }
  };
  return {
    async read(purpose, id) {
      try {
        const response = await container.getBlockBlobClient(name(purpose, id)).download(0, MAX_ENVELOPE + 1, {
          abortSignal: AbortSignal.timeout(10_000),
        });
        if (!response.etag || !response.readableStreamBody) throw unavailable();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.readableStreamBody) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_ENVELOPE) throw new InvalidSessionRecord(response.etag);
          chunks.push(Buffer.from(chunk));
        }
        try {
          return { value: decrypt(purpose, id, Buffer.concat(chunks).toString("utf8")), etag: response.etag };
        } catch (error) {
          if (error instanceof InvalidSessionRecord) throw new InvalidSessionRecord(response.etag);
          throw error;
        }
      } catch (error) {
        if (missingBlob(error)) return undefined;
        if (error instanceof InvalidSessionRecord) throw error;
        throw unavailable();
      }
    },
    create: (purpose, id, value) => write(purpose, id, value),
    replace: (purpose, id, value, etag) => write(purpose, id, value, etag),
    async remove(purpose, id, etag) {
      try {
        await container.getBlockBlobClient(name(purpose, id)).delete({
          conditions: { ifMatch: etag }, abortSignal: AbortSignal.timeout(10_000),
        });
        return true;
      } catch (error) {
        if (missingBlob(error)) return false;
        if (status(error) === 412) return false;
        throw unavailable();
      }
    },
  };
}

export function createAzureSessionStore(env: NodeJS.ProcessEnv): SessionStore {
  const key = readSessionEncryptionKey(env.ACTIVITY_SESSION_ENCRYPTION_KEY);
  const account = env.ACTIVITY_STORAGE_ACCOUNT ?? "";
  const container = env.ACTIVITY_SESSION_STORAGE_CONTAINER;
  const clientId = env.AZURE_CLIENT_ID;
  if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error("ACTIVITY_STORAGE_ACCOUNT is invalid.");
  if (container !== "sessions") throw new Error("ACTIVITY_SESSION_STORAGE_CONTAINER must be sessions.");
  if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error("AZURE_CLIENT_ID is required for session storage.");
  const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`,
    new ManagedIdentityCredential({ clientId }), { retryOptions: { maxTries: 1, tryTimeoutInMs: 10_000 } });
  return encryptedSessionStore(service.getContainerClient(container), key);
}
