import { useCallback, useEffect, useMemo, useState } from "react";
import type { Plane, PullRequestRecord } from "../../data/contracts";

type FilterKey = "search" | "plane" | "status" | "sort";
interface Filters {
  search: string;
  plane: "all" | Plane;
  status: "all" | "failing" | "conflicts" | "draft";
  sort: "newest" | "oldest" | "failures";
}

const defaults: Filters = {
  search: "",
  plane: "all",
  status: "all",
  sort: "newest",
};

function readFilters(): Filters {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const plane = params.get("plane");
  const status = params.get("status");
  const sort = params.get("sort");
  return {
    search: params.get("q") ?? "",
    plane: plane === "management" || plane === "data" ? plane : "all",
    status:
      status === "failing" || status === "conflicts" || status === "draft"
        ? status
        : "all",
    sort: sort === "oldest" || sort === "failures" ? sort : "newest",
  };
}

function writeFilters(filters: Filters) {
  const [route] = location.hash.split("?");
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.plane !== "all") params.set("plane", filters.plane);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  const query = params.toString();
  history.replaceState(null, "", `${route || "#/sdk-prs"}${query ? `?${query}` : ""}`);
}

export function useSdkPrFilters() {
  const [filters, setFilters] = useState<Filters>(readFilters);
  useEffect(() => {
    const restoreFromUrl = () => setFilters(readFilters());
    addEventListener("hashchange", restoreFromUrl);
    return () => removeEventListener("hashchange", restoreFromUrl);
  }, []);
  const setFilter = useCallback((key: FilterKey, value: string) => {
    setFilters((current) => {
      const next = { ...current, [key]: value } as Filters;
      writeFilters(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setFilters(defaults);
    writeFilters(defaults);
  }, []);
  const apply = useCallback(
    (records: PullRequestRecord[]) => {
      const search = filters.search.toLocaleLowerCase();
      return records
        .filter((pr) => filters.plane === "all" || pr.plane === filters.plane)
        .filter((pr) => {
          if (filters.status === "failing") return (pr.checks.failedCount ?? 0) > 0;
          if (filters.status === "conflicts") return pr.conflicts === true;
          if (filters.status === "draft") return pr.draft;
          return true;
        })
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
    },
    [filters],
  );
  return useMemo(
    () => ({ filters, setFilter, reset, apply }),
    [apply, filters, reset, setFilter],
  );
}
