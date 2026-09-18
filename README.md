# Azure SDK for JavaScript dashboard

A public, read-only engineering dashboard for
[`Azure/azure-sdk-for-js`](https://github.com/Azure/azure-sdk-for-js). The first
feature tracks open pull requests whose titles start exactly with `[AutoPR`,
including drafts.

The UI is a static React application deployed to GitHub Pages. A scheduled
GitHub Actions workflow collects a deliberately small, sanitized snapshot from
GitHub's public APIs. A small Azure Functions service with private Blob Storage
maintains shared unread activities and acknowledgements. Viewing and acknowledging
activities require no sign-in; **any visitor can mark activities read for everyone**.
Source GitHub PRs remain read-only, and there is no client-side GitHub credential.

The maintained product and decision contract is in
[`docs/dashboard-design.md`](docs/dashboard-design.md).

## What the dashboard shows

Above the inbox, a two-part **SDK delivery report** summarizes management-plane
and data-plane work in plain language: open AutoPRs, PRs awaiting required
approval, approved-but-open PRs awaiting service-team action (including those
with conflicts), and AutoPRs merged in the past seven days.

These counts cover all AutoPRs, regardless of table filters, drafts, or HoldOn.
Review/approval totals use GitHub's review decision, not the prioritized next
step or the mere presence of a review. Unknown review states are qualified.
The seven-day window ends at the snapshot timestamp; incomplete or missing
merge history is shown as unavailable, never zero.

Each AutoPR row includes:

- PR number, title, draft status, creation date, and age
- management plane when the PR has the `Mgmt` label; data plane otherwise
- release package name and version from `package.json` at the current PR head
- namespace-to-version values from the package's `metadata.json`
- the public release-plan URL referenced in the PR body
- failed check count across GitHub check runs and commit status contexts,
  including statuses reported by Azure Pipelines
- GitHub merge conflict state
- a prioritized next step derived from draft, CI, conflicts, required review,
  pending, and completeness signals

Only the failed count is shown—not individual CI job details. Zero failures is
qualified when checks are pending, cancelled, absent, or incomplete. Unknown
mergeability is shown as checking rather than as conflict-free.

The **Next step** column applies this order:

1. drafts remain **Draft in progress**
2. CI failures, conflicts, cancelled checks, or requested changes become
   **Needs resolution**
3. GitHub's `REVIEW_REQUIRED` decision becomes **Review needed**
4. running checks become **Waiting for checks**
5. incomplete signals become **Status unavailable**
6. a fully clear PR becomes **Wait to merge**

GitHub's `reviewDecision` is used instead of counting requested reviewers. It
reflects whether branch protection's qualifying approval requirement is
actually satisfied without publishing reviewer identities.

Plane, next-step, search, and sorting filters are stored in the hash URL, so a
filtered view can be bookmarked. Conflicts remain visible in their own column
and are also integrated into **Needs resolution** and its reason. Hash routing
also lets deep links work under the project Pages path `/sdk-js-worker/`
without server rewrites.

## Local development

Requires Node.js 22 or later.

```bash
Copy-Item .npmrc.example .npmrc
artifacts-npm-credprovider -c .npmrc
npm ci
npm run collect
npm run dev
```

Copy `.env.example` to `.env.local` to connect the UI to the shared public
activity service. Read actions against that URL affect the real team inbox;
leave it unset for local refresh-cycle-only previews.

Dependencies are resolved through the Azure SDK public npm feed. The local
`.npmrc` is ignored because the credential provider may add authentication
material; never commit it. The committed `.npmrc.example` contains only the
feed location and is also used by CI.

REST collection can use public unauthenticated API access, but the authoritative
GraphQL review decision requires `GITHUB_TOKEN` or `GH_TOKEN`. Without one, the
collector explicitly marks review state incomplete rather than inferring an
approval. Do not use a token in any `VITE_*` variable: Vite exposes those values
to the browser bundle.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

## Architecture

| Area | Location | Responsibility |
|---|---|---|
| Versioned contract | `src/data/contracts.ts` | Sanitized boundary between collection and presentation |
| Collector | `scripts/collect-sdk-prs.ts` | GitHub pagination, current-head checks, changed paths, and package metadata |
| Collector rules | `scripts/collector-lib.ts` | Testable parsing and normalization |
| Feature registry | `src/features/registry.ts` | Typed tabs/routes and their independently owned components |
| SDK PR feature | `src/features/sdk-prs/` | Query state, filters, table, and rendering |
| Shared UI | `src/shared/` | Reusable panel and loading/error/empty states |
| Static snapshot | `public/data/sdk-prs.json` | Only data copied into the public site |
| Shared activity service | `api/` | Durable unread history, anonymous read/undo, protected ingestion |
| Azure infrastructure | `infra/main.bicep` | Private storage and managed-identity Functions |

Provisioning, deployment, access risks and recovery are documented in
[`docs/shared-activity-operations.md`](docs/shared-activity-operations.md).

The collector enumerates changed files (including rename origins) to discover
candidate package roots, then compares each package version at the PR base and
head. Only new or version-bumped packages—the packages actually being
released—are displayed; incidental cross-package cleanup is excluded. When the
current base already contains the same version, the collector falls back to an
exact match between the AutoPR package token and the package's actual
`package.json` name. It reads metadata at the PR's head SHA and can fall back to
the base revision to identify a removed package. Forks are read through the head
repository. Missing files, removed packages, multi-package releases, unknown
mergeability, and API truncation become explicit states instead of aborting the
whole dashboard.

Checks are requested for the current PR head SHA with GitHub's `latest` filter.
Commit statuses are deduplicated by context and producer, retaining the newest
retry. Check runs returned by GitHub remain distinct, even when several
workflow jobs share a generic name. Test-merge-ref runs with a different SHA
are excluded. The combined commit status endpoint is intentionally not used:
an empty status list must not become a synthetic pending check.

The snapshot contains repository keys, the current source SHA for each PR, and
collection timestamps for future multi-repository support. It does **not**
contain full PR bodies, submitter details or email addresses, raw API
responses, secrets, or the contents behind release-plan links.

## Add a dashboard tab

1. Create a folder under `src/features/<feature-id>/` containing the feature's
   component and its data/query logic.
2. Add one `DashboardFeature` entry in `src/features/registry.ts`. The shared
   shell automatically adds its navigation tab and hash route.
3. Define a separate versioned data contract in `src/data/` and write a
   collector that emits only the public fields the feature needs.
4. Add a collector workflow and contract/parser tests. All Pages publishers must
   restore other features' published snapshots and share the `pages` concurrency
   group, because each deployment replaces the whole site.

This registry is intentionally lightweight. Features own their display and
query behavior without requiring a plugin runtime or placeholder tabs.

## Collection and deployment

### JS emitter

The **JS emitter** tab monitors open issues and pull requests in
`Azure/typespec-azure` with the `emitter:typescript` label. Open counts include
draft PRs and all labeled issues (including tracking reports), not just items
requiring action. The shared work pane has issue/PR tabs, a compact **Needs
attention** inbox, and **All open** tables with search and draft filtering.
The inbox combines unread activity with current unassigned issues or explicitly
requested PR reviews; it does not infer that an issue needs triage.
The package overview shows the public npm **latest dist-tag** for
`@azure-tools/typespec-ts`, not the repository's development version or `next`
prerelease tag.

The same overview shows Spector coverage from
[Azure/typespec-azure#5313](https://github.com/Azure/typespec-azure/issues/5313):
per-suite pass percentages, passed/total counts, failures, unimplemented counts,
spec versions, and the report date. These rates include unimplemented scenarios
in the denominator. The weekly report is read by the emitter collector, not
rerun by it. A warning appears when the report is older than eight days.
Only summary fields are published, not the report body. An unreadable or
inconsistent summary stops collection, preserving the last deployment.

Run `npm run collect:emitter` locally with `GITHUB_TOKEN` or `GH_TOKEN` set to
write `public/data/emitter.json` (generated and ignored by git).
If your network blocks npmjs.org, set `EMITTER_NPM_REGISTRY` to the public Azure
SDK feed URL from `.npmrc.example` for local collection. This explicitly uses
that registry's `latest` tag, which may lag npm; the scheduled workflow always
uses npmjs.org. No GitHub credentials are sent to either package registry.
`.github/workflows/collect-emitter.yml` (**Collect JS emitter**) collects daily
at **20:17 UTC** or by manual dispatch, independently of the SDK collector.
The emitter tab's **Refresh data** link opens that workflow.
This workflow uses only `GITHUB_TOKEN` for public repository reads; no Azure
organization installation or new token secret is required.
For team-shared read state, it also uses the existing `ACTIVITY_API_URL` variable
and `ACTIVITY_INGEST_KEY` secret against an isolated emitter feed in the same
Azure service. Deploy the updated API before running the collector.

**Mark read** is shared with everyone, not browser-local. It acknowledges only
the displayed activity; it does not resolve unassigned work or a review request.
**Recently read** retains recoverable acknowledgements for three days. The first
collection establishes a baseline without labeling the backlog as new. Subsequent
collections record newly created work, observed PR head changes, and relevant new
comments. Unread events survive later refreshes; closed or label-removed work
leaves the inbox. Opening GitHub links never marks activity read.

`.github/emitter-config.json` controls excluded tracking issue numbers (initially
Spector #5313, still visible in the overview and full table).
Comment author exclusions and conversation/review-comment/review-summary switches
reuse `.github/dashboard-config.json`. Comment edits and approval-only reviews
do not generate new-comment notifications. No comment or review body is published.

The emitter collector publishes an allowlist of issue/PR metadata: title, link,
number, timestamps, author login, assignee logins, label names, comment count,
and PR draft state, head SHA, and requested reviewer/team names. Activity publishes
only stable IDs, kinds, timestamps, source links, and author logins. It does not
publish bodies, comment text, email addresses, or raw API responses. It paginates
the repository issues endpoint (which includes PRs) and each comment/review source,
avoiding GitHub Search's result cap. A failed GitHub or npm lookup stops
publication and leaves the previous deployment intact; timestamps and the
26-hour freshness warning show when results are old.

All three publishing workflows use the same `pages` concurrency group. The
emitter workflow restores the SDK snapshot unchanged and never ingests SDK
activity. SDK and UI deployments restore the emitter snapshot unchanged. A
404 before the first emitter collection leaves the emitter view explicitly
unavailable, not zero-filled; other restoration errors stop deployment.

### SDK PRs and shared UI

`.github/workflows/collect-and-deploy.yml` runs on manual dispatch and daily at
approximately **20:00 UTC**. GitHub does not guarantee
exact schedule times, so the UI shows snapshot freshness and warns after 26
hours without a successful refresh. The collector paginates every list endpoint
and marks changed-file data partial if GitHub's 3,000-file limit or another
discrepancy is detected.

`.github/workflows/deploy-ui.yml` handles pushes to `main`. It downloads the
latest published snapshot with `npm run data:restore` and deploys the new UI
with that JSON unchanged. It never collects data or advances the activity
window, and never falls back to the older checked-in snapshot. Both deployment
workflows (including the emitter publisher) share a concurrency group so snapshot download/collection and
deployment cannot overlap.

The inbox shows **Unread activities**, aggregated per PR across collection
cycles, and independent **Needs attention**. Mark read acknowledges only the
displayed activities for everyone across devices. Recently read restores
acknowledged events for 3 days; unread events do not expire. When opened, Recently
read appears between Unread activities and Needs attention. A PR can appear in
both blocks. Drafts are hidden from Needs attention but remain eligible for
unread activity and stay in the full table/report. HoldOn hides activity without
acknowledging it. Tab counts count unique visible PRs, not duplicated cards.

The shared API is polled every minute and on browser focus; this updates read
state without running the GitHub collector. When no API URL is configured,
the UI explicitly falls back to the prior refresh-cycle-only New activity view.
Snapshot timestamps do not change on UI-only pushes.
`activity.excludedCommitAuthorPatterns` in `.github/dashboard-config.json`
defaults to `["kazrael2119"]`. A changed head does not create a **New commit**
event when every added commit since the previous snapshot is authored
by an excluded GitHub login. Mixed/unknown authors still notify. Patterns are
case-insensitive and support `*`; use `[]` to disable. This does not hide the PR,
its other activity, or its current status, and is separate from comment exclusions.
New activity includes SDK AutoPR merges within that window, including PRs
created and merged between refreshes. Closed-but-unmerged PRs do not notify.
Unread merged/closed cards remain until acknowledged; closure alone creates no
event. Merged PRs stay out of the open-PR table and open counts. The collector separately
records at least seven days of merge history for the delivery report, including
on the first collection. Only merges since the preceding snapshot notify in
the inbox; the seven-day report does not backfill inbox notifications.
Release packages with new entries under their version's **Breaking Changes**
changelog heading receive a **Breaking change** badge in the table and existing
inbox notifications. Historical releases do not trigger it. This is a
dashboard badge, not a GitHub label or a full API compatibility assessment.
Missing, invalid, or schema-incompatible published data blocks a UI deployment;
run **Collect and deploy dashboard** explicitly for initial publication or a
data-contract migration. Collector/configuration changes take effect on the
next scheduled or manual collection, not on the code push.

The dashboard's **Refresh data** button opens this workflow in GitHub Actions.
Choose **Run workflow** there to start a manual collection; the public static
site cannot trigger an authenticated workflow directly.

The workflow uses the repository `GITHUB_TOKEN` with read access for public
GitHub API requests and grants only the Pages permissions required to deploy.
No Azure organization app installation is needed for public reads. If GitHub's
runtime token cannot read the source repository in a particular organization
policy configuration, create an `AZURE_SDK_READ_TOKEN` Actions secret with
public-repository read-only access. It is supplied only to the Node collector,
never copied to `public/` or bundled by Vite.

Collection failure is fatal to the deploy job, so a failed run cannot replace
the last good Pages deployment with an empty snapshot. When a prior local
snapshot exists, the collector also marks that file explicitly stale and
records a sanitized error for diagnosis.

To publish:

1. Merge the implementation into `main`.
2. In **Settings → Pages**, select **GitHub Actions** as the build and deployment
   source if it is not already selected.
3. Run **Collect and deploy dashboard** manually for the initial data snapshot.
   Subsequent `main` pushes deploy UI changes while preserving published data.

PR workflows have read-only repository permission and never execute the Pages
deployment job, preventing untrusted pull-request code from deploying with
elevated credentials.

## Not implemented

Historical trend analytics, authenticated/private source data, GitHub write
actions, identity-based acknowledgement permissions, and AI summaries are future
additions. Shared activity acknowledgements are the only current write feature.
