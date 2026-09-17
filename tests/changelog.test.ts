import { describe, expect, it } from "vitest";
import { detectBreakingChanges } from "../scripts/changelog";

const older = `# Release History
## 8.0.0-beta.1 (2026-08-31)
### Breaking Changes
- An older breaking change
`;
const head = `# Release History
## 8.0.0 (2026-09-16)
### Features Added
- Added an operation
### Breaking Changes
- Operation PolicyAssignmentsOperations.delete has a new signature
- Interface PolicyLogInfo no longer has parameter ancestors
${older.replace("# Release History\n", "")}`;

describe("release changelog breaking changes", () => {
  it("detects the new arm-policy release, not just the prior beta", () => {
    expect(detectBreakingChanges(head, older, "8.0.0")).toBe(true);
  });

  it("does not flag older breaking releases or a mention in prose", () => {
    expect(detectBreakingChanges(
      `## 8.0.0\n### Features Added\n- No Breaking Changes in this release\n${older}`,
      older,
      "8.0.0",
    )).toBe(false);
  });

  it("matches the exact package version, including prereleases and linked headings", () => {
    const changelog = `## [8.0.0-beta.1](https://example.test/release)
### Breaking Changes
- Removed a beta API
## 8.0.0-beta.10
### Features Added
- Added API
`;
    expect(detectBreakingChanges(changelog, null, "8.0.0-beta.1")).toBe(true);
    expect(detectBreakingChanges(changelog, null, "8.0.0-beta.10")).toBe(false);
    expect(detectBreakingChanges(changelog, null, "8.0.0")).toBeNull();
  });

  it("does not rediscover an unchanged section already at the PR base", () => {
    expect(detectBreakingChanges(head, head, "8.0.0")).toBe(false);
    expect(detectBreakingChanges(
      head.replace("- Added an operation", "- Added two operations"),
      head,
      "8.0.0",
    )).toBe(false);
  });

  it("detects added breaking entries within an existing release section", () => {
    expect(detectBreakingChanges(
      head.replace("### Breaking Changes", "### Breaking Changes\n- Removed another API"),
      head,
      "8.0.0",
    )).toBe(true);
  });

  it("does not treat removal of a breaking entry as a new breaking change", () => {
    expect(detectBreakingChanges(
      head.replace("- Interface PolicyLogInfo no longer has parameter ancestors\n", ""),
      head,
      "8.0.0",
    )).toBe(false);
  });

  it("ignores empty headings, HTML comments, and fenced examples", () => {
    expect(detectBreakingChanges(`## 8.0.0
\`\`\`md
### Breaking Changes
- Example only
\`\`\`
<!-- ### Breaking Changes
- Comment only -->
### Breaking Changes
<!-- TODO -->
### Features Added
- Added API
`, null, "8.0.0")).toBe(false);
  });

  it("accepts case-insensitive headings, CRLF, and nested breaking details", () => {
    expect(detectBreakingChanges(
      "## v8.0.0\r\n### breaking changes\r\n#### Methods\r\n- Removed API\r\n",
      null,
      "8.0.0",
    )).toBe(true);
  });

  it("reports missing or unrecognized release sections as unknown", () => {
    expect(detectBreakingChanges(null, older, "8.0.0")).toBeNull();
    expect(detectBreakingChanges(head, older, null)).toBeNull();
    expect(detectBreakingChanges("## Unreleased\n### Breaking Changes\n- Removed API", older, "8.0.0")).toBeNull();
  });
});
