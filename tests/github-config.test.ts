import { describe, expect, it } from "vitest";
import { loadGitHubConfig } from "../api/src/github/config";

const settings = {
  GITHUB_STATE_REPOSITORY: "example/state", GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_ALLOWED_USERS: "reviewer", ACTIVITY_INGEST_KEY: "test-ingest-key-with-at-least-32-bytes",
};

describe("local GitHub configuration", () => {
  it("requires server credentials instead of falling back to production or anonymous writes", () => {
    expect(() => loadGitHubConfig({})).toThrow("GITHUB_STATE_REPOSITORY");
    expect(() => loadGitHubConfig(settings)).toThrow("GITHUB_APP_PRIVATE_KEY_FILE");
  });
  it("rejects public HTTP, URL credentials, origin paths and wildcard reviewers", () => {
    for (const origin of [
      "http://dashboard.example", "http://user:password@127.0.0.1:5173",
      "http://127.0.0.1:5173/path", "https://dashboard.example/#fragment",
    ]) {
      expect(() => loadGitHubConfig({ ...settings, ACTIVITY_WEB_ORIGIN: origin })).toThrow("origin");
    }
    expect(() => loadGitHubConfig({ ...settings, GITHUB_ALLOWED_USERS: "*" })).toThrow("logins");
  });
  it("rejects path injection and short collector credentials", () => {
    expect(() => loadGitHubConfig({ ...settings, GITHUB_STATE_REPOSITORY: "../example/state" })).toThrow("owner/repo");
    expect(() => loadGitHubConfig({ ...settings, GITHUB_STATE_BRANCH: "../main" })).toThrow("branch");
    expect(() => loadGitHubConfig({ ...settings, ACTIVITY_INGEST_KEY: "short" })).toThrow("32 bytes");
  });
});
