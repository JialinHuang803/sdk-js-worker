import { DashboardState } from "../../shared/DashboardState";
import { Panel } from "../../shared/Panel";
import { EmitterTable, EmitterTime } from "./EmitterTable";
import { useEmitterData, type EmitterDataState } from "./useEmitterData";

export function EmitterDashboard() {
  return <EmitterDashboardView state={useEmitterData()} />;
}

export function EmitterDashboardView({ state, now = Date.now() }: {
  state: EmitterDataState;
  now?: number;
}) {
  const { snapshot, loading, error } = state;
  if (loading) return <DashboardState kind="loading" title="Loading JS emitter data" />;
  if (error) return <DashboardState kind="error" title="Emitter data is unavailable" detail={error} />;
  if (!snapshot) return <DashboardState kind="empty" title="No emitter snapshot found" />;

  const stale = now - Math.min(Date.parse(snapshot.generatedAt), Date.parse(snapshot.source.fetchedAt)) > 26 * 60 * 60_000;
  return (
    <div className="dashboard-stack emitter-dashboard">
      {stale && <div className="freshness-warning" role="status">
        Emitter data is more than 26 hours old. Last fetched <EmitterTime value={snapshot.source.fetchedAt} />.
        {" "}Snapshot generated <EmitterTime value={snapshot.generatedAt} />.
        {" "}Scheduled GitHub Actions refreshes can be delayed.
      </div>}
      <Panel title="JS emitter overview"
        subtitle={`Open work in ${snapshot.source.repository} labeled ${snapshot.source.label}`}>
        <div className="emitter-overview">
          <div className="emitter-overview__package">
            <h3>Latest published npm version</h3>
            <a href={snapshot.package.url} target="_blank" rel="noreferrer">{snapshot.package.name}</a>
            <strong className="emitter-overview__value">{snapshot.package.version}</strong>
            <p>{snapshot.package.publishedAt
              ? <>Published <EmitterTime value={snapshot.package.publishedAt} /></>
              : "Publication date unavailable"}</p>
            <p className="emitter-muted">npm latest dist-tag</p>
          </div>
          <div>
            <h3>Open issues</h3>
            <strong className="emitter-overview__value">{snapshot.issues.length}</strong>
            <p>Matching the emitter label</p>
          </div>
          <div>
            <h3>Open pull requests</h3>
            <strong className="emitter-overview__value">{snapshot.pullRequests.length}</strong>
            <p>{snapshot.pullRequests.filter((pr) => pr.draft).length} draft</p>
          </div>
        </div>
        <p className="emitter-freshness">
          Last fetched <EmitterTime value={snapshot.source.fetchedAt} />
          {" · "}Snapshot generated <EmitterTime value={snapshot.generatedAt} />
        </p>
      </Panel>
      <EmitterTable rows={snapshot.issues} kind="issues" />
      <EmitterTable rows={snapshot.pullRequests} kind="pull requests" />
    </div>
  );
}
