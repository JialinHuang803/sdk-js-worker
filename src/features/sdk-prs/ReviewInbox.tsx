import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  DashboardSnapshot,
  InboxReason,
  Plane,
  PullRequestRecord,
  ReviewInboxItem,
} from "../../data/contracts";
import { Panel } from "../../shared/Panel";
import { attentionEntries, groupActivities, pullKey } from "./sharedActivity";
import { SharedActivityList } from "./SharedActivityList";
import { useSharedActivity } from "./useSharedActivity";
import type { SharedActivityState } from "./useSharedActivity";

type InboxPull = Pick<
  PullRequestRecord,
  "repository" | "number" | "url" | "title" | "plane"
> & Partial<Pick<PullRequestRecord, "packages" | "checks" | "draft" | "holdOn">>;

const reasonLabels: Record<InboxReason, string> = {
  merged: "Merged",
  "new-pr": "New PR",
  "new-commit": "New commit",
  "new-comment": "New comment",
  "review-needed": "Review needed",
  "ci-failure": "CI failure",
};

const activityReasons = new Set<InboxReason>([
  "merged",
  "new-pr",
  "new-commit",
  "new-comment",
]);

const reasonPriority: InboxReason[] = [
  "new-commit",
  "new-pr",
  "new-comment",
  "merged",
  "review-needed",
  "ci-failure",
];

export function ReviewInbox({ snapshot }: { snapshot: DashboardSnapshot }) {
  const apiUrl = import.meta.env.VITE_ACTIVITY_API_URL?.trim();
  const activity = useSharedActivity(apiUrl);
  return <ReviewInboxView snapshot={snapshot} activity={apiUrl ? activity : null} />;
}

