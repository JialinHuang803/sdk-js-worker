# Dashboard design and decision logic

This document is the maintained product contract for the Azure SDK for
JavaScript dashboard. Update it whenever collection semantics, prioritization,
privacy rules, or refresh behavior changes.

## Product goal

Help the SDK team answer **“Where should I start?”** while retaining the full
AutoPR status table for investigation.

The page has two primary surfaces:

1. **SDK review inbox** — review-relevant work and activity.
2. **All pull requests** — complete current status, filters, and package data.

## Review inbox

The inbox is split into tabs with counts:

- **Management**
- **Data plane**

A PR appears once per tab and can carry multiple reasons.

### Included reasons

| Reason | Persistence | Meaning |
|---|---|---|
| `new-pr` | Current refresh cycle | PR did not exist in the preceding successful snapshot |
| `new-commit` | Current refresh cycle | Current head SHA differs from the preceding snapshot |
| `new-comment` | Current refresh cycle | A non-excluded comment was created after the preceding snapshot |
| `review-needed` | Until resolved | GitHub reports `REVIEW_REQUIRED` |
| `ci-failure` | Until resolved | Current failed check/status count is above zero |

Priority is new commit, new PR, new comment, review needed, then CI help.
Items with activity are shown under **Updated since last refresh**. Persistent
review/CI items with no new activity are shown under **Still needs attention**.

### Deliberately excluded

These remain visible in the full table but do not independently create inbox
items:

- merge conflicts;
- waiting for checks;
- waiting to merge;
- approval received;
- CI recovered;
- conflict resolved.

A conflict resolution that changes the head SHA naturally appears as a new
commit.

## Comment activity and privacy

Sources:

- pull-request conversation comments;
- inline review comments;
- review summaries containing a comment.

The public snapshot publishes only comment author login, creation timestamp,
kind, and direct GitHub URL. Comment bodies are never published.

Author exclusion is configured in `.github/dashboard-config.json`. Matching is
case-insensitive and supports `*` wildcards. Invalid configuration fails the
collection instead of silently weakening privacy rules.

## Refresh and comparison

The scheduled refresh target is **00:07 UTC daily**. GitHub Actions schedules
are best effort and may start late. A manual refresh is available through
workflow dispatch.

Each run loads the preceding deployed snapshot before collecting current data.
The comparison window is:

```text
previous successful generatedAt → current generatedAt
```

When no valid previous snapshot is available, the run establishes a baseline.
It still shows persistent review and CI work but does not label all existing
PRs as new.

## Package selection

Changed paths identify candidate SDK package roots. A candidate is displayed
when:

- its package version is new or differs between the PR base and head; or
- its `package.json` name exactly matches the canonical package token in the
  AutoPR title.

This includes the package being released while excluding incidental
cross-package cleanup.

## Failure semantics

- Unknown check, review, mergeability, or metadata state is never treated as
  healthy.
- Collection failure must not replace the last good deployment with an empty
  snapshot.
- Changed-file truncation is surfaced as partial data.
- The first successful baseline does not invent historical activity.
