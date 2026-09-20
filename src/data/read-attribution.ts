export interface ReadAttribution {
  readAt: string | null;
  acknowledgementId: string | null;
  readBy?: { name: string; acknowledgementId: string };
}

export function validReaderName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}

export function validReadAttribution(readBy: unknown): boolean {
  return readBy === undefined || (typeof readBy === "object" && readBy !== null &&
    "name" in readBy && validReaderName(readBy.name) &&
    "acknowledgementId" in readBy && typeof readBy.acknowledgementId === "string" &&
    readBy.acknowledgementId.length > 0 && readBy.acknowledgementId.length <= 100);
}

export function readerName(event: ReadAttribution): string | undefined {
  // Older writers may retain unknown fields when restoring or re-acknowledging.
  return event.readAt !== null && event.readBy?.acknowledgementId === event.acknowledgementId
    ? event.readBy?.name : undefined;
}

export function discardStaleReader<T extends ReadAttribution>(event: T): T {
  if (event.readBy === undefined || readerName(event) !== undefined) return event;
  const current = { ...event };
  delete current.readBy;
  return current;
}
