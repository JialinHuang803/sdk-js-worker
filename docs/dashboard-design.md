# Dashboard design and decision logic

This document is the maintained product contract for the Azure SDK for
JavaScript dashboard. Update it whenever collection semantics, prioritization,
privacy rules, or refresh behavior changes.

## JS emitter view

The independent `/emitter` feature tracks open `emitter:typescript` issues and
PRs in `Azure/typespec-azure`. Its overview shows the latest published npm
`@azure-tools/typespec-ts` version and separate open issue/PR counts, including
draft PRs. These are inventory counts, not inferred triage priorities.
The lists share one **Emitter work** pane with **Open issues** and **Open pull
requests** tabs and item counts. Issues are selected initially; each tab keeps
its own search and filters when switching. Arrow keys, Home and End navigate
the tabs. Each work tab defaults to **Needs attention**, with **All open** retaining
the complete searchable inventory. The lists provide links, ownership, timestamps and draft state without
publishing bodies. The overview's **Spector Coverage** section extracts per-suite pass rates
and counts from the Summary table in Azure/typespec-azure#5313, with the report
date and a direct link. Coverage means passed / total, including unimplemented
scenarios in the denominator; it is not pass / executed scenarios. Report age
is independent of snapshot freshness and warns after eight days. Missing or
inconsistent report data blocks collection rather than publishing invented
rates. Older snapshots without coverage show an explicit unavailable message.
No separate Spector view or combined team inbox is needed for this initial scope.

`Collect JS emitter` refreshes its versioned `data/emitter.json` daily at
20:17 UTC or manually. SDK collection remains independent. Every Pages
publisher preserves the other feature's snapshot byte-for-byte under a shared
deployment concurrency group; UI-only publishing advances neither source's
timestamp. The registry owns each feature's repository and refresh links.

### Emitter inbox

There is no **Needs triage** signal: the repository currently has no authoritative
triage marker. Compact notification cards group signals by issue/PR, rather than
displaying one card for every comment. Cards show relative activity/update times
with exact timestamps available on hover. Current work and activity are distinct:

| Signal | Source and meaning |
|---|---|
| New issue / New PR | Creation time within the successful collection window; adding a label to old work is not creation |
| New commits | Current PR head differs from the prior collected head; includes rebases/force pushes, not a commit count |
| New comment | New conversation comment, inline review comment, or nonempty comment/changes-requested review summary |
| Unassigned | An issue has no assignee; this is an ownership cue, not proof that it is untriaged |
| Review requested | A non-draft PR has explicit outstanding requested reviewers or teams; no approval/merge readiness is inferred |

Draft PRs do not dominate review attention; relevant discussion may still surface
them. Spector issue 5313 is excluded from the inbox by
`.github/emitter-config.json`, but remains in the overview, counts and all-open
inventory. The shared dashboard configuration supplies case-insensitive comment
author patterns and comment-source switches. Edited old comments, approval-only
reviews and pending review drafts do not count as new discussion. Comment text
and review bodies are used only transiently and never published.

The first activity-enabled collection establishes a baseline, showing current
ownership/review work without inventing historical activity. Collection windows
start at the previous durable snapshot and end at this run's start time.
Comment timestamps must fall inside that window; a head change is dated when
observed, not inferred from the PR's unrelated last-update time. GitHub collection
is not transactional, so very short-lived work between collections is not a
complete audit trail.

Read acknowledgements are **team-shared**, using the existing Azure service with
an isolated emitter state blob and routes. Anyone can mark activity read for
everyone. Mark read acknowledges only displayed sequences, leaving later arrivals
unread; it does not resolve persistent ownership/review work. Recently read is
recoverable for three days. Opening a link does not acknowledge anything. API
failure is explicit and disables writes rather than falling back to local read
state. Closed/merged or no-longer-labeled work leaves this open-work inbox.

The protected service baseline is authoritative. Ingestion precedes Pages
publication so a failed deployment does not discard recorded events. The emitter
feed can therefore be newer than the published snapshot. Work counts and tables
use the fresher inventory; package and coverage remain from the published snapshot,
with collection times displayed separately. No emitter operation rewrites SDK activity.
There is no emitter CI signal, automatic triage inference, or AI prioritization.

## Product goal

Help the SDK team answer **“Where should I start?”** while retaining the full
AutoPR status table for investigation.

The page has three primary surfaces:

1. **SDK delivery report** — a plain-language overview for each plane.
2. **SDK review inbox** — review-relevant work and activity.
3. **All pull requests** — complete current status, filters, and package data.

## Delivery report

Two side-by-side blocks (stacked on narrow screens) report on management and
data planes. Sentences describe the work rather than showing standalone
counters. Each block includes:

- all current open AutoPRs, including drafts and HoldOn;
- PRs awaiting required approval (`REVIEW_REQUIRED`);
- approved-but-open PRs (`APPROVED`) awaiting service-team action, including
  conflicts and CI blockers, with a separate conflict count in the sentence;
