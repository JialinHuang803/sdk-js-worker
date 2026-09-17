# Dashboard design and decision logic

This document is the maintained product contract for the Azure SDK for
JavaScript dashboard. Update it whenever collection semantics, prioritization,
privacy rules, or refresh behavior changes.

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

A PR appears once per tab and can carry multiple reasons.

### Included reasons

| Reason | Persistence | Meaning |
|---|---|---|
| `new-pr` | Current refresh cycle | PR did not exist in the preceding successful snapshot |
| `new-commit` | Current refresh cycle | Current head SHA differs, unless all added commits match excluded authors |
| `new-comment` | Current refresh cycle | A non-excluded comment was created after the preceding snapshot |
| `merged` | Current refresh cycle | GitHub reports an AutoPR merge after the preceding snapshot |
| `review-needed` | Until resolved | GitHub reports `REVIEW_REQUIRED` |
| `ci-failure` | Until resolved | Current failed check/status count is above zero |

Priority is new commit, new PR, new comment, merged, review needed, then CI help.
Items with activity are shown under **Updated since last refresh**. Persistent
review/CI items with no new activity are shown under **Still needs attention**.

The inbox uses a compact, two-column notification feed on wider screens and a
single column on smaller screens. The PR number, primary activity, verb-first
headline, and relative timestamp share one scan line. Labels use readable title
case rather than all-capital text. Additional reasons remain visible as
secondary badges so reviewers can understand the full state without opening
the PR.

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
Merge notifications last one data refresh cycle and survive UI-only deploys.
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

Each scheduled or manual collection loads the preceding deployed snapshot.
The comparison window is:

```text
previous successful generatedAt → current generatedAt
```

When no valid previous snapshot is available, the run establishes a baseline.
It still shows persistent review and CI work but does not label all existing
PRs as new.

The inbox displays **Changes since** for the start of this window and **Last
refreshed** for the current snapshot's collection time.

Code pushes run a separate UI deployment workflow. They download and preserve
the published JSON exactly, including its activity items, timestamps and stale
state. They do not run the collector, apply changed collector configuration, or
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
