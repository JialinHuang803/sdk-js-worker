import { describe, expect, it } from "vitest";
import { dashboardFeatures, resolveFeature } from "../src/features/registry";

describe("dashboard feature registry", () => {
  it("uses unique IDs and routes", () => {
    expect(new Set(dashboardFeatures.map((feature) => feature.id)).size).toBe(
      dashboardFeatures.length,
    );
    expect(new Set(dashboardFeatures.map((feature) => feature.route)).size).toBe(
      dashboardFeatures.length,
    );
  });

  it("resolves known routes and falls back safely", () => {
    expect(resolveFeature("/sdk-prs").id).toBe("sdk-prs");
    expect(resolveFeature("/not-a-feature").id).toBe(dashboardFeatures[0].id);
  });
});