- AutoPRs merged during the seven days ending at `generatedAt`.

The report ignores table/inbox filters. Review totals follow the authoritative
GitHub decision independently of the table's prioritized next step; a failed
check, HoldOn label, or conflict does not hide an approval or review requirement.
Unknown or incomplete review decisions are excluded from confirmed totals and
explicitly qualified. Requested changes and no approval requirement do not
count as approval. Approval never implies merge readiness.

The collector publishes an optional `mergeHistoryWindow` with `from` and
`through` timestamps covering its lightweight merged-PR summaries. Weekly
counts require coverage of the full seven-day window and are deduplicated by
repository and number. Missing coverage in older snapshots is unavailable,
not zero; the next data collection populates it without requiring a refresh
on a UI push. Only GitHub-confirmed merges count, not closed-unmerged PRs.
Counts are as of the snapshot, not the browser clock; stale warnings still apply.

## Review inbox

The inbox is split into tabs with counts:

- **Management**
- **Data plane**

A PR appears once per block and can carry multiple reasons. The same PR can
appear in both Unread activities and Needs attention; read state and required
work are independent.

### Included reasons

| Reason | Persistence | Meaning |
|---|---|---|
| `new-pr` | Until acknowledged | PR did not exist in the preceding successful snapshot |
| `new-commit` | Until acknowledged | Current head SHA differs, unless all added commits match excluded authors |
| `new-comment` | Until acknowledged | A non-excluded comment was created after the preceding snapshot |
| `merged` | Until acknowledged | GitHub reports an AutoPR merge after the preceding snapshot |
| `review-needed` | Until resolved | GitHub reports `REVIEW_REQUIRED` |
| `ci-failure` | Until resolved | Current failed check/status count is above zero |

Transient reasons append durable events to the Azure-backed **Unread activities**
feed, grouped by repository/PR across days and ordered oldest-unread first.
The independent **Needs attention** block derives required-review and failed-CI
work from the current status snapshot, regardless of whether activity is unread.

Draft PRs are excluded from **Needs attention**, even when they require approval
or have failed CI. They can still appear in **Unread activities** for new PRs, commits,
or comments. Inbox tab counts reflect only visible entries; the full table and
delivery report still include drafts. This presentation rule also applies to
already-published snapshots, without a data refresh.

The inbox uses a compact, two-column notification feed on wider screens and a
single column on smaller screens. The PR number, primary activity, verb-first
headline, and relative timestamp share one scan line. Labels use readable title
case rather than all-capital text. Additional reasons remain visible as
secondary badges so reviewers can understand the full state without opening
the PR. Shared cards provide Mark read, first/latest event times and event-type
badges. An anonymous acknowledgement affects everyone; opening a PR link does
not acknowledge it.

### Shared read state

The private `activity/state.json` blob contains a sanitized public feed,
acknowledgements and the canonical collector baseline. Azure Functions exposes
public read/acknowledge/restore endpoints and key-protected baseline/ingestion
endpoints. Acknowledgements are scoped to the sequence actually displayed;
concurrent or late-discovered events stay unread. Conditional ETag updates
prevent the collector from overwriting concurrent read actions.

Recently read offers recovery for 3 days through Restore unread on each card,
without a separate Undo button. When expanded, it appears between Unread
activities and Needs attention. Acknowledged details expire after 72 hours and
are pruned on the next API read, mutation or collection, not just the daily
collection. Unread history never expires automatically. The monotonic sequence and
collector baseline remain after pruning. History starts with the current
published activities at migration; overwritten older activities are not
reconstructed. Events are observed at scheduled collection, not a real-time
GitHub event stream.

Shared reads require no sign-in by explicit prototype choice. Any visitor can
mark read or restore for the whole team; rate limits are not authorization.
The UI explains this. HoldOn hides a card without acknowledging it. Merged and
closed PR references persist while their activities remain, but closure itself
does not notify. Read state is not stored in localStorage.

The UI polls the service every minute and on focus. Errors show stale/unavailable
feed state and disable writes, while the table and Needs attention remain usable.
With no API configured, a clearly labelled legacy New activity view covers only
the previous refresh window. Tab counts deduplicate PRs across the visible
unread and attention blocks; Recently read is not included.

### Deliberately excluded

These remain visible in the full table but do not independently create inbox
items:

- PRs carrying the `HoldOn` label;
- merge conflicts;
- waiting for checks;
- waiting to merge;
- approval received;
- CI recovered;
- conflict resolved.

A conflict resolution that changes the head SHA naturally appears as a new
commit.

`HoldOn` takes precedence over every other derived next step in the full table.
It indicates that the PR is paused for service-team action.

### Merge notifications

The collector scans closed PRs ordered by latest update, paginating until it
passes the earlier of the previous snapshot timestamp and seven days ago.
It selects only exact `[AutoPR` title prefixes with a `merged_at` timestamp
inside that history window. Closing a PR
without merging never creates a notification; an old merge with a recent
comment does not either. This also catches PRs created and merged entirely
between refreshes, without requiring them to appear in the prior open list.

