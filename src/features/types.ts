import type { ComponentType } from "react";

export interface DashboardFeature {
  id: string;
  label: string;
  description: string;
  headingContext: string;
  route: `/${string}`;
  repositoryUrl: `https://${string}`;
  refreshWorkflowUrl: `https://${string}`;
  component: ComponentType;
}
