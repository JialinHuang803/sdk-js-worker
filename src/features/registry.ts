import type { DashboardFeature } from "./types";
import { SdkPrDashboard } from "./sdk-prs/SdkPrDashboard";

export const dashboardFeatures: readonly DashboardFeature[] = [
  {
    id: "sdk-prs",
    label: "SDK pull requests",
    description: "AutoPR health, package metadata, and release plans",
    route: "/sdk-prs",
    component: SdkPrDashboard,
  },
];

export function resolveFeature(path: string): DashboardFeature {
  return (
    dashboardFeatures.find((feature) => feature.route === path) ??
    dashboardFeatures[0]
  );
}
