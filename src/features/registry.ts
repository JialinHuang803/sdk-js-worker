import type { DashboardFeature } from "./types";
import { SdkPrDashboard } from "./sdk-prs/SdkPrDashboard";
import { EmitterDashboard } from "./emitter/EmitterDashboard";

export const dashboardFeatures: readonly DashboardFeature[] = [
  {
    id: "sdk-prs",
    label: "SDK pull requests",
    description: "AutoPR health, package metadata, and release plans",
    headingContext: "Azure SDK for JavaScript",
    route: "/sdk-prs",
    repositoryUrl: "https://github.com/Azure/azure-sdk-for-js/pulls",
    refreshWorkflowUrl: "https://github.com/JialinHuang803/sdk-js-worker/actions/workflows/collect-and-deploy.yml",
    component: SdkPrDashboard,
  },
  {
    id: "emitter",
    label: "JS emitter",
    description: "Latest published version, open issues, and pull requests",
    headingContext: "TypeSpec for JavaScript",
    route: "/emitter",
    repositoryUrl: "https://github.com/Azure/typespec-azure",
    refreshWorkflowUrl: "https://github.com/JialinHuang803/sdk-js-worker/actions/workflows/collect-emitter.yml",
    component: EmitterDashboard,
  },
];

export function resolveFeature(path: string): DashboardFeature {
  return (
    dashboardFeatures.find((feature) => feature.route === path) ??
    dashboardFeatures[0]
  );
}
