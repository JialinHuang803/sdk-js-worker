export const DASHBOARD_SCHEMA_VERSION = 3 as const;

export type Plane = "management" | "data";
export type Completeness = "complete" | "partial";
export type CheckQualification =
  | "complete"
  | "pending"
  | "no-checks"
  | "cancelled"
  | "partial"
  | "unknown";
export type ReviewDecision =
  | "approved"
  | "review-required"
  | "changes-requested"
  | "not-required"
  | "unknown";
export type InboxReason =
  | "merged"
  | "new-pr"
  | "new-commit"
  | "new-comment"
  | "review-needed"
  | "ci-failure";
export type CommentKind =
  | "conversation"
  | "review-comment"
  | "review-summary";

export interface ApiVersion {
  namespace: string;
  versions: string[];
}

export interface PackageMetadata {
  root: string;
  name: string | null;
  version: string | null;
  apiVersions: ApiVersion[];
  state: "available" | "metadata-missing" | "missing" | "removed";
  note?: string;
  breakingChanges?: boolean | null;
  changelogUrl?: string;
}

export interface PullRequestRecord {
  repository: string;
  number: number;
  url: string;
  title: string;
  draft: boolean;
  holdOn: boolean;
  plane: Plane;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  releasePlanUrl: string | null;
  reviewDecision: ReviewDecision;
  packages: PackageMetadata[];
  checks: {
    failedCount: number | null;
    qualification: CheckQualification;
    observedCount: number;
  };
  conflicts: boolean | null;
  completeness: {
    changedFiles: Completeness;
    checks: Completeness;
    metadata: Completeness;
    reviews: Completeness;
  };
  warnings: string[];
}

export interface InboxCommentActivity {
  id: string;
  kind: CommentKind;
  author: string;
  createdAt: string;
  url: string;
}

export interface ReviewInboxItem {
  repository: string;
  pullRequestNumber: number;
  reasons: InboxReason[];
  activityAt: string;
  comments: InboxCommentActivity[];
}

export interface MergedPullRequestRecord {
  repository: string;
  number: number;
  url: string;
  title: string;
  plane: Plane;
  holdOn: boolean;
  headSha: string;
  mergedAt: string;
}

export interface ReviewInbox {
  comparisonFrom: string | null;
  generatedAt: string;
  baselineAvailable: boolean;
  defaultPlane: Plane;
  items: ReviewInboxItem[];
}

export interface DashboardSnapshot {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  generatedAt: string;
  stale: boolean;
  collectionError?: string;
  source: {
    repository: string;
    query: string;
    fetchedAt: string;
  };
  inbox: ReviewInbox;
  pullRequests: PullRequestRecord[];
  mergedPullRequests?: MergedPullRequestRecord[];
}

export function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DashboardSnapshot>;
  return (
    snapshot.schemaVersion === DASHBOARD_SCHEMA_VERSION &&
    typeof snapshot.generatedAt === "string" &&
    typeof snapshot.stale === "boolean" &&
    Array.isArray(snapshot.inbox?.items) &&
    Array.isArray(snapshot.pullRequests) &&
    typeof snapshot.source?.repository === "string"
  );
}
