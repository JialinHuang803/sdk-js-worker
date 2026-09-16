# Azure SDK for JavaScript dashboard

A public, read-only engineering dashboard for
[`Azure/azure-sdk-for-js`](https://github.com/Azure/azure-sdk-for-js). The first
feature tracks open pull requests whose titles start exactly with `[AutoPR`,
including drafts.

The site is a static React application deployed to GitHub Pages. A scheduled
GitHub Actions workflow collects a deliberately small, sanitized snapshot from
GitHub's public APIs. There is no backend service, user sign-in, database, or
client-side GitHub credential.

The maintained product and decision contract is in
[`docs/dashboard-design.md`](docs/dashboard-design.md).

## What the dashboard shows

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
4. Add the collector to `collect-and-deploy.yml` and add contract/parser tests.

This registry is intentionally lightweight. Features own their display and
query behavior without requiring a plugin runtime or placeholder tabs.

## Collection and deployment

`.github/workflows/collect-and-deploy.yml` runs on pushes to `main`, on manual
dispatch, and daily at approximately **00:07 UTC**. GitHub does not guarantee
exact schedule times, so the UI shows snapshot freshness and warns after 26
hours without a successful refresh. The collector paginates every list endpoint
and marks changed-file data partial if GitHub's 3,000-file limit or another
discrepancy is detected.

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
3. Run **Collect and deploy dashboard** manually or wait for the `main` push.

PR workflows have read-only repository permission and never execute the Pages
deployment job, preventing untrusted pull-request code from deploying with
elevated credentials.

## Not implemented

Durable historical trends, authenticated/private data, write actions, and AI
summaries are future additions. They are intentionally outside this public
static prototype.
