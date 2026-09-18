export interface EmitterIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  comments: number;
}

export interface EmitterPullRequest extends EmitterIssue {
  draft: boolean;
}

export interface EmitterSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  source: { repository: string; label: string; fetchedAt: string };
  package: { name: string; version: string; publishedAt: string | null; url: string };
  issues: EmitterIssue[];
  pullRequests: EmitterPullRequest[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function isWebUrl(value: unknown): value is string {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

function isIssue(value: unknown): value is EmitterIssue {
  return isRecord(value) &&
    Number.isSafeInteger(value.number) && (value.number as number) > 0 &&
    isText(value.title) && isWebUrl(value.url) &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    (value.author === null || isText(value.author)) &&
    isStringArray(value.assignees) && isStringArray(value.labels) &&
    Number.isSafeInteger(value.comments) && (value.comments as number) >= 0;
}

export function isEmitterSnapshot(value: unknown): value is EmitterSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !isTimestamp(value.generatedAt) || !isRecord(value.source) ||
    !isRecord(value.package)) return false;
  return isText(value.source.repository) && isText(value.source.label) &&
    isTimestamp(value.source.fetchedAt) &&
    isText(value.package.name) && isText(value.package.version) &&
    (value.package.publishedAt === null || isTimestamp(value.package.publishedAt)) &&
    isWebUrl(value.package.url) &&
    Array.isArray(value.issues) && value.issues.every(isIssue) &&
    Array.isArray(value.pullRequests) && value.pullRequests.every(
      (pr: unknown) => isIssue(pr) && "draft" in pr && typeof pr.draft === "boolean",
    );
}
