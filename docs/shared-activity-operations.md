# Shared activity operations

## Current hosting restriction and local alternative

As of September 20, 2026, public access to the deployed Function App is blocked
by network restrictions following security remediation. Do not override those
settings: the individual DDFun subscription is not intended for a shared team
service without the appropriate approval.

The September 19-20 scheduled failures were baseline HTTP 403 responses, before
source GitHub collection. `ACTIVITY_API_URL` still pointed to the blocked
Function, not the new Container App. SDK run `35540257705` and emitter run
`35541669274` confirmed this; it was not a source-repository token failure.
The cutover below replaces that dependency without reopening the Function.

The [GitHub-backed local prototype](github-activity-local.md) provides a separate
implementation for evaluation. It does not migrate these blobs, modify the
deployed API or change workflow credentials. Approved hosting and explicit state
migration are required before any cutover.

## Authenticated Container Apps evaluation

The Azure evaluation uses resource names without a `-poc` suffix:
`ca-sdk-js-worker`, `cae-sdk-js-worker`, `vnet-sdk-js-worker`,
`nsg-sdk-js-worker`, `id-sdk-js-worker` and `acrsdkjsworker2807`.
Azure cannot rename these resources in place; replacements are provisioned
before the original four private provisioning resources are retired.

`infra/container-app-foundation.bicep` creates the VNet-injected external
environment, authenticated registry and user-assigned managed identity. It does
not expose an application. The identity receives image-pull permission on the
registry and Blob Data Contributor on the existing `activity` container only.
The existing storage account, blobs, Function and their network settings are
not redeployed. Registry administrator credentials and anonymous pull are disabled.

`infra/container-app-dashboard.bicep` deploys an explicitly supplied runtime
image with ingress **disabled by default**. Enable HTTPS ingress only after
the authenticated runtime, Entra callback and access restrictions are ready.
Do not expose the provisioning quickstart image as a dashboard replacement.

The single-tenant Entra registration must be associated with an approved
Service Tree service using `serviceManagementReference`. Initially the enterprise
application required explicit user assignment. At the user's request, access
now extends to all **member accounts in the configured Microsoft tenant**,
excluding guests. The enterprise app no longer requires individual assignment;
the server enforces membership. Tenant policy rejects password credentials.
Use a managed-identity federated credential instead of requesting an exception,
enabling implicit grants, or putting credentials in the browser. Its issuer is
`https://login.microsoftonline.com/<tenant-id>/v2.0`, subject is the user-assigned
identity's **principal ID**, and audience is `api://AzureADTokenExchange`.
The registered web callback is the exact HTTPS app origin plus
`/api/auth/callback`; both implicit grant settings remain disabled.

This remains an authenticated hosting evaluation, not authorization for
shared-team DDFun hosting. The current workflows target this Azure runtime;
GitHub Pages publishes only a redirect. Do not disable Azure policies,
add remediation-skip tags or redeploy templates to undo a subsequent security
restriction. Shared-team hosting approval remains a separate requirement;
changing the application's access policy does not grant that approval.
An accepted ARM deployment does not establish that approval or guarantee that
security automation will leave the endpoint reachable.

### Runtime and deployment

The Node entrypoint is `api/src/azure/main.ts`. It serves the built dashboard and
both activity APIs from one origin on port 8080. It uses MSAL authorization code
flow with PKCE and a managed-identity client assertion, not EasyAuth headers.
The runtime does not trust caller-supplied identity headers. Browser sessions
use opaque Secure/HttpOnly cookies, server-side expiry and per-session CSRF
tokens. Mutations additionally require the configured exact Origin and JSON.
Only the login/callback endpoints are unauthenticated; dashboard assets and
snapshots require a session too. Collector routes have their own GitHub workload
identity boundary, described below, and do not accept browser sessions.

Configure these non-secret environment values:

