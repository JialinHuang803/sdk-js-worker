import type { ReadAttribution } from "../../src/data/read-attribution";

export function publicActivityFeed<T extends { events: ReadAttribution[] }>(feed: T) {
  return { ...feed, events: feed.events.map(({ readBy: _readBy, ...event }) => event) };
}
