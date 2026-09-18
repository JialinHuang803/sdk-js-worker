import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { dashboardFeatures, resolveFeature } from "../src/features/registry";

afterEach(() => vi.unstubAllGlobals());

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
    expect(resolveFeature("/emitter").id).toBe("emitter");
    expect(resolveFeature("/not-a-feature").id).toBe(dashboardFeatures[0].id);
  });

  it("keeps repository and refresh links specific to each feature", () => {
    expect(resolveFeature("/sdk-prs")).toMatchObject({
      headingContext: "Azure SDK for JavaScript",
      repositoryUrl: "https://github.com/Azure/azure-sdk-for-js/pulls",
      refreshWorkflowUrl: "https://github.com/JialinHuang803/sdk-js-worker/actions/workflows/collect-and-deploy.yml",
    });
    expect(resolveFeature("/emitter")).toMatchObject({
      headingContext: "TypeSpec for JavaScript",
      repositoryUrl: "https://github.com/Azure/typespec-azure",
      refreshWorkflowUrl: "https://github.com/JialinHuang803/sdk-js-worker/actions/workflows/collect-emitter.yml",
    });

  });

  it.each(["/sdk-prs", "/emitter"])("renders the correct header actions at %s", (route) => {
    vi.stubGlobal("location", { hash: `#${route}` });
    const feature = resolveFeature(route);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain(`href="${feature.repositoryUrl}"`);
    expect(html).toContain(`href="${feature.refreshWorkflowUrl}"`);
    expect(html).toContain(`<p class="eyebrow">${feature.headingContext}</p>`);
    expect(html).toContain(`href="#${route}" class="active" aria-current="page"`);
  });
});