export function ReviewInboxView({ snapshot, activity = null }: {
  snapshot: DashboardSnapshot;
  activity?: SharedActivityState | null;
}) {
  const [plane, setPlane] = useState<Plane>(snapshot.inbox.defaultPlane);
  const [showRead, setShowRead] = useState(false);
  const pulls = useMemo(
    () =>
      new Map<string, InboxPull>(
        [...snapshot.pullRequests, ...(snapshot.mergedPullRequests ?? [])].map((pull) => [
          `${pull.repository}:${pull.number}`,
          pull,
        ]),
      ),
    [snapshot.pullRequests, snapshot.mergedPullRequests],
  );
  const visibleEntries = snapshot.inbox.items.flatMap((item) => {
    const pull = getPull(item, pulls);
    if (
      !pull ||
      pull.holdOn ||
      (pull.draft && !item.reasons.some((reason) => activityReasons.has(reason)))
    ) return [];
    return [{ item, pull }];
  });
  const items = visibleEntries
    .filter(({ pull }) => pull.plane === plane)
    .sort(compareInboxEntries);
  const updated = items.filter(({ item }) =>
    item.reasons.some((reason) => activityReasons.has(reason)),
  );
  const allAttention = attentionEntries(snapshot);
  const attention = allAttention.filter(({ pull }) => pull.plane === plane).sort(compareInboxEntries);
  const unread = activity?.feed ? groupActivities(activity.feed, false) : [];
  const read = activity?.feed ? groupActivities(activity.feed, true) : [];
  const countPulls = [
    ...(activity ? unread.map(({ pull }) => pull) : visibleEntries.map(({ pull }) => pull)),
    ...allAttention.map(({ pull }) => pull),
  ];
  const counts = {
    management: new Set(countPulls.filter((pull) => pull.plane === "management")
      .map((pull) => pullKey(pull.repository, pull.number))).size,
    data: new Set(countPulls.filter((pull) => pull.plane === "data")
      .map((pull) => pullKey(pull.repository, pull.number))).size,
  };
  const snapshotTiming = snapshot.inbox.comparisonFrom
    ? `Changes since ${new Date(snapshot.inbox.comparisonFrom).toLocaleString()} · Last refreshed ${new Date(snapshot.generatedAt).toLocaleString()}`
    : `Baseline established; showing current review and CI work · Last refreshed ${new Date(snapshot.generatedAt).toLocaleString()}`;
  const activityTime = activity?.feed?.collectedAt;
  const sharedTiming = activityTime && Date.parse(activityTime) === Date.parse(snapshot.generatedAt)
    ? `Updated ${new Date(snapshot.generatedAt).toLocaleString()}`
    : `Attention: ${new Date(snapshot.generatedAt).toLocaleString()}${activityTime
      ? ` · Activities: ${new Date(activityTime).toLocaleString()}` : ""}`;

  return (
    <Panel
      title="SDK review inbox"
      subtitle={
        activity
          ? "Tab counts are unique PRs with unread activity or current review/CI work; a PR may appear in both sections."
          : `${snapshotTiming} · Shared read state is not configured; activity covers the last refresh only. Tab counts are unique PRs with activity or review/CI work.`
      }
    >
      <div className="inbox-tabs" role="tablist" aria-label="SDK plane">
        <PlaneTab
          plane="management"
          label="Management"
          count={counts.management}
          selected={plane === "management"}
          onSelect={setPlane}
        />
        <PlaneTab
          plane="data"
          label="Data plane"
          count={counts.data}
          selected={plane === "data"}
          onSelect={setPlane}
        />
      </div>
      {activity && (
        <div className="shared-activity__status">
          {activity.feed?.collectedAt === null && <p role="status">Awaiting first collection. Shared activity has not been initialized; snapshot attention is shown independently.</p>}
          {activity.error && <div role="alert" className="freshness-warning">
            {activity.error} {activity.feed ? "Showing stale activities from the last successful load. Writes are disabled." : "Shared activities could not be loaded. Writes are disabled."}
            <button type="button" className="button-secondary" disabled={activity.loading || activity.pending} onClick={activity.retry}>Retry loading</button>
          </div>}
          {activity.loading && <p role="status">{activity.feed ? "Refreshing shared activities; writes are paused…" : "Loading shared activities…"}</p>}
          {activity.pending && <p role="status">Saving shared read state…</p>}
          <div className="shared-activity__toolbar">
            <span
              title="Anyone can mark activities as read for everyone. Opening a PR never marks it read."
            >Read state is shared with everyone. Anyone can mark activities as read.</span>
            <span className="shared-activity__timing">{sharedTiming}</span>
            <button type="button" className="button-secondary" aria-expanded={showRead}
              onClick={() => setShowRead(!showRead)}>
              {showRead ? "Hide recently read" : "Recently read"} ({read.filter(({ pull }) => pull.plane === plane).length} PRs)
            </button>
          </div>
        </div>
      )}
      {!activity && updated.length === 0 && attention.length === 0 ? (
        <div className="inbox-empty">No SDK-team attention is needed in this plane.</div>
      ) : (
        <div className="inbox-sections">
          {activity && <SharedActivityList groups={unread.filter(({ pull }) => pull.plane === plane)} activity={activity} />}
          {!activity && updated.length > 0 && (
            <InboxSection
              title="New activity"
              description="What changed since the last refresh"
              entries={updated}
            />
          )}
          {activity && showRead && <SharedActivityList groups={read.filter(({ pull }) => pull.plane === plane)} activity={activity} read />}
          {attention.length > 0 && (
            <InboxSection
              title="Needs attention"
              description="Current non-draft review and CI work · Independent of read state"
              entries={attention}
            />
          )}
        </div>
      )}
    </Panel>
  );
}

function PlaneTab({
  plane,
  label,
  count,
  selected,
  onSelect,
}: {
  plane: Plane;
  label: string;
  count: number;
  selected: boolean;
  onSelect: (plane: Plane) => void;
}) {
  return (
    <button
      className={selected ? "active" : ""}
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(plane)}
    >
      {label} <span>{count}</span>
    </button>
  );
}

