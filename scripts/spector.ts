import { isSpectorCoverage, type SpectorCoverage, type SpectorSuite } from "../src/data/emitter-contracts.ts";

export const SPECTOR_REPORT_URL = "https://github.com/Azure/typespec-azure/issues/5313";

export function parseSpectorReport(body: string, updatedAt: string): SpectorCoverage {
  const reportDate = body.match(/^# .*Spector Coverage Report[^\n]*?(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  // Limit parsing to the summary table, not the scenario tables that follow it.
  const section = body.split(/^## Summary\s*$/m)[1]?.split(/^## /m)[0];
  const suites: SpectorSuite[] = [];
  for (const line of (section ?? "").split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
    if (!cells[0]?.startsWith("`@")) continue;
    if (cells.length !== 7 || !cells.slice(2, 6).every((cell) => /^\d+$/.test(cell)) ||
        !/^\d+(?:\.\d+)?%$/.test(cells[6])) {
      throw new Error("Spector report summary has an unsupported row format");
    }
    suites.push({
      name: cells[0].replace(/`/g, ""),
      version: cells[1],
      total: Number(cells[2]),
      passed: Number(cells[3]),
      failed: Number(cells[4]),
      notImplemented: Number(cells[5]),
      coverage: Number(cells[6].slice(0, -1)),
    });
  }
  const result = { url: SPECTOR_REPORT_URL, reportDate: reportDate ?? "", updatedAt, suites };
  if (!isSpectorCoverage(result)) throw new Error("Spector report summary is missing or inconsistent");
  return result;
}
