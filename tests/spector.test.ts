import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSpectorReport, SPECTOR_REPORT_URL } from "../scripts/spector";
import { isEmitterSnapshot, type EmitterSnapshot } from "../src/data/emitter-contracts";
import { EmitterDashboardView } from "../src/features/emitter/EmitterDashboard";
import { spectorReport } from "./fixtures/spector";

const parse = (body = spectorReport.body) => parseSpectorReport(body, spectorReport.updated_at);
const snapshot: EmitterSnapshot = {
  schemaVersion: 1, generatedAt: "2026-09-18T00:00:00Z",
  source: { repository: "Azure/typespec-azure", label: "emitter:typescript", fetchedAt: "2026-09-18T00:00:00Z" },
  package: { name: "@azure-tools/typespec-ts", version: "0.57.0", publishedAt: null, url: "https://www.npmjs.com/package/@azure-tools/typespec-ts" },
  issues: [], pullRequests: [],
};

describe("Spector report summary", () => {
  it("extracts per-suite pass rates, versions and report date without bodies", () => {
    expect(parse()).toMatchObject({
      url: SPECTOR_REPORT_URL, reportDate: "2026-09-14",
      suites: [
        { total: 219, passed: 212, failed: 0, notImplemented: 7, coverage: 96.8 },
        { total: 797, passed: 751, failed: 0, notImplemented: 46, coverage: 94.2 },
      ],
    });
    expect(JSON.stringify(parse())).not.toContain("scenario commentary");
    expect(parse(spectorReport.body.replace(/\n/g, "\r\n"))).toEqual(parse());
  });

  it.each([
    "", spectorReport.body.replace("## Summary", "## Different format"),
    spectorReport.body.replace("96.8%", "100%"),
    spectorReport.body.replace("| 219 |", "| 220 |"),
    spectorReport.body.replace("| 212 |", "| -1 |"),
    spectorReport.body.replace("2026-09-14", "unknown"),
  ])("rejects missing or inconsistent report data (%#)", (body) => {
    expect(() => parse(body)).toThrow();
  });

  it("keeps old snapshots compatible and validates new coverage", () => {
    expect(isEmitterSnapshot(snapshot)).toBe(true);
    expect(isEmitterSnapshot({ ...snapshot, coverage: parse() })).toBe(true);
    expect(isEmitterSnapshot({ ...snapshot, coverage: { ...parse(), suites: [] } })).toBe(false);
  });

  it("renders report rates and link in the overview, and warns on old reports", () => {
    const render = (now: string) => renderToStaticMarkup(createElement(EmitterDashboardView, {
      state: { snapshot: { ...snapshot, coverage: parse() }, loading: false, error: null },
      now: Date.parse(now),
    }));
    const html = render("2026-09-18");
    expect(html).toContain("96.8%");
    expect(html).toContain("94.2%");
    expect(html).toContain(SPECTOR_REPORT_URL);
    expect(html).toContain("2026-09-14");
    expect(html).not.toContain("more than 8 days");
    expect(render("2026-09-24")).toContain("more than 8 days");
  });

  it("shows missing coverage explicitly instead of a zero rate", () => {
    const html = renderToStaticMarkup(createElement(EmitterDashboardView, {
      state: { snapshot, loading: false, error: null },
    }));
    expect(html).toContain("Coverage has not been collected yet");
  });
});
