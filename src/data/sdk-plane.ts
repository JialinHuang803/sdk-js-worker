import type { Plane } from "./contracts";

export function sdkPlaneFromTitle(title: string): Plane {
  return title.includes("azure-arm") ? "management" : "data";
}
