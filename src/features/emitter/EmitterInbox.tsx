import type { EmitterActivityWindow } from "../../data/emitter-contracts";
import {
  emitterAcknowledgementIds, emitterActivityLabels, emitterInboxEntries, emitterRelativeTime,
  type EmitterInboxEntry, type EmitterWorkItem,
} from "./emitterInboxModel";
import { EmitterTime } from "./EmitterTable";
import type { EmitterActivityActions, EmitterActivityState } from "./useEmitterActivity";

export function EmitterActivityNotice({ activity, baseline, retry, now = Date.now() }: {
  activity: EmitterActivityState;
  baseline?: EmitterActivityWindow;
  retry?: () => void;
  now?: number;
}) {
  return <div className="emitter-inbox-notice">
    <p><strong>Read state is shared across the team.</strong> Mark read clears unread activity for everyone,
      not Unassigned or Review requested. Opening a link never marks it read.</p>
    {activity.error && <div className="freshness-warning" role="alert">
      <p>{activity.error}</p>
      <p>{activity.feed ? "Showing the last available activity. Shared read changes are disabled until reconnected."
        : "Activity is unavailable. Current work is still shown; this is not an empty inbox."}</p>
      <button type="button" className="button-secondary" onClick={retry}
        disabled={activity.loading || activity.pending || !retry}>Retry loading</button>
    </div>}
    {!activity.configured && <p className="freshness-warning" role="status">
      Shared activity is not configured. Configure VITE_ACTIVITY_API_URL to enable the team inbox.
      Current work is shown without unread activity.
    </p>}
    {activity.loading && <p role="status">Refreshing shared activity… Read changes are temporarily disabled.</p>}
    {activity.pending && <p role="status">Saving shared read state…</p>}
    {activity.feed?.collectedAt ? <p className="emitter-muted">
      Activity collected <EmitterTime value={activity.feed.collectedAt} />. Refreshes every minute and on window focus.
    </p> : !activity.loading && !activity.error && activity.configured && <p role="status">
      Shared activity has not been initialized. Use Refresh data, then Run workflow to establish a baseline.
      The initial collection creates no new activity.
    </p>}
    {activity.feed?.collectedAt && now - Date.parse(activity.feed.collectedAt) > 26 * 60 * 60_000 &&
      <p className="freshness-warning" role="status">
        Activity collection is more than 26 hours old. Polling checks shared read state; use Refresh data to collect new GitHub activity.
      </p>}
    {!activity.feed?.collectedAt && !baseline && <p className="emitter-muted">
      This older snapshot has no activity baseline. Use Refresh data, then Run workflow to initialize activity;
      existing work will not be reported as new.
    </p>}
    {baseline?.comparisonFrom === null && <p className="emitter-muted">
      An activity baseline has been established. Initial work is not marked new; activity starts with later collections.
    </p>}
  </div>;
}

function EmitterNotification({ entry, activity, actions, now, read = false }: {
  entry: EmitterInboxEntry;
  activity: EmitterActivityState;
  actions?: EmitterActivityActions;
  now: number;
  read?: boolean;
}) {
  const events = read ? entry.recentlyRead : entry.unread;
  const labels = [...new Set(events.map((event) => emitterActivityLabels[event.kind]))];
  const latest = [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const latestComment = [...events].filter((event) => event.kind === "new-comment")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const restoreIds = emitterAcknowledgementIds(entry);
  const reviewers = "draft" in entry.item
    ? [...entry.item.requestedReviewers ?? [], ...entry.item.requestedTeams ?? []] : [];
  const writable = activity.canWrite && !activity.loading && !activity.pending && !activity.error && Boolean(actions);
  const generation = activity.feed?.generation;
  return <article className={`emitter-notification${read ? " emitter-notification--read" : ""}`}>
    <div className="emitter-notification__heading">
      <a href={entry.item.url} target="_blank" rel="noreferrer">#{entry.item.number}</a>
      {"draft" in entry.item && entry.item.draft && <span className="badge badge--warning">Draft</span>}
      {entry.signals.map((signal) => <span className="emitter-signal" key={signal}>{signal}</span>)}
      {labels.map((label) => <span className="emitter-activity-label" key={label}>{label}</span>)}
    </div>
    <h4><a href={entry.item.url} target="_blank" rel="noreferrer">{entry.item.title}</a></h4>
    <p className="emitter-muted">
      {entry.item.author ?? "Unknown author"}
      {entry.signals.includes("Review requested") && <> · Requested: {reviewers.join(", ")}</>}
    </p>
    <p className="emitter-muted">
      {latest ? (read ? "Activity" : "Latest activity") : "Updated"}{" "}
      <time dateTime={latest?.occurredAt ?? entry.item.updatedAt}
        title={new Date(latest?.occurredAt ?? entry.item.updatedAt).toLocaleString()}>
        {emitterRelativeTime(latest?.occurredAt ?? entry.item.updatedAt, now)}
      </time>
      {latestComment && <> · <a href={latestComment.url} target="_blank" rel="noreferrer">View comment</a></>}
    </p>
    <div className="emitter-notification__actions">
      {entry.unread.length > 0 && <button type="button" className="button-secondary"
        disabled={!writable} aria-label={`Mark activity read for #${entry.item.number}`}
        onClick={() => {
          if (generation) actions?.acknowledge({
            generation, number: entry.item.number,
            throughSequence: Math.max(...entry.unread.map((event) => event.sequence)),
          });
        }}>Mark read</button>}
      {entry.recentlyRead.length > 0 && <>
        <span className="emitter-muted">Read in the last 3 days</span>
        <button type="button" className="button-secondary"
          disabled={!writable || !restoreIds.length}
          aria-label={`Restore activity for #${entry.item.number}`}
          onClick={() => {
            if (generation) actions?.restore({ generation, acknowledgementIds: restoreIds });
          }}>Restore unread</button>
      </>}
    </div>
  </article>;
}

export function EmitterInboxView({ items, activity, excludedIssueNumbers, actions, now, kind }: {
  items: EmitterWorkItem[];
  activity: EmitterActivityState;
  excludedIssueNumbers: number[];
  actions?: EmitterActivityActions;
  now: number;
  kind: "issues" | "pull requests";
}) {
  const grouped = emitterInboxEntries(items, activity.feed?.events ?? [], excludedIssueNumbers, now);
  const uncertain = !activity.configured || !activity.feed?.collectedAt || Boolean(activity.error) || activity.loading;
  return <div className="emitter-inbox">
    <section aria-label={`${kind} needing attention`}>
      <h3>Needs attention <span>{grouped.attention.length}</span></h3>
      {grouped.attention.length ? <div className="emitter-inbox-grid">
        {grouped.attention.map((entry) => <EmitterNotification key={entry.item.number}
          entry={entry} activity={activity} actions={actions} now={now} />)}
      </div> : <p className="emitter-inbox-empty">
        {uncertain ? "No current attention signals in the available work. Unread activity is not yet confirmed."
          : `No ${kind} need attention.`}
      </p>}
    </section>
    {grouped.recentlyRead.length > 0 && <section aria-label={`Recently read ${kind}`}>
      <h3>Recently read <span>Last 3 days · shared across the team</span></h3>
      <div className="emitter-inbox-grid">
        {grouped.recentlyRead.map((entry) => <EmitterNotification key={entry.item.number}
          entry={entry} activity={activity} actions={actions} now={now} read />)}
      </div>
    </section>}
    <p className="emitter-muted">
      Tracking issues are excluded from this inbox. All open keeps the complete tables, including drafts.
    </p>
  </div>;
}