| Variable | Value |
| --- | --- |
| `ACTIVITY_AUTH_MODE` | `entra-federated` |
| `ACTIVITY_ENTRA_TENANT_ID` | The single tenant containing the app and identity |
| `ACTIVITY_ENTRA_CLIENT_ID` | The Entra application client ID |
| `ACTIVITY_ENTRA_MANAGED_IDENTITY_CLIENT_ID` | The user-assigned identity client ID |
| `ACTIVITY_ENTRA_ACCESS_POLICY` | `allowlist` (default) or explicitly `tenant-members` |
| `ACTIVITY_ALLOWED_OBJECT_IDS` | Required for `allowlist`; omit for `tenant-members` |
| `ACTIVITY_ORIGIN` | Exact HTTPS dashboard origin, without a trailing slash |
| `ACTIVITY_STORAGE_ACCOUNT` | Existing account containing the original state |
| `ACTIVITY_STORAGE_CONTAINER` | `activity` |
| `AZURE_CLIENT_ID` | The same user-assigned identity client ID, for Blob access |
| `ACTIVITY_COLLECTOR_AUTH` | `github-oidc` to enable hosted collection; disabled when omitted |

Pass these as the Bicep `runtimeEnvironment` array of `{name, value}` entries.
Do not confuse the identity's client ID used here with its principal ID used
as the federated credential subject. For `allowlist`, keep enterprise application
assignment required as well as the server allowlist. For `tenant-members`,
disable per-user assignment and configure the optional **ID token** claim
`acct`. The server accepts only an explicit member value (`0`) from the
trusted code exchange, alongside its existing tenant, audience, issuer, nonce
and expiry checks. Guest (`1`), missing and malformed membership claims are
denied, including for the original owner. Email suffixes are never used to
authorize membership. Membership and access are evaluated at sign-in;
existing sessions expire within one hour and are not a live directory lookup.

Build with `VITE_ACTIVITY_AUTH=entra`, `VITE_ACTIVITY_API_URL=/api` and
`VITE_BASE_PATH=/`, then run `npm run build` and `npm --prefix api run build`.
Do not run collectors or stage snapshot JSON during an image deployment.
Snapshots are served from the canonical private state blobs, not image files,
and `.dockerignore` excludes `dist/data`.
The root `Dockerfile` consumes these compiled artifacts. `.dockerignore`
allowlists build inputs and excludes credential files. The dependency stage
maps known public Azure Artifacts tarball URLs to public npm inside the image
build copy, retaining locked versions and integrity hashes. No `.npmrc`,
Entra token, GitHub private key or local environment file belongs in the context.
CI uses the same allowlisted lock transformation in its temporary API checkout:
some new API packages require authentication at the Azure Artifacts mirror.
The public npm tarballs install with the existing locked integrity hashes,
without adding feed credentials or changing the committed lockfile.

Deploy the resulting image by digest, initially with `enableIngress=false` and
`minReplicas=1`. Use control-plane container execution to confirm startup,
federated token exchange and read-only access to both existing blobs before
enabling HTTPS ingress. Use TCP startup/readiness probes; there is no anonymous
application health endpoint. Afterwards the evaluation can use zero minimum
replicas, but never more than one: sessions are bounded in-memory and do not
survive restarts, revisions or scale-to-zero. Users must sign in again then.

The runtime never initializes a missing state blob. Unavailable or corrupt
storage is an error, not an empty inbox. The same `state.json` and
`emitter-state.json` are used, without migrating or replacing history.
Normal feed reads can prune already-read entries beyond the existing 72-hour
recovery window; unread activity is retained.

Marking an activity read records the authenticated session's display name
(`readBy`) alongside its existing acknowledgement ID and read time. The name
comes from the server's Entra session, never from the request body. Recently
read cards show the reader and time for each acknowledgement batch on both
tabs; older entries without attribution show "Reader not recorded." Names
are snapshots at the time of marking, not a live directory lookup.
Concurrent or repeated acknowledgements do not overwrite an existing reader.
Restore clears that batch's attribution; a later mark records its new reader.
Names share the existing three-day read retention and are not a permanent
audit log. No email address, token or directory object ID is added to the feed.
Attribution is bound to its acknowledgement ID, so an older writer retaining
unknown fields cannot incorrectly credit a previous reader for a new read.
Stale attribution is ignored by the UI and removed when state is loaded.

