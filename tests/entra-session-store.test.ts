import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAzureSessionStore, encryptedSessionStore, InvalidSessionRecord, readSessionEncryptionKey } from "../api/src/azure/session-store";

const id = "A".repeat(43), other = "B".repeat(43);
function setup() {
  const blobs = new Map<string, { text: string; etag: string }>();
  let version = 0;
  const fail = (statusCode: number) => { throw Object.assign(new Error("private Azure response"),
    { statusCode, code: statusCode === 404 ? "BlobNotFound" : "ConditionNotMet" }); };
  const download = vi.fn(async (name: string) => {
    const blob = blobs.get(name);
    if (!blob) return fail(404);
    return { etag: blob.etag, readableStreamBody: Readable.from([blob.text]) };
  });
  const upload = vi.fn(async (name: string, text: string, _size: number,
    options: { conditions: { ifMatch?: string; ifNoneMatch?: string } }) => {
    const previous = blobs.get(name);
    if (options.conditions.ifMatch && previous?.etag !== options.conditions.ifMatch) return fail(previous ? 412 : 404);
    if (options.conditions.ifNoneMatch === "*" && previous) return fail(412);
    blobs.set(name, { text, etag: `${++version}` });
  });
  const remove = vi.fn(async (name: string, options: { conditions: { ifMatch: string } }) => {
    const previous = blobs.get(name);
    if (!previous) return fail(404);
    if (previous.etag !== options.conditions.ifMatch) return fail(412);
    blobs.delete(name);
  });
  const container = {
    getBlockBlobClient: vi.fn((name: string) => ({
      download: (...args: unknown[]) => download(name, ...args as []),
      upload: (text: string, size: number, options: Parameters<typeof upload>[3]) => upload(name, text, size, options),
      delete: (options: Parameters<typeof remove>[1]) => remove(name, options),
    })),
  };
  const key = randomBytes(32);
  const connect = (encryptionKey = key) =>
    encryptedSessionStore(container as unknown as Parameters<typeof encryptedSessionStore>[0], encryptionKey);
  return { blobs, download, upload, remove, container, connect, store: connect() };
}

