import type { RecordPurpose, SessionStore, StoredRecord } from "../../api/src/azure/session-store";

// Only tests provide an in-memory store; production always requires encrypted Azure Blob storage.
export function memorySessionStore(): SessionStore {
  const records = new Map<string, StoredRecord>();
  let revision = 0;
  const key = (purpose: RecordPurpose, id: string) => `${purpose}/${id}`;
  return {
    async read(purpose, id) {
      const record = records.get(key(purpose, id));
      return record && structuredClone(record);
    },
    async create(purpose, id, value) {
      const name = key(purpose, id);
      if (records.has(name)) return false;
      records.set(name, { value: structuredClone(value), etag: `${++revision}` });
      return true;
    },
    async replace(purpose, id, value, etag) {
      const name = key(purpose, id);
      if (records.get(name)?.etag !== etag) return false;
      records.set(name, { value: structuredClone(value), etag: `${++revision}` });
      return true;
    },
    async remove(purpose, id, etag) {
      const name = key(purpose, id);
      if (records.get(name)?.etag !== etag) return false;
      return records.delete(name);
    },
  };
}
