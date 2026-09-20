import type {
  DashboardSnapshot,
  InboxCommentActivity,
  PackageMetadata,
  Plane,
} from "./contracts";
import type { ReadAttribution } from "./read-attribution";

export type SharedActivityKind = "new-pr" | "new-commit" | "new-comment" | "merged";

export interface SharedActivityPull {
  repository: string;
  number: number;
  title: string;
  url: string;
  plane: Plane;
  draft: boolean;
  holdOn: boolean;
  state: "open" | "merged" | "closed";
  packages: PackageMetadata[];
}

export interface SharedActivityEvent extends ReadAttribution {
  id: string;
  sequence: number;
  repository: string;
  pullRequestNumber: number;
  kind: SharedActivityKind;
  occurredAt: string;
  comment?: InboxCommentActivity;
}

export interface SharedActivityFeed {
  schemaVersion: 1;
  generation: string;
  revision: number;
  collectedAt: string | null;
  events: SharedActivityEvent[];
  pullRequests: SharedActivityPull[];
}

export interface ActivityBaseline {
  snapshot: DashboardSnapshot | null;
  trackedPullRequests: SharedActivityPull[];
}

export interface ActivityIngestRequest {
  snapshot: DashboardSnapshot;
  inactivePullRequests: SharedActivityPull[];
}

export interface ActivityAcknowledgeRequest {
  generation: string;
  repository: string;
  pullRequestNumber: number;
  throughSequence: number;
}

export interface ActivityRestoreRequest {
  generation: string;
  acknowledgementIds: string[];
}

export interface ActivityMutationResponse {
  feed: SharedActivityFeed;
  acknowledgementId: string | null;
}
