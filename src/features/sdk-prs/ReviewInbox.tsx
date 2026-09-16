import { useMemo, useState } from "react";
import type {
  DashboardSnapshot,
  InboxReason,
  Plane,
  PullRequestRecord,
  ReviewInboxItem,
} from "../../data/contracts";
import { Panel } from "../../shared/Panel";

const reasonLabels: Record<InboxReason, string> = {
  "new-pr": "New PR",
  "new-commit": "New commit",
  "new-comment": "New comment",
  "review-needed": "Review needed",
  "ci-failure": "CI help",
};

const activityReasons = new Set<InboxReason>([
  "new-pr",
  "new-commit",
  "new-comment",
]);

export function ReviewInbox({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [plane, setPlane] = useState<Plane>(snapshot.inbox.defaultPlane);
  const pulls = useMemo(
    () =>
      new Map(
        snapshot.pullRequests.map((pull) => [
          `${pull.repository}:${pull.number}`,
          pull,
        ]),
      ),
    [snapshot.pullRequests],
  );
  const items = snapshot.inbox.items
    .flatMap((item) => {
      const pull = getPull(item, pulls);
      return pull && pull.plane === plane ? [{ item, pull }] : [];
    })
    .sort(compareInboxEntries);
  const updated = items.filter(({ item }) =>
    item.reasons.some((reason) => activityReasons.has(reason)),
  );
  const attention = items.filter(
    ({ item }) => !item.reasons.some((reason) => activityReasons.has(reason)),
  );
  const counts = {
    management: snapshot.inbox.items.filter(
      (item) => getPull(item, pulls)?.plane === "management",
    ).length,
    data: snapshot.inbox.items.filter(
      (item) => getPull(item, pulls)?.plane === "data",
    ).length,
  };

  return (
    <Panel
      title="SDK review inbox"
      subtitle={
        snapshot.inbox.comparisonFrom
          ? `Changes since ${new Date(snapshot.inbox.comparisonFrom).toLocaleString()}`
          : "Baseline established; showing current review and CI work"
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
      {items.length === 0 ? (
        <div className="inbox-empty">No SDK-team attention is needed in this plane.</div>
      ) : (
        <div className="inbox-sections">
          {updated.length > 0 && (
            <InboxSection title="Updated since last refresh" entries={updated} />
          )}
          {attention.length > 0 && (
            <InboxSection title="Still needs attention" entries={attention} />
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
  entries,
}: {
  title: string;
  entries: Array<{ item: ReviewInboxItem; pull: PullRequestRecord }>;
}) {
  return (
    <section className="inbox-section">
      <h3>{title}</h3>
      <div className="inbox-list">
        {entries.map(({ item, pull }) => (
          <article className="inbox-card" key={`${item.repository}:${item.pullRequestNumber}`}>
            <div className="inbox-card__main">
              <a href={pull.url} target="_blank" rel="noreferrer">
                #{pull.number} {pull.packages[0]?.name ?? pull.title}
              </a>
              <div className="badges">
                {item.reasons.map((reason) => (
                  <span className={`activity-badge activity-badge--${reason}`} key={reason}>
                    {reasonLabels[reason]}
                    {reason === "ci-failure" && pull.checks.failedCount
                      ? ` · ${pull.checks.failedCount}`
                      : ""}
                  </span>
                ))}
              </div>
              <small>{pull.title}</small>
            </div>
            <div className="inbox-card__meta">
              {item.comments.length > 0 ? (
                <>
                  <span>
                    Latest comment by{" "}
                    <strong>{item.comments.at(-1)?.author}</strong>
                  </span>
                  <a
                    href={item.comments.at(-1)?.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open comment
                  </a>
                </>
              ) : (
                <time dateTime={item.activityAt}>
                  Updated {new Date(item.activityAt).toLocaleString()}
                </time>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function getPull(
  item: ReviewInboxItem,
  pulls: Map<string, PullRequestRecord>,
): PullRequestRecord | undefined {
  return pulls.get(`${item.repository}:${item.pullRequestNumber}`);
}

function compareInboxEntries(
  left: { item: ReviewInboxItem; pull: PullRequestRecord },
  right: { item: ReviewInboxItem; pull: PullRequestRecord },
): number {
  const rank = (item: ReviewInboxItem) => {
    if (item.reasons.includes("new-commit")) return 0;
    if (item.reasons.includes("new-pr")) return 1;
    if (item.reasons.includes("new-comment")) return 2;
    if (item.reasons.includes("review-needed")) return 3;
    return 4;
  };
  return (
    rank(left.item) - rank(right.item) ||
    right.item.activityAt.localeCompare(left.item.activityAt)
  );
}
