# Shared activity operations

## Deployed resources

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

## Routes and permissions

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

## Provision and deploy

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

## Consistency and recovery

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