describe("encrypted durable authentication storage", () => {
  it("encrypts tokens with randomized AES-GCM envelopes and conditionally reads/writes/deletes", async () => {
    const { store, blobs, upload } = setup();
    const value = { version: 1, cache: "private-refresh-token", csrfToken: "private-csrf" };
    expect(await store.create("sessions", id, value)).toBe(true);
    const firstText = blobs.get(`sessions/${id}.json`)!.text;
    expect(firstText).not.toMatch(/private-refresh-token|private-csrf|cache|csrfToken/);
    expect(JSON.parse(firstText)).toMatchObject({ version: 1, nonce: expect.any(String), tag: expect.any(String) });
    expect(await store.create("sessions", id, value)).toBe(false);
    const record = (await store.read("sessions", id))!;
    expect(record.value).toEqual(value);
    expect(await store.replace("sessions", id, value, "stale")).toBe(false);
    expect(await store.replace("sessions", id, value, record.etag)).toBe(true);
    expect(blobs.get(`sessions/${id}.json`)!.text).not.toBe(firstText);
    const current = (await store.read("sessions", id))!;
    expect(await store.remove("sessions", id, record.etag)).toBe(false);
    expect(await store.remove("sessions", id, current.etag)).toBe(true);
    expect(await store.remove("sessions", id, current.etag)).toBe(false);
    expect(await store.replace("sessions", id, value, current.etag)).toBe(false);
    expect(await store.read("sessions", id)).toBeUndefined();
    expect(upload.mock.calls[0][3]).toMatchObject({ conditions: { ifNoneMatch: "*" },
      abortSignal: expect.any(AbortSignal), blobHTTPHeaders: { blobCacheControl: "no-store" } });
  });

  it("rejects tampering, a changed encryption key, and cross-purpose or cross-identifier substitution", async () => {
    const { store, blobs, connect } = setup();
    await store.create("sessions", id, { server: "secret" });
    const blob = blobs.get(`sessions/${id}.json`)!;
    await expect(connect(randomBytes(32)).read("sessions", id)).rejects.toBeInstanceOf(InvalidSessionRecord);
    blobs.set(`pending/${id}.json`, { ...blob });
    await expect(store.read("pending", id)).rejects.toBeInstanceOf(InvalidSessionRecord);
    blobs.set(`sessions/${other}.json`, { ...blob });
    await expect(store.read("sessions", other)).rejects.toBeInstanceOf(InvalidSessionRecord);
    const envelope = JSON.parse(blob.text);
    envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    blobs.set(`sessions/${id}.json`, { ...blob, text: JSON.stringify(envelope) });
    await expect(store.read("sessions", id)).rejects.toBeInstanceOf(InvalidSessionRecord);
  });

  it.each(["not-json", "null", "{}", '{"version":2}', "A".repeat(1024 * 1024 + 1025)])(
    "fails closed on malformed/versioned/oversized envelopes (case %#)", async (text) => {
      const { store, blobs } = setup();
      blobs.set(`sessions/${id}.json`, { text, etag: "1" });
      await expect(store.read("sessions", id)).rejects.toBeInstanceOf(InvalidSessionRecord);
    });

  it("caps serialized records and rejects untrusted blob paths", async () => {
    const { store, upload } = setup();
    await expect(store.create("sessions", id, { cache: "A".repeat(768 * 1024) })).rejects.toBeInstanceOf(InvalidSessionRecord);
    await expect(store.create("sessions", "../raw-cookie", {})).rejects.toBeInstanceOf(InvalidSessionRecord);
    expect(upload).not.toHaveBeenCalled();
  });

  it("sanitizes operational errors without treating them as absent records", async () => {
    const { store, download, upload, remove } = setup();
    for (const [method, operation] of [
      [download, () => store.read("sessions", id)],
      [upload, () => store.create("sessions", id, {})],
      [remove, () => store.remove("sessions", id, "1")],
    ] as const) {
      method.mockRejectedValueOnce(Object.assign(new Error("private Azure error/token"), { statusCode: 403 }));
      await expect(operation()).rejects.toMatchObject({ status: 503, message: "Authentication storage is unavailable." });
    }
  });

  it("requires a canonical 32-byte key, a dedicated container and explicit managed identity at startup", () => {
    const key = randomBytes(32).toString("base64");
    expect(readSessionEncryptionKey(key)).toEqual(Buffer.from(key, "base64"));
    for (const bad of [undefined, "", "not-base64", randomBytes(31).toString("base64"), `${key}\n`, key.slice(0, -1)]) {
      expect(() => readSessionEncryptionKey(bad)).toThrow("ACTIVITY_SESSION_ENCRYPTION_KEY");
    }
    const env = { ACTIVITY_SESSION_ENCRYPTION_KEY: key, ACTIVITY_SESSION_STORAGE_CONTAINER: "sessions",
      ACTIVITY_STORAGE_ACCOUNT: "activitytest", AZURE_CLIENT_ID: "cd1b838f-1e56-4462-91e8-80dc8084c233" };
    expect(() => createAzureSessionStore({ ...env, ACTIVITY_SESSION_ENCRYPTION_KEY: undefined })).toThrow("ENCRYPTION_KEY");
    expect(() => createAzureSessionStore({ ...env, ACTIVITY_SESSION_STORAGE_CONTAINER: "activity" })).toThrow("must be sessions");
    expect(() => createAzureSessionStore({ ...env, AZURE_CLIENT_ID: undefined })).toThrow("AZURE_CLIENT_ID");
    expect(() => createAzureSessionStore(env)).not.toThrow();
  });

  it.each(["ContainerNotFound", "ResourceNotFound", undefined])("treats infrastructure 404 (%s) as unavailable, not signed out", async (code) => {
    const { store, download, upload, remove } = setup();
    for (const [method, operation] of [
      [download, () => store.read("sessions", id)],
      [upload, () => store.replace("sessions", id, {}, "1")],
      [remove, () => store.remove("sessions", id, "1")],
    ] as const) {
      method.mockRejectedValueOnce(Object.assign(new Error("private infrastructure error"), { statusCode: 404, code }));
      await expect(operation()).rejects.toMatchObject({ status: 503, message: "Authentication storage is unavailable." });
    }
  });
});
