import { readerName, type ReadAttribution } from "../data/read-attribution";

export function ReadHistory({ events }: { events: ReadAttribution[] }) {
  const batches = new Map<string, ReadAttribution & { readAt: string }>();
  for (const event of events) {
    if (event.readAt === null) continue;
    const key = JSON.stringify([event.acknowledgementId, event.readAt, readerName(event) ?? null]);
    batches.set(key, { ...event, readAt: event.readAt });
  }
  if (!batches.size) return null;
  return <ul className="read-history" aria-label="Read history">
    {[...batches].sort(([, left], [, right]) => Date.parse(right.readAt) - Date.parse(left.readAt))
      .map(([key, entry]) => <li key={key}>
        <span>{readerName(entry) ? <>Read by <strong>{readerName(entry)}</strong></> : "Reader not recorded"}</span>
        <time dateTime={entry.readAt} title={new Date(entry.readAt).toLocaleString()}>
          {new Date(entry.readAt).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </time>
      </li>)}
  </ul>;
}
