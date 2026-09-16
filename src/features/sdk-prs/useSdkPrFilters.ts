import { useCallback, useEffect, useMemo, useState } from "react";
import type { Plane, PullRequestRecord } from "../../data/contracts";
import { getNextStep, type NextStepKind } from "./nextStep";

type FilterKey = "search" | "plane" | "nextStep" | "sort";
export interface SdkPrFilters {
  search: string;
  plane: "all" | Plane;
  nextStep: "all" | NextStepKind;
  sort: "newest" | "oldest" | "failures";
}

const defaults: SdkPrFilters = {
  search: "",
  plane: "all",
  nextStep: "all",
  sort: "newest",
};

function isNextStepKind(value: string | null): value is NextStepKind {
  return (
    value === "hold" ||
    value === "draft" ||
    value === "resolve" ||
    value === "review" ||
    value === "waiting" ||
    value === "unknown" ||
    value === "merge"
  );
}

function readFilters(): SdkPrFilters {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const plane = params.get("plane");
  const nextStep = params.get("step");
  const sort = params.get("sort");
  return {
    search: params.get("q") ?? "",
    plane: plane === "management" || plane === "data" ? plane : "all",
    nextStep: isNextStepKind(nextStep) ? nextStep : "all",
    sort: sort === "oldest" || sort === "failures" ? sort : "newest",
  };
}

function writeFilters(filters: SdkPrFilters) {
  const [route] = location.hash.split("?");
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.plane !== "all") params.set("plane", filters.plane);
  if (filters.nextStep !== "all") params.set("step", filters.nextStep);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  const query = params.toString();
  history.replaceState(null, "", `${route || "#/sdk-prs"}${query ? `?${query}` : ""}`);
}

export function filterPullRequests(
  records: PullRequestRecord[],
  filters: SdkPrFilters,
): PullRequestRecord[] {
  const search = filters.search.toLocaleLowerCase();
  return records
    .filter((pr) => filters.plane === "all" || pr.plane === filters.plane)
    .filter(
      (pr) =>
        filters.nextStep === "all" ||
        getNextStep(pr).kind === filters.nextStep,
    )
    .filter((pr) => {
      if (!search) return true;
      return (
        `${pr.number} ${pr.title} ${pr.packages
          .map((pkg) => `${pkg.name ?? ""} ${pkg.root}`)
          .join(" ")}`
          .toLocaleLowerCase()
          .includes(search)
      );
    })
    .sort((left, right) => {
      if (filters.sort === "failures") {
        return (right.checks.failedCount ?? -1) - (left.checks.failedCount ?? -1);
      }
      const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return filters.sort === "oldest" ? -delta : delta;
    });
}

export function useSdkPrFilters() {
  const [filters, setFilters] = useState<SdkPrFilters>(readFilters);
  useEffect(() => {
    const restoreFromUrl = () => setFilters(readFilters());
    addEventListener("hashchange", restoreFromUrl);
    return () => removeEventListener("hashchange", restoreFromUrl);
  }, []);
  const setFilter = useCallback((key: FilterKey, value: string) => {
    setFilters((current) => {
      const next = { ...current, [key]: value } as SdkPrFilters;
      writeFilters(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setFilters(defaults);
    writeFilters(defaults);
  }, []);
  const apply = useCallback(
    (records: PullRequestRecord[]) => filterPullRequests(records, filters),
    [filters],
  );
  return useMemo(
    () => ({ filters, setFilter, reset, apply }),
    [apply, filters, reset, setFilter],
  );
}