The optional local GitHub service records the authenticated GitHub login.
Its anonymous responses omit reader names, as do the legacy Functions handlers
in this source tree. Names are not added to collector snapshots or Pages assets.
The blocked, previously deployed Function has not been upgraded: do not reopen
its anonymous endpoints against these blobs without deploying the updated
name-stripping handlers or replacing its authentication first.

### GitHub Actions collection and live snapshots

The data path is:

```text
GitHub Actions -> GitHub public APIs -> OIDC-authenticated Azure ingestion
              -> existing private Blob state + snapshot in one ETag update
              -> Entra-authenticated dashboard /data/*.json and activity APIs
```

Set repository variable `ACTIVITY_API_URL` to
`https://ca-sdk-js-worker.ambitiouspond-79d04e69.eastus2.azurecontainerapps.io/api`.
Both collectors set `ACTIVITY_COLLECTOR_AUTH=github-oidc` and have only
`contents: read` and `id-token: write`. There is no collector Azure role,
storage credential, Entra client secret or Functions key. The legacy
`ACTIVITY_INGEST_KEY` secret is not used by these workflows.

The server verifies the GitHub-issued JWT signature against the fixed GitHub
JWKS endpoint, issuer, expiry and exact audience `<ACTIVITY_ORIGIN>/api/collector`.
It also requires this repository's immutable repository/owner IDs, exact
main-branch subject/ref, `schedule` or `workflow_dispatch`, and the feature's
exact workflow file at `refs/heads/main`. There is no collection environment,
so the required subject is
`repo:JialinHuang803/sdk-js-worker:ref:refs/heads/main`.
The default trust pins repository ID `1370752026` and owner ID `139532647`.
Moving the service to another workflow repository requires setting all three
`ACTIVITY_COLLECTOR_REPOSITORY`, `ACTIVITY_COLLECTOR_REPOSITORY_ID` and
`ACTIVITY_COLLECTOR_REPOSITORY_OWNER_ID` together; do not configure only a name.
Tokens from forks, PRs, other workflows/branches or the other feature cannot
ingest. Collector tokens cannot access session-protected feeds, reader names,
snapshots or acknowledgement routes. A fresh token is requested for baseline
and again after collection, avoiding expiry during a long GitHub scan.

| Workflow | Schedule | Azure state |
| --- | --- | --- |
| `collect-and-deploy.yml` / Collect Azure SDK dashboard | Daily 20:00 UTC (04:00 UTC+8 next day) | `activity/state.json` |
| `collect-emitter.yml` / Collect JS emitter | Daily 20:17 UTC (04:17 UTC+8 next day) | `activity/emitter-state.json` |

Schedules are best effort; GitHub may delay or skip scheduled runs. Manual
dispatch on `main` is the recovery path. Public repository reads continue using
`GITHUB_TOKEN`; the optional SDK read-only token is unnecessary unless source
access policy actually prevents that token from working.

The baseline remains the last successful collection, including across failed
runs. Ingestion uses the existing validators, deduplication and ETag retries
against concurrent acknowledgements. Existing names and read markers are not
reset. Each stored snapshot and activity feed update atomically, independently
of the other feature. No separate upload/image rebuild is needed for data.
The authenticated `/data/sdk-prs.json` and `/data/emitter.json` return only
validated snapshots, not the surrounding feed or `readBy` fields.
Missing, corrupt or unavailable state is an explicit error, never an older
bundled file or invented empty inventory. Failed collection leaves the previous
snapshot and timestamps intact; the UI warns after 26 hours without freshness.
The Azure UI reloads snapshots every minute and on focus, independently of
read-state polling. Polling never triggers GitHub collection.
Normal 72-hour read-detail pruning still applies.

### Automated image deployment and Pages redirect

