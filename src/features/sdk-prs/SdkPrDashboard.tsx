import { useMemo } from "react";
import { DashboardState } from "../../shared/DashboardState";
import { Panel } from "../../shared/Panel";
import { useSdkPrData } from "./useSdkPrData";
import { useSdkPrFilters } from "./useSdkPrFilters";
import { PrTable } from "./PrTable";
import { ReviewInbox } from "./ReviewInbox";
import { SdkPrReport } from "./SdkPrReport";

export function SdkPrDashboard() {
  const { snapshot, error, loading } = useSdkPrData();
  const { filters, setFilter, reset, apply } = useSdkPrFilters();
  const rows = useMemo(
    () => (snapshot ? apply(snapshot.pullRequests) : []),
    [apply, snapshot],
  );

  if (loading) return <DashboardState kind="loading" title="Loading pull requests" />;
  if (error) {
    return (
      <DashboardState
        kind="error"
        title="Dashboard data is unavailable"
        detail={error}
      />
    );
  }
  if (!snapshot) {
    return <DashboardState kind="empty" title="No dashboard snapshot found" />;
  }

  const ageMinutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(snapshot.generatedAt)) / 60_000),
  );
  const stale = snapshot.stale || ageMinutes > 26 * 60;

  return (
    <div className="dashboard-stack">
      {stale && (
        <div className="freshness-warning" role="status">
          Data is {snapshot.stale ? "marked stale" : `${ageMinutes} minutes old`}.
          Scheduled GitHub Actions refreshes can be delayed.
        </div>
      )}

      <SdkPrReport snapshot={snapshot} />

      <ReviewInbox snapshot={snapshot} />

      <Panel
        title="SDK pull requests"
        subtitle={`Updated ${new Date(snapshot.generatedAt).toLocaleString()} · ${snapshot.source.repository}`}
      >
        <div className="filters">
          <label className="search-field">
            <span>Search</span>
            <input
              type="search"
              value={filters.search}
              placeholder="Package, title, or PR number"
              onChange={(event) => setFilter("search", event.target.value)}
            />
          </label>
          <FilterSelect
            label="Plane"
            value={filters.plane}
            onChange={(value) => setFilter("plane", value)}
            options={[
              ["all", "All planes"],
              ["management", "Management"],
              ["data", "Data"],
            ]}
          />
          <FilterSelect
            label="Next step"
            value={filters.nextStep}
            onChange={(value) => setFilter("nextStep", value)}
            options={[
              ["all", "All next steps"],
              ["hold", "HoldOn"],
              ["resolve", "Needs resolution"],
              ["review", "Review needed"],
              ["waiting", "Waiting for checks"],
              ["merge", "Wait to merge"],
              ["draft", "Draft in progress"],
              ["unknown", "Status unavailable"],
            ]}
          />
          <FilterSelect
            label="Sort"
            value={filters.sort}
            onChange={(value) => setFilter("sort", value)}
            options={[
              ["newest", "Newest"],
              ["oldest", "Oldest"],
              ["failures", "Most failures"],
            ]}
          />
          <button className="button-secondary" type="button" onClick={reset}>
            Reset
          </button>
        </div>
        {rows.length === 0 ? (
          <DashboardState
            kind="empty"
            title="No pull requests match these filters"
          />
        ) : (
          <PrTable rows={rows} now={new Date(snapshot.generatedAt)} />
        )}
      </Panel>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option value={optionValue} key={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
