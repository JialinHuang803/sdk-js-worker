# Local GitHub-backed shared activity prototype

This is an opt-in local implementation, not a production migration. It does not
change the deployed Azure API, GitHub repository variables/secrets, workflows,
published snapshots or read markers. The existing deployment remains unchanged.
The individual DDFun subscription is not an approved home for a shared team
service; do not undo administrator network remediation to run this prototype.

## Architecture

The Vite dashboard proxies `/api` to a loopback-only Node server. That server
handles GitHub sign-in and stores SDK and emitter activity in two JSON files on
a dedicated Git branch using GitHub App installation credentials. It reuses the
existing activity engines, including per-PR grouping, sequence-bounded
acknowledgements, independent attention, optimistic concurrency and three-day
read recovery. There is no Azure dependency in this execution path.

Public feed reads remain anonymous. Mark read, restore and logout require an
allowlisted GitHub user, an expiring HttpOnly session cookie, an exact matching
Origin and a session-specific CSRF token. OAuth uses state, browser binding and
PKCE. Collector baseline/ingest endpoints use a separate server-side ingestion
key; they never accept a browser session instead.

The GitHub App must be installed on the **state repository only**, not on
Azure/azure-sdk-for-js or Azure/typespec-azure. Contents write permission applies
to a repository, not just one branch. Prefer a dedicated private state repository
to avoid granting the app write access to dashboard source code. Only the
sanitized public feed is returned to dashboard browsers. Never put an app private
key, client secret, installation token or ingestion key in a `VITE_` variable.

## Prerequisites the owner must supply

1. An initialized state repository with a default branch and a separate branch
   named `dashboard-state`. Create the branch explicitly; the API never creates
   branches or falls back to `main` when state is missing.
2. A GitHub App, registered for this local prototype. Set its homepage to
   `http://127.0.0.1:5173/sdk-js-worker/` and user-authorization callback to
   `http://127.0.0.1:5173/api/auth/callback`. Disable webhooks; none are required.
   Enable only repository **Contents: Read and write** (Metadata read is
   implicit). No organization permissions are needed.
3. Install the app for the selected state repository and obtain its app ID,
   client ID, installation ID, client secret and generated RSA private key.
   User authorization alone is not an app installation.
4. Explicit GitHub usernames allowed to mark/restore read state. The app's
   installation performs writes after this allowlist check; users do not need
   direct state-repository write permission. Everyone on the list can change
   the shared read state. Sign-in is mandatory for mutations in this mode.

Use a different local app/ingestion key from any production deployment.
Do not paste credentials into chat, commit them, or pass them in URLs.

## Local setup