`deploy-azure.yml` builds and deploys the Entra UI/API on `main` pushes or
explicit main-branch dispatch, without collecting data. It uses a dedicated
`id-sdk-js-worker-deploy` managed identity and a GitHub federated credential for
the `azure-dashboard` environment, whose deployment branch policy permits
only `main`. Its audience is `api://AzureADTokenExchange`, distinct from the
collector audience. The deployment identity has no Blob data role.
Its client ID is `6adb95f8-ba3c-4609-9082-94109cb714d5`; its principal ID is
`938f0dd2-aaf9-4320-bdaf-8e053dd8f457`.

| Deployment role | Exact scope |
| --- | --- |
| AcrPush and Reader | Registry `acrsdkjsworker2807` |
| Container Apps Contributor | App `ca-sdk-js-worker` only |
| Managed Identity Operator | Runtime identity `id-sdk-js-worker` only, to retain the existing assignment |

No subscription-wide or resource-group Contributor grant is needed. Repository
variables are `AZURE_DEPLOY_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_CONTAINER_APP` and
`AZURE_CONTAINER_REGISTRY`. These are identifiers, not credentials.
The workflow pushes to ACR, deploys the pushed immutable image digest and waits
for the revision to be healthy and ready; it does not redeploy infrastructure
or reset app environment/network configuration.

`deploy-ui.yml` publishes only `pages-redirect/index.html` to GitHub Pages.
The redirect retains existing hash routes/filters and provides a visible link
when JavaScript is disabled. It contains no snapshot or account data.
Each deployment and collector has a separate non-cancelling concurrency group.
PR CI has no OIDC permission and does not deploy.

Do not configure collectors to use browser cookies, expose anonymous collector
routes, or weaken user authentication to troubleshoot an authorization error.

### September 20 evaluation status

The authenticated image is deployed at
`https://ca-sdk-js-worker.ambitiouspond-79d04e69.eastus2.azurecontainerapps.io/`.
The Entra app is `sdk-js-worker`, client ID
`d8714cdb-8d6d-443e-969a-5beab691ce59`. Its Service Tree association was supplied
by the user. The managed identity can read the existing SDK and emitter state
without changing them, and federated token exchange succeeds without a secret.

The initial assigned-user configuration showed **"Need admin approval."**
After the user's requested change to tenant-member access, the user confirmed
that sign-in opens the dashboard. No tenant consent policy was changed and
no administrator consent was granted by this deployment. Broader eligibility
does not override the organization's consent policies. The registration declares only the sign-in
permissions actually requested by MSAL: `openid`, `profile`, and
`offline_access`. These are delegated sign-in scopes; no mail, files,
directory-wide read or application permissions were requested. MSAL includes
`offline_access` by default; this runtime does not persist refresh tokens.

If the approval screen persists, an authorized tenant administrator must review
the registration's API permissions and grant consent through the organization's
normal approval process. App ownership, Service Tree association and Azure resource ownership
do not themselves grant tenant-wide consent. Do not bypass this by enabling
anonymous access, implicit grants or using an unrelated application's identity.
Consent also does not replace the separate approval for shared-team hosting.

The app now permits Microsoft tenant members (not guests) and
uses zero minimum / one maximum replica. The subsequent workflow cutover is
described above. All four original `-poc` resources have
been retired; the replacement app, environment, VNet and NSG have no suffix.

## Original private Container Apps provisioning experiment

`infra/container-app-prototype.bicep` is a separate, temporary personal R&D
provisioning experiment. It creates only:

- `nsg-sdk-js-worker-poc` and isolated `vnet-sdk-js-worker-poc`, with a delegated
  Container Apps subnet and no peering or corporate routing.
- `cae-sdk-js-worker-poc`, a VNet-injected internal environment with public
  network access disabled.
- `ca-sdk-js-worker-poc`, a Consumption provisioning app using Microsoft's
  public quickstart image, no ingress, zero minimum replicas and one maximum.