Merged PRs are stored as lightweight `mergedPullRequests` summaries, separate
from the open table and its counts. Notifications use the merge timestamp,
the current plane label, and a GitHub PR link, with no obsolete review/CI
reasons or guessed package metadata. `HoldOn` exclusion still applies.
Merge events remain unread across refresh cycles until acknowledged and survive
UI-only deploys.
Without a previous snapshot, seven-day history is collected for the report
but historical merges do not create notifications. After an outage longer
than a week, the full refresh window is collected so no merge notification
is lost; only the last seven days contribute to the weekly total.
Summaries and history coverage are optional so existing schema-v3 snapshots
still render.

## Comment activity and privacy

Sources:

- pull-request conversation comments;
- inline review comments;
- review summaries containing a comment.

The public snapshot publishes only comment author login, creation timestamp,
kind, and direct GitHub URL. Comment bodies are never published.

Author exclusion is configured in `.github/dashboard-config.json`. Matching is
case-insensitive and supports `*` wildcards. Invalid configuration fails the
collection instead of silently weakening privacy rules. Azure Pipelines bot
comments are excluded because their CI state is already represented by the
dedicated CI reason.

## Commit activity exclusions

`activity.excludedCommitAuthorPatterns` in `.github/dashboard-config.json`
controls new-commit notifications independently of comment exclusions. It
defaults to `["kazrael2119"]` in the repository configuration; removing the
setting or using `[]` disables commit exclusions. Patterns match GitHub-linked
commit author logins case-insensitively, with `*` wildcards, not committer,
pusher, display name, or email.

For changed heads on existing PRs, the collector compares the preceding
snapshot's head SHA with the current head SHA and paginates the commit range.
It suppresses only the `new-commit` reason when the nonempty range consists
entirely of excluded authors. Mixed authors and unlinked/unknown authors still
notify. Failed or incomplete comparisons (including unreachable old SHAs
after force-pushes) retain activity with an explicit collection warning.
History rewinds with no added commits also retain the head-change notification.

New PRs, comments, required reviews, CI failures, merges, package data and
report counts are unchanged. The current head SHA is always saved, even for
suppressed activity, so it becomes the next comparison baseline. No commit
messages, author emails, or raw comparison responses are published. Changes
take effect on the next data refresh, not a UI-only deployment.

## Refresh and comparison

The scheduled refresh target is **20:00 UTC daily**. GitHub Actions schedules
are best effort and may start late. A manual refresh is available through
workflow dispatch.

Each scheduled or manual collection loads the preceding shared-service snapshot
when configured, otherwise the deployed snapshot. The service baseline is
canonical so a failed Pages deployment cannot lose events already ingested.
The comparison window is:

```text
previous successful generatedAt → current generatedAt
```

When no valid previous snapshot is available, the run establishes a baseline.
It still shows persistent review and CI work but does not label all existing
PRs as new.

The legacy inbox displays **Changes since** for this window and **Last refreshed**
for the snapshot. The shared inbox displays activity and attention collection
times separately; read-state changes never advance either collection timestamp.

Code pushes run a separate UI deployment workflow. They download and preserve
the published JSON exactly, including its activity items, timestamps and stale
state. They do not run the collector, ingest events, apply changed collector configuration, or
advance the comparison window. Missing or incompatible published data fails the
UI deployment instead of restoring older checked-in data; initial publication
and schema migrations require an explicit collection. The UI and collection
workflows share the Pages concurrency group to serialize their entire runs.

## Package selection

Changed paths identify candidate SDK package roots. A candidate is displayed
when:

- its package version is new or differs between the PR base and head; or
- its `package.json` name exactly matches the canonical package token in the
  AutoPR title.

This includes the package being released while excluding incidental
cross-package cleanup.

## Breaking-change badges

For each selected release package, the collector reads `CHANGELOG.md` (or
`changelog.md`) at the PR head SHA and compares it with the PR base. It locates
the exact release version from `package.json`; older release sections never
trigger a badge. A nonempty `Breaking Changes` subsection with entries not
already present in that same version at the base yields **Breaking change**.
Empty headings, fenced examples and HTML comments are ignored. This describes
declared changelog changes, not an independent API compatibility analysis.

The table shows the badge next to the affected package and links to its
head-SHA changelog. Existing inbox notifications also show the badge if any
release package declares breaking changes; it does not create a new notification
reason or override HoldOn/next-step rules. Missing files, unmatched versions,
and failed reads remain unknown, not "no breaking changes". Changelog text is
not published in the snapshot, only the detection result and source link.
Existing snapshots remain compatible; data is populated on the next collection.

## Failure semantics

- Unknown check, review, mergeability, or metadata state is never treated as
  healthy.
- Collection failure must not replace the last good deployment with an empty
  snapshot.
- Changed-file truncation is surfaced as partial data.
- The first successful baseline does not invent historical activity.