function InboxSection({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: Array<{ item: ReviewInboxItem; pull: InboxPull }>;
}) {
  return (
    <section className="inbox-section">
      <div className="inbox-section__heading">
        <h3>{title}</h3>
        <span>{description}</span>
      </div>
      <div className="inbox-list">
        {entries.map(({ item, pull }) => {
          const primaryReason = getPrimaryReason(item);
          const latestComment = item.comments.at(-1);
          return (
            <article
              className={`inbox-notification inbox-notification--${primaryReason}`}
              key={`${item.repository}:${item.pullRequestNumber}`}
            >
              <ActivityIcon reason={primaryReason} />
              <div className="inbox-notification__content">
                <div className="inbox-notification__headline">
                  <a
                    className="inbox-notification__number"
                    href={pull.url}
                    target="_blank"
                    rel="noreferrer"
                    title={pull.title}
                  >
                    #{pull.number}
                  </a>
                  <span className="activity-label">
                    {reasonLabels[primaryReason]}
                  </span>
                  <h4>{getHeadline(primaryReason, pull)}</h4>
                  <time
                    dateTime={item.activityAt}
                    title={new Date(item.activityAt).toLocaleString()}
                  >
                    {formatRelativeTime(item.activityAt)}
                  </time>
                </div>
                <div className="inbox-notification__footer">
                  <div className="badges">
                    {pull.packages?.some((pkg) => pkg.breakingChanges === true) && (
                      <span className="badge badge--warning">Breaking change</span>
                    )}
                    {item.reasons
                      .filter((reason) => reason !== primaryReason)
                      .map((reason) => (
                        <span
                          className={`activity-badge activity-badge--${reason}`}
                          key={reason}
                        >
                          {reasonLabels[reason]}
                          {reason === "ci-failure" && pull.checks?.failedCount
                            ? ` · ${pull.checks.failedCount}`
                            : ""}
                        </span>
                      ))}
                  </div>
                  {latestComment && (
                    <span className="inbox-notification__comment">
                      From <strong>{latestComment.author}</strong>
                      <a href={latestComment.url} target="_blank" rel="noreferrer">
                        View comment
                      </a>
                    </span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityIcon({ reason }: { reason: InboxReason }) {
  const paths: Record<InboxReason, ReactNode> = {
    merged: <path d="M5 3v12m0-9c0 5 8 1 8 6m-2-2 2 2 2-2" />,
    "new-pr": <path d="M6 3v12m0-9h5a3 3 0 0 1 3 3v6m-2-2 2 2 2-2" />,
    "new-commit": <path d="M3 9h3m6 0h3M9 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />,
    "new-comment": <path d="M4 4h10v8H9l-3 3v-3H4V4Z" />,
    "review-needed": <path d="m4 9 3 3 7-7m-5 9h6" />,
    "ci-failure": <path d="M9 3v7m0 4v.01M3.5 16h11L9 3 3.5 16Z" />,
  };
  return (
    <span className="inbox-notification__icon" aria-hidden="true">
      <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7">
        {paths[reason]}
      </svg>
    </span>
  );
}

function getPrimaryReason(item: ReviewInboxItem): InboxReason {
  return (
    reasonPriority.find((reason) => item.reasons.includes(reason)) ??
    "review-needed"
  );
}

function getHeadline(reason: InboxReason, pull: InboxPull): string {
  const subject = pull.packages?.[0]?.name ?? `PR #${pull.number}`;
  const headlines: Record<InboxReason, string> = {
    merged: `Merged: ${pull.title}`,
    "new-pr": `${subject} is ready for first review`,
    "new-commit": `New commits landed in ${subject}`,
    "new-comment": `New conversation on ${subject}`,
    "review-needed": `${subject} is waiting for approval`,
    "ci-failure": `${subject} needs CI help`,
  };
  return headlines[reason];
}

function formatRelativeTime(timestamp: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 1_000),
  );
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getPull(
  item: ReviewInboxItem,
  pulls: Map<string, InboxPull>,
): InboxPull | undefined {
  return pulls.get(`${item.repository}:${item.pullRequestNumber}`);
}

function compareInboxEntries(
  left: { item: ReviewInboxItem; pull: InboxPull },
  right: { item: ReviewInboxItem; pull: InboxPull },
): number {
  const rank = (item: ReviewInboxItem) =>
    reasonPriority.indexOf(getPrimaryReason(item));
  return (
    rank(left.item) - rank(right.item) ||
    right.item.activityAt.localeCompare(left.item.activityAt)
  );
}
