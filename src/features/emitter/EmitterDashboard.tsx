import { DashboardState } from "../../shared/DashboardState";
import { Panel } from "../../shared/Panel";
import { EmitterTime } from "./EmitterTable";
import { EmitterWorkPane } from "./EmitterWorkPane";
import { unavailableEmitterActivity, useEmitterActivity, type EmitterActivityActions, type EmitterActivityState } from "./useEmitterActivity";
import { useEmitterData, type EmitterDataState } from "./useEmitterData";

export function EmitterDashboard() {
  const state = useEmitterData();
  const activity = useEmitterActivity(import.meta.env.VITE_ACTIVITY_API_URL);
  return <EmitterDashboardView state={state} activity={activity} actions={activity} />;
}

export function EmitterDashboardView({ state, activity = unavailableEmitterActivity, actions, now = Date.now() }: {
  state: EmitterDataState;
  activity?: EmitterActivityState;
  actions?: EmitterActivityActions;
  now?: number;
}) {
  const { snapshot, loading, error } = state;
  if (loading) return <DashboardState kind="loading" title="Loading JS emitter data" />;
  if (error) return <DashboardState kind="error" title="Emitter data is unavailable" detail={error} />;
  if (!snapshot) return <DashboardState kind="empty" title="No emitter snapshot found" />;

  const liveWork = activity.feed?.collectedAt &&
    Date.parse(activity.feed.collectedAt) >= Date.parse(snapshot.source.fetchedAt) ? activity.feed : null;
  const issues = liveWork?.issues ?? snapshot.issues;
  const pullRequests = liveWork?.pullRequests ?? snapshot.pullRequests;
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
            <strong className="emitter-overview__value">{issues.length}</strong>
            <p>Matching the emitter label</p>
          </div>
          <div>
            <h3>Open pull requests</h3>
            <strong className="emitter-overview__value">{pullRequests.length}</strong>
            <p>{pullRequests.filter((pr) => pr.draft).length} draft</p>
          </div>
        </div>
        <section className="emitter-coverage" aria-label="Spector coverage">
          <div className="emitter-coverage__heading">
            <h3>Spector Coverage</h3>
            <a href="https://github.com/Azure/typespec-azure/issues/5313" target="_blank" rel="noreferrer">
              View report #5313
            </a>
          </div>
          {snapshot.coverage ? <>
            <p className="emitter-muted">
              Report dated {snapshot.coverage.reportDate} · Passed / total scenarios, including unimplemented scenarios.
            </p>
            {now - Date.parse(snapshot.coverage.reportDate) > 8 * 86_400_000 && (
              <p className="freshness-warning" role="status">
                The weekly coverage report is more than 8 days old.
              </p>
            )}
            <div className="emitter-coverage__suites">
              {snapshot.coverage.suites.map((suite) => <div key={suite.name}>
                <h4>{suite.name}</h4>
                <strong className="emitter-overview__value">{suite.coverage.toFixed(1)}%</strong>
                <p>{suite.passed} / {suite.total} passed · {suite.failed} failed · {suite.notImplemented} not implemented</p>
                <p className="emitter-muted">Spec version {suite.version}</p>
              </div>)}
            </div>
          </> : <p className="emitter-muted">
            Coverage has not been collected yet. Use Refresh data to run the emitter collector.
          </p>}
        </section>
        <p className="emitter-freshness">
          Published data last fetched <EmitterTime value={snapshot.source.fetchedAt} />
          {" · "}Snapshot generated <EmitterTime value={snapshot.generatedAt} />
        </p>
        {liveWork?.collectedAt && <p className="emitter-muted">
          Open work and counts use the shared feed collected <EmitterTime value={liveWork.collectedAt} />.
          {" "}Package and coverage use the published snapshot above.
        </p>}
        {activity.feed?.collectedAt && !liveWork && <p className="emitter-muted">
          Open work uses the newer published snapshot. Shared activity is from an earlier collection.
        </p>}
      </Panel>
      <EmitterWorkPane issues={issues} pullRequests={pullRequests} activity={activity} actions={actions}
        baseline={snapshot.activity} now={now} />
    </div>
  );
}
