import { describe, expect, it } from "vitest";
import { sdkPlaneFromTitle } from "../src/data/sdk-plane";

describe("SDK plane classification", () => {
  it.each([
    ["[AutoPR @azure-arm-servicebus]-generated-from-SDK Generation", "management"],
    ["[AutoPR SDK generation] changes for azure-arm-example", "management"],
    ["[AutoPR @azure-storage-blob]", "data"],
    ["[AutoPR @azure-communication-identity]", "data"],
    ["[AutoPR @Azure-Arm-example]", "data"],
    ["", "data"],
  ] as const)("classifies %s as %s", (title, plane) => {
    expect(sdkPlaneFromTitle(title)).toBe(plane);
  });
});
