import type { ActivityGroup } from "./sharedActivity";
import { acknowledgeGroup, pullKey } from "./sharedActivity";
import type { SharedActivityState } from "./useSharedActivity";

const labels = {
  "new-pr": "New PR",
  "new-commit": "New commit",
  "new-comment": "New comment",
  merged: "Merged",
};

export function SharedActivityList({
  groups, activity, read = false,
}: {
  groups: ActivityGroup[];
  activity: SharedActivityState;
  read?: boolean;
}) {
  const { feed, loading, pending, error } = activity;
  const disabled = loading || pending || !!error || !feed?.collectedAt;
  const emptyMessage = loading && !feed ? "Loading shared activities…" :
    error || !feed ? "Shared activities are unavailable." :
    feed.collectedAt === null ? "Awaiting first collection. Unread activity is not available yet." :
    read ? "No read activities in this plane." : "No unread activities in this plane.";
  return (
    <section className="inbox-section">
      <div className="inbox-section__heading">
        <h3>{read ? "Recently read" : "Unread activities"}</h3>
        <span>{groups.length} PRs · {read ? "Shared read history · Retained for 3 days after marking read" : "Oldest unread first · Unread activity never expires"}</span>
      </div>
      {!groups.length ? (
        <p className="inbox-empty">
          {emptyMessage}
        </p>
      ) : (
        <div className="inbox-list">
          {groups.map((group) => {
            const { pull, events } = group;
            const kinds = [...new Set(events.map((event) => event.kind))];
            const latestComment = [...events].sort((a, b) => b.sequence - a.sequence)
              .find((event) => event.comment)?.comment;
            return (
              <article className={`inbox-notification shared-activity inbox-notification--${kinds[0]}`} key={pullKey(pull.repository, pull.number)}>
                <div className="inbox-notification__content">
                  <div className="inbox-notification__headline">
                    <a className="inbox-notification__number" href={pull.url} target="_blank" rel="noreferrer"
                      aria-label={`${pull.repository} #${pull.number}: ${pull.title}`}>
                      #{pull.number}
                    </a>
                    <h4 title={pull.title}>{pull.title}</h4>
                    {pull.state !== "open" && <span className="badge">{pull.state === "merged" ? "Merged" : "Closed"}</span>}
                    {pull.draft && <span className="badge">Draft</span>}
                  </div>
                  <div className="shared-activity__meta">
                    <span>{pull.repository}</span>
                    <span>{events.length} {read ? "read" : "unread"} {events.length === 1 ? "event" : "events"}</span>
                    {kinds.map((kind) => <span className="activity-badge" key={kind}>{labels[kind]}</span>)}
                    {pull.packages.some((pkg) => pkg.breakingChanges === true) && <span className="badge badge--warning">Breaking change</span>}
                  </div>
                  <div className="shared-activity__times">
                    <span>First <ReadableTime value={group.firstAt} /></span>
                    <span>Latest <ReadableTime value={group.latestAt} /></span>
                  </div>
                  <div className="shared-activity__actions">
                    {latestComment && <a href={latestComment.url} target="_blank" rel="noreferrer">Comment by {latestComment.author}</a>}
                    <button type="button" className="button-secondary"
                      disabled={disabled || (read && group.acknowledgementIds.length === 0)}
                      aria-label={`${read ? "Restore read activities for" : "Mark activities as read for"} ${pull.repository} #${pull.number}`}
                      onClick={() => {
                        if (!feed || disabled) return;
                        if (read) activity.restore({ generation: feed.generation, acknowledgementIds: group.acknowledgementIds });
                        else activity.acknowledge(acknowledgeGroup(feed, group));
                      }}>
                      {read ? "Restore unread" : "Mark read"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ReadableTime({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })}</time>;
}
