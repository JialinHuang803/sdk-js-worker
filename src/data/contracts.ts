export const DASHBOARD_SCHEMA_VERSION = 1 as const;

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
}

export interface PullRequestRecord {
  repository: string;
  number: number;
  url: string;
  title: string;
  draft: boolean;
  plane: Plane;
  headSha: string;
  createdAt: string;
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
  pullRequests: PullRequestRecord[];
}

export function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DashboardSnapshot>;
  return (
    snapshot.schemaVersion === DASHBOARD_SCHEMA_VERSION &&
    typeof snapshot.generatedAt === "string" &&
    typeof snapshot.stale === "boolean" &&
    Array.isArray(snapshot.pullRequests) &&
    typeof snapshot.source?.repository === "string"
  );
}
