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

export interface SpectorSuite {
  name: string;
  version: string;
  total: number;
  passed: number;
  failed: number;
  notImplemented: number;
  coverage: number;
}

export interface SpectorCoverage {
  url: string;
  reportDate: string;
  updatedAt: string;
  suites: SpectorSuite[];
}

export interface EmitterSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  source: { repository: string; label: string; fetchedAt: string };
  package: { name: string; version: string; publishedAt: string | null; url: string };
  issues: EmitterIssue[];
  pullRequests: EmitterPullRequest[];
  coverage?: SpectorCoverage;
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

export function isSpectorCoverage(value: unknown): value is SpectorCoverage {
  if (!isRecord(value) || !isWebUrl(value.url) ||
      !isTimestamp(value.reportDate) || !isTimestamp(value.updatedAt) ||
      !Array.isArray(value.suites) || value.suites.length === 0) return false;
  return value.suites.every((suite: unknown) => {
    if (!isRecord(suite)) return false;
    const { total, passed, failed, notImplemented, coverage } = suite;
    return isText(suite.name) && isText(suite.version) &&
      typeof total === "number" && Number.isSafeInteger(total) && total > 0 &&
      typeof passed === "number" && Number.isSafeInteger(passed) && passed >= 0 &&
      typeof failed === "number" && Number.isSafeInteger(failed) && failed >= 0 &&
      typeof notImplemented === "number" && Number.isSafeInteger(notImplemented) && notImplemented >= 0 &&
      passed + failed + notImplemented === total &&
      typeof coverage === "number" && Number.isFinite(coverage) &&
      coverage >= 0 && coverage <= 100 &&
      Math.abs(coverage - passed / total * 100) <= 0.051;
  });
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
    (value.coverage === undefined || isSpectorCoverage(value.coverage)) &&
    Array.isArray(value.issues) && value.issues.every(isIssue) &&
    Array.isArray(value.pullRequests) && value.pullRequests.every(
      (pr: unknown) => isIssue(pr) && "draft" in pr && typeof pr.draft === "boolean",
    );
}
