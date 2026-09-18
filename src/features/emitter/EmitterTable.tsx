import { useState } from "react";
import type { EmitterIssue, EmitterPullRequest } from "../../data/emitter-contracts";
import { DashboardState } from "../../shared/DashboardState";
import { Panel } from "../../shared/Panel";

type EmitterRow = EmitterIssue | EmitterPullRequest;
export interface EmitterFilters {
  search: string;
  label: string;
  draft: "all" | "draft" | "ready";
}
const initialFilters: EmitterFilters = { search: "", label: "", draft: "all" };

export function filterEmitterRows<T extends EmitterRow>(rows: T[], filters: EmitterFilters): T[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter((row) =>
    (!query || [
      row.title, String(row.number), `#${row.number}`, row.author ?? "",
      ...row.assignees, ...row.labels,
    ].some((value) => value.toLowerCase().includes(query))) &&
    (!filters.label || row.labels.includes(filters.label)) &&
    (filters.draft === "all" || ("draft" in row &&
      row.draft === (filters.draft === "draft"))),
  ).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
}

export function EmitterTime({ value }: { value: string }) {
  return <time dateTime={value} title={value}>{new Date(value).toLocaleString()}</time>;
}

export function EmitterTable({ rows, kind }: {
  rows: EmitterRow[];
  kind: "issues" | "pull requests";
}) {
  const [filters, setFilters] = useState(initialFilters);
  const visible = filterEmitterRows(rows, filters);
  const labels = [...new Set(rows.flatMap((row) => row.labels))].sort();
  const isPr = kind === "pull requests";
  return (
    <Panel title={isPr ? "Open pull requests" : "Open issues"}
      subtitle={`${visible.length} of ${rows.length} open ${kind} · Most recently updated first`}>
      <div className="filters">
        <label className="search-field">
          <span>Search {kind}</span>
          <input type="search" value={filters.search} placeholder="Title, number, author, assignee, or label"
            onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        </label>
        <label>
          <span>Label</span>
          <select value={filters.label}
            onChange={(event) => setFilters({ ...filters, label: event.target.value })}>
            <option value="">All labels</option>
            {labels.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        {isPr && <label>
          <span>Draft status</span>
          <select value={filters.draft}
            onChange={(event) => setFilters({ ...filters, draft: event.target.value as EmitterFilters["draft"] })}>
            <option value="all">All pull requests</option>
            <option value="ready">Non-draft</option>
            <option value="draft">Draft</option>
          </select>
        </label>}
        <button type="button" className="button-secondary"
          onClick={() => setFilters(initialFilters)}>Reset</button>
      </div>
      {visible.length === 0 ? <DashboardState kind="empty"
        title={rows.length ? `No ${kind} match these filters` : `No open ${kind}`}
        detail={rows.length ? "Try a different search or reset the filters." : "No matching open work was found in the latest snapshot."} /> :
        <div className="table-scroll">
          <table className="emitter-table" aria-label={`Open emitter ${kind}`}>
            <thead><tr>
              <th scope="col">{isPr ? "Pull request" : "Issue"}</th>
              <th scope="col">Author / assignees</th>
              <th scope="col">Comments</th>
              <th scope="col">Updated / created</th>
            </tr></thead>
            <tbody>{visible.map((row) => <tr key={row.number}>
              <td className="emitter-table__title">
                <a href={row.url} target="_blank" rel="noreferrer">#{row.number} {row.title}</a>
                <div className="badges">
                  {"draft" in row && row.draft && <span className="badge badge--warning">Draft</span>}
                  {row.labels.map((label) => <span className="badge" key={label}>{label}</span>)}
                </div>
              </td>
              <td>
                <div>{row.author ?? "Unknown author"}</div>
                <div className="emitter-muted">
                  {row.assignees.length ? `Assigned: ${row.assignees.join(", ")}` : "Unassigned"}
                </div>
              </td>
              <td>{row.comments}</td>
              <td className="emitter-table__dates">
                <div>Updated <EmitterTime value={row.updatedAt} /></div>
                <div className="emitter-muted">Created <EmitterTime value={row.createdAt} /></div>
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
    </Panel>
  );
}
