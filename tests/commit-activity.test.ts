import { describe, expect, it, vi } from "vitest";
import { hasOnlyExcludedCommits, type CommitComparison } from "../scripts/commit-activity";
import { isDashboardConfig, loadDashboardConfig } from "../scripts/inbox";

function comparison(
  logins: Array<string | null>,
  overrides: Partial<CommitComparison> = {},
): CommitComparison {
  return {
    status: "ahead",
    total_commits: logins.length,
    commits: logins.map((login, i) => ({
      sha: `sha-${i}`, author: login === null ? null : { login },
    })),
    ...overrides,
  };
}

describe("commit author exclusions", () => {
  it("matches GitHub author logins case-insensitively, with wildcard support", async () => {
    expect(await hasOnlyExcludedCommits(
      ["kazrael2119"], async () => comparison(["KAZRAEL2119", "kazrael2119"]),
    )).toBe(true);
    expect(await hasOnlyExcludedCommits(
      ["automation*"], async () => comparison(["automation[bot]"]),
    )).toBe(true);
  });

  it("retains mixed-author updates even when the most recent commit is excluded", async () => {
    expect(await hasOnlyExcludedCommits(
      ["kazrael2119"], async () => comparison(["service-team", "kazrael2119"]),
    )).toBe(false);
    expect(await hasOnlyExcludedCommits(
      ["kazrael2119"], async () => comparison(["kazrael2119", "service-team"]),
    )).toBe(false);
  });

  it("keeps commits with an unknown or unlinked author", async () => {
    expect(await hasOnlyExcludedCommits(
      ["*"], async () => comparison(["kazrael2119", null]),
    )).toBe(false);
  });

  it("checks beyond the first 100 commits before suppressing activity", async () => {
    const first = comparison(Array<string>(100).fill("kazrael2119"), { total_commits: 101 });
    const second = comparison(["kazrael2119"], {
      total_commits: 101, commits: [{ sha: "sha-100", author: { login: "kazrael2119" } }],
    });
    const getPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await hasOnlyExcludedCommits(["kazrael2119"], getPage)).toBe(true);
    expect(getPage.mock.calls).toEqual([[1], [2]]);
    const mixedPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(
      comparison(["service-team"], { total_commits: 101 }),
    );
    expect(await hasOnlyExcludedCommits(["kazrael2119"], mixedPage)).toBe(false);
  });

  it("does not suppress empty comparisons or history rewinds", async () => {
    for (const status of ["ahead", "behind", "identical"]) {
      expect(await hasOnlyExcludedCommits(
        ["kazrael2119"], async () => comparison([], { status }),
      )).toBe(false);
    }
    expect(await hasOnlyExcludedCommits(
      ["kazrael2119"], async () => comparison(["kazrael2119"], { status: "diverged" }),
    )).toBe(true);
  });

  it("surfaces missing/truncated pages and API failures instead of excluding activity", async () => {
    await expect(hasOnlyExcludedCommits(
      ["kazrael2119"], async () => comparison(["kazrael2119"], { total_commits: 2 }),
    )).rejects.toThrow("incomplete");
    const repeated = comparison(Array<string>(100).fill("kazrael2119"), { total_commits: 101 });
    await expect(hasOnlyExcludedCommits(
      ["kazrael2119"], async () => repeated,
    )).rejects.toThrow("incomplete");
    await expect(hasOnlyExcludedCommits(
      ["kazrael2119"], async () => { throw new Error("404"); },
    )).rejects.toThrow("404");
  });

  it("does not fetch commit metadata when exclusions are disabled", async () => {
    const getPage = vi.fn();
    expect(await hasOnlyExcludedCommits([], getPage)).toBe(false);
    expect(getPage).not.toHaveBeenCalled();
  });

  it("loads the configured exclusion and validates optional settings independently of comments", async () => {
    const config = await loadDashboardConfig();
    expect(config.activity.excludedCommitAuthorPatterns).toEqual(["kazrael2119"]);
    for (const setting of [undefined, [], ["some-user", "bot*"]]) {
      expect(isDashboardConfig({
        ...config, activity: { ...config.activity, excludedCommitAuthorPatterns: setting },
      })).toBe(true);
    }
    for (const setting of ["kazrael2119", [""], [123], null]) {
      expect(isDashboardConfig({
        ...config, activity: { ...config.activity, excludedCommitAuthorPatterns: setting },
      })).toBe(false);
    }
  });
});