Requires Node.js 22+ and the existing root dependencies (`npm ci` using the
repository's documented feed configuration). No additional dependencies are
needed for the Node API.

Copy `.env.github.example` to `.env.github.local`. Fill in the server-side
settings locally. Store the private key outside the repository where practical,
or in ignored `.local/github-app.pem`; the Vite dev server denies `.local` and
PEM-file access. Generate a separate random ingestion key of at least 32 bytes.
Use `127.0.0.1` consistently: switching between localhost and 127.0.0.1 changes
cookie and OAuth origins.

Before serving state, explicitly initialize each source in the **test state
repository**. For a completely new, empty local experiment:

```powershell
npm run activity:github:init -- sdk --empty
npm run activity:github:init -- emitter --empty
```

An empty state has no collected baseline; the UI will not claim that its feed
is fresh or enable read actions until a valid snapshot has been ingested.
Do not use empty initialization as a substitute for migrating existing history.

For a new test repository, you can instead start the SDK inbox from the
checked-in sanitized snapshot, without collecting anything or modifying Azure:

```powershell
npm run activity:github:init -- sdk --snapshot public\data\sdk-prs.json
```

This starts a **new test history** using only the supplied snapshot's activity
window; it is not a migration and cannot preserve older unread/read state.
The emitter source accepts the same option with a valid emitter snapshot that
contains an `activity` section, but starts with inventory only and no unread
events; later collections use that snapshot as the baseline. Choose one initialization method per source;
all methods refuse to overwrite an existing state file.

To preserve existing history, supply complete, authorized exports of the private
Azure state blobs (`activity/state.json` and `activity/emitter-state.json`), not
just the public feed or Pages snapshot:

```powershell
npm run activity:github:init -- sdk --import .local\sdk-export.json
npm run activity:github:init -- emitter --import .local\emitter-export.json
```

Imports preserve generation, sequence boundaries, read markers and the canonical
collector baseline. The initializer validates each file and refuses to replace
existing state. Obtain exports through approved access only; this tool does not
change Azure networking or retrieve exports for you. Review exports before
uploading them. SDK and emitter initialization are separate operations, so retry
only the missing source if one succeeds and the other fails.

Start the API and UI in separate terminals:

```powershell
npm run activity:github
```

```powershell
npm run dev -- --mode github --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/sdk-js-worker/`. Sign in with an allowlisted GitHub
account, then mark/restore read state in either inbox. The button remains pending
until GitHub accepts the write; failures remain visible instead of pretending
success. Other browsers receive the change on their next feed poll.

`GET /api/health` confirms only that the local HTTP server is running, not that
GitHub credentials or state are usable. Open the inbox to exercise real storage.
The API listens on `127.0.0.1:8787` only, even if an HTTPS origin is configured.

## Collection and deployment boundaries

The protected `/api/activity/baseline`, `/api/activity/ingest`,
`/api/emitter-activity/baseline` and `/api/emitter-activity/ingest` retain the
existing collector contracts, including the `x-functions-key` header name.
The name is retained for compatibility; this Node service is not an Azure
Function. The existing collector clients intentionally require HTTPS. No
workflow is switched to loopback HTTP or to this service, and GitHub-hosted
runners cannot reach your local machine.

For local fixtures, use a local HTTP client to submit a sanitized, valid ingest
body with the ingestion key header. Do not run the existing production seed
command to recover missing history: it cannot reconstruct acknowledged events.

Production requires an approved HTTPS host, secret management, same-origin
API routing or an explicitly designed cross-origin session strategy, and
appropriate authentication/authorization review. The current frontend uses
same-origin cookie authentication. Merely setting a cross-origin API URL is not
a supported deployment strategy. In-memory OAuth/session state is intentionally
single-process: restart signs users out, while committed activity remains
durable. Multiple backend instances need a deliberate session design.

## Limits and retention

- The server requests a short-lived installation token restricted to the state
  repository and Contents write. No user OAuth access token is persisted after
  the identity check. Git commits use the app identity; they are not a per-user
  audit log of acknowledgements.
- Each successful changed-state write creates a Git commit. File SHA checks
  detect concurrent writers; both engines re-read and apply the operation again
  with bounded retries. New events after an acknowledged sequence stay unread.
- A missing file, invalid state, unavailable repository or missing branch is
  an error, never an automatic reset. Corrupt history is not overwritten.
- Read details disappear from the latest feed after 72 hours on the next access.
  **They remain in Git history.** This is not physical three-day data deletion.
  Unread events never automatically expire.
- The initial implementation caps each state file at 900,000 bytes, below the
  Contents API's 1 MiB JSON-file limit. It fails explicitly if archival becomes
  necessary; sharded/archived history is not implemented.
- Private state is the default. `GITHUB_STATE_ALLOW_PUBLIC=true` is an explicit
  acknowledgement that history, read timestamps and snapshots will be public,
  including prior commits. It is not needed for a publicly readable dashboard.
- Both HTTP and activity-engine limits are coarse protections, not DDoS or
  billing safeguards. GitHub rate limits still apply. No arbitrary issue,
  filename, repository or branch write is accepted from the browser.

Before a future production cutover, preserve/export existing state, import into
the approved destination, verify both inboxes, then coordinate collector and
frontend configuration changes. Do not deploy a new empty inbox over the old
one or switch collectors while read-state writers are still using another store.
