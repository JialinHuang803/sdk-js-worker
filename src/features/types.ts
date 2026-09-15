import type { ComponentType } from "react";

export interface DashboardFeature {
  id: string;
  label: string;
  description: string;
  route: `/${string}`;
  component: ComponentType;
}