This does **not** deploy the dashboard API, copy GitHub App credentials, migrate
activity, change the existing Function, or create a publicly reachable service.
No Container Registry is needed for the public quickstart image. A successful
provisioning experiment is not approval for public access or shared-team hosting.
An approved private access path would also be required to reach an app exposed
inside the environment.

Validate first, then deploy incrementally only when authorized:

```powershell
az deployment group validate --subscription 2807db07-c2ff-4a43-b586-5cfc12779347 --resource-group rg-sdk-js-worker --name sdk-js-worker-container-prototype --template-file .\infra\container-app-prototype.bicep --mode Incremental
az deployment group create --subscription 2807db07-c2ff-4a43-b586-5cfc12779347 --resource-group rg-sdk-js-worker --name sdk-js-worker-container-prototype --template-file .\infra\container-app-prototype.bicep --mode Incremental
```

Azure Monitor is the configured log destination, but no diagnostic sink is
provisioned by this small template. Scale-to-zero is not a promise of zero cost:
inspect charges for Azure-managed networking and infrastructure as well.
Delete this named prototype app, then its environment, VNet and NSG when the
experiment is no longer needed; never delete the resource group to clean up
the prototype, because it contains existing activity storage and the Function.

## Legacy Function reference (not the current deployment)

The following sections document the original Function architecture and its
historical provisioning commands for recovery/reference only. **Do not run
these commands to cut over the current service, reopen the Function, replace
the repository API URL, or initialize the existing hosted state.** Current
deployment, authentication and snapshot behavior are described above.

### Original resources

- Subscription: `2807db07-c2ff-4a43-b586-5cfc12779347`
- Resource group: `rg-sdk-js-worker`
- Region: East US 2
- Function App: `func-sdk-js-worker-2807`
- Storage account: `stsdkjsworker2807`
- Public API base: `https://func-sdk-js-worker-2807.azurewebsites.net/api`

`infra/main.bicep` provisions Flex Consumption (Node.js 22, 512 MB instances,
maximum five instances, no always-ready allocation), LRS storage and managed
identity. Storage shared keys, public blob access, FTP and SCM basic
authentication are disabled. The Functions identity has Blob Data Owner on
the dedicated account for Functions host locks/key storage, deployment packages
and the activity state. CORS allows the GitHub Pages origin; it is not
authorization and does not protect the anonymous endpoints from non-browser clients.

The state lives in private Blob Storage at `activity/state.json`, not GitHub
Pages or browser storage. Public callers get only the projected activity feed;
the collector baseline is accessible only with the ingestion key.

The emitter inbox uses the same Function App but a separate
`activity/emitter-state.json` blob. Its routes are `/api/emitter-activity`,
`/api/emitter-activity/ack`, `/api/emitter-activity/restore`,
`/api/emitter-activity/baseline`, and `/api/emitter-activity/ingest`, with the same
public/protected split as the SDK routes below. Emitter acknowledgements,
generation, sequences, rate limiting and baseline are independent of SDK state.
Deploy the updated API before enabling emitter shared collection. The first
**Collect JS emitter** run initializes its baseline; do not use the SDK seed
command for emitter activity. The existing repository API URL and ingestion key
are reused by the independently scheduled emitter workflow.

### Original routes and permissions

| Route | Access | Purpose |
|---|---|---|
| `GET /api/activity` | Anonymous | Sanitized feed, read markers, current PR references |
| `POST /api/activity/ack` | Anonymous | Acknowledge an existing PR card through its displayed sequence |
| `POST /api/activity/restore` | Anonymous | Restore specific acknowledgement batches |
| `GET /api/activity/baseline` | Function key | Canonical collector snapshot and tracked PRs |
| `POST /api/activity/ingest` | Function key | Append sanitized snapshot activity |

Anonymous writes are an explicitly accepted prototype risk: any visitor can
acknowledge or restore activity for the team. No identity or audit attribution is
implied. Shared storage enforces 120 acknowledgement/restore requests per minute;
the limit persists across Function instances. This is a coarse protective
limit, not DDoS prevention, authorization, or a billing cap. A malicious visitor
can exhaust it. Monitor Azure cost and add identity/access control before
treating this inbox as a trusted operational system.

Requests have bounded body sizes, private routes require a key, and public
mutations cannot supply arbitrary activity records or delete the store.
Acknowledged details are kept for 3 days (72 hours) for recovery, then pruned on
the next API read, mutation or collection. Unread events never expire automatically. A single JSON blob suits
this prototype volume; it is not a scalable event database. There is no
independent permanent audit archive or configured Application Insights ingestion.

### Original provisioning and deployment

Run from the repository root with an authorized Azure CLI session:

```powershell
az login
az provider register --namespace Microsoft.Storage --subscription 2807db07-c2ff-4a43-b586-5cfc12779347 --wait
az provider register --namespace Microsoft.Web --subscription 2807db07-c2ff-4a43-b586-5cfc12779347 --wait
az group create --name rg-sdk-js-worker --location eastus2 --subscription 2807db07-c2ff-4a43-b586-5cfc12779347
az deployment group create --resource-group rg-sdk-js-worker --template-file .\infra\main.bicep --subscription 2807db07-c2ff-4a43-b586-5cfc12779347
npm ci --prefix api --userconfig .npmrc.example
.\scripts\deploy-activity.ps1
```

If the feed requires local authentication, use the repository's existing
credential-provider setup and install with the normal authenticated npm user
configuration. Do not copy `.npmrc` into deployment packages.

The deployment script packages only `api/host.json`, `api/package.json`,
compiled code and installed dependencies. It never includes secrets or local
settings. Deployment uses Azure CLI/Entra credentials with SCM basic auth
disabled. CI compiles/tests the API; automatic API deployment and federated
GitHub-to-Azure deployment credentials are not configured. Deploy API code
explicitly with the script when it changes.

Configure GitHub repository variable `ACTIVITY_API_URL` with the public base URL,
and repository secret `ACTIVITY_INGEST_KEY` with a Functions key that permits both
protected collector endpoints. Do not put the key in workflow source or a URL.
Only the collector receives it as a server-side environment variable. Both Pages
workflows build with the public `VITE_ACTIVITY_API_URL`.

To initialize an empty service without refreshing dashboard data, set
`ACTIVITY_API_URL` and `ACTIVITY_INGEST_KEY` in the local process, then run
`npm run activity:seed`. This imports only activities already present in the
published snapshot; it cannot recover overwritten history. It refuses to replace
an existing service baseline. Do not run the seed against a different repository.

### Original consistency and recovery

- Each event has an immutable ID and a monotonically increasing sequence.
  Timestamps are display data, not acknowledgement boundaries.
- Blob ETags protect every change. A concurrent collector retries against
  acknowledgements instead of overwriting them.
- The collector reads the service baseline, then ingests before writing the new
  Pages snapshot. A later Pages deployment failure cannot lose recorded events.
  The activity feed may temporarily be newer than the status table; the UI shows
  their collection times separately.
- Invalid/unavailable storage is surfaced, never silently reset. A missing
  **state blob** initializes a new generation; a missing container or inaccessible
  account is an error. Do not delete the blob to troubleshoot a failure.
- Old acknowledgement requests cannot hide later sequences. Restore unread targets an
  acknowledgement ID, so it cannot undo a later independent read.
- UI deployments download the existing Pages snapshot byte-for-byte and never
  ingest events. Polling the shared API updates read state only, not GitHub data.
- If Azure is unavailable, the status table and Needs attention remain usable.
  The unread feed reports failure and disables writes; it does not silently
  substitute refresh-cycle activity.

There is no automatic backup policy configured. Preserve a private copy of the
state blob before intentional migration or destructive administration. Restoring
an old backup can restore old read markers; coordinate recovery with users.
For a key rotation, update the GitHub secret and verify protected baseline access
before revoking the prior key. Never print key values in logs or check them into git.
