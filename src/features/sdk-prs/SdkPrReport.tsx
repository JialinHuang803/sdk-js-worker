import type { DashboardSnapshot } from "../../data/contracts";
import { buildPlaneReports, type PlaneReport } from "./reportSummary";

export function SdkPrReport({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <section className="delivery-report" aria-labelledby="delivery-report-title">
      <header className="delivery-report__header">
        <h2 id="delivery-report-title">SDK delivery report</h2>
        <p>
          As of {new Date(snapshot.generatedAt).toLocaleString()}.
          {" "}Across all AutoPRs, independent of table filters.
        </p>
      </header>
      <div className="delivery-report__planes">
        {buildPlaneReports(snapshot).map((report) => (
          <PlaneSummary key={report.plane} report={report} />
        ))}
      </div>
      <p className="delivery-report__note">
        Review counts follow GitHub's required-approval decision.
        {" "}Approved does not mean ready to merge.
      </p>
    </section>
  );
}

function PlaneSummary({ report }: { report: PlaneReport }) {
  const unknown = report.reviewUnknown > 0;
  return (
    <article className={`plane-report plane-report--${report.plane}`}>
      <header>
        <h3>{report.plane === "management" ? "Management plane" : "Data plane"}</h3>
        <p className="plane-report__open">
          {report.open === 0 ? "No open AutoPRs right now." : (
            <><strong>{report.open} open {prNoun(report.open, true)}</strong> to track.</>
          )}
        </p>
      </header>
      <div className="plane-report__updates">
        <p>
          {report.awaitingReview === 0 ? (
            unknown
              ? "No PRs are confirmed as waiting for required approval."
              : "No PRs are waiting for required approval."
          ) : (
            <>
              <strong>{unknown ? "At least " : ""}{report.awaitingReview} {prNoun(report.awaitingReview)}</strong>
              {" "}{report.awaitingReview === 1 ? "is" : "are"} waiting for required approval.
            </>
          )}
        </p>
        <p>
          {report.approved === 0 ? (
            unknown
              ? "No open PRs are confirmed as approved."
              : "No approved PRs are waiting to merge."
          ) : (
            <>
              <strong>{unknown ? "At least " : ""}{report.approved} approved {prNoun(report.approved)}</strong>
              {" "}{report.approved === 1 ? "is" : "are"} still open, awaiting service-team action.
            </>
          )}
          {report.approvedWithConflicts > 0 && (
            <span className="plane-report__conflicts">
              {" "}Including {report.approvedWithConflicts} with merge conflicts to resolve.
            </span>
          )}
        </p>
        <p className={report.mergedLastWeek === null ? "plane-report__unavailable" : "plane-report__merged"}>
          {report.mergedLastWeek === null
            ? "The past 7 days of merge history are not available in this snapshot. The next data refresh will collect them."
            : report.mergedLastWeek === 0
              ? "No AutoPRs merged in the past 7 days."
              : <><strong>{report.mergedLastWeek} {prNoun(report.mergedLastWeek, true)} merged</strong> in the past 7 days.</>}
        </p>
      </div>
      {(report.drafts > 0 || report.held > 0 || unknown) && (
        <footer className="plane-report__note">
          {(report.drafts > 0 || report.held > 0) && (
            <p>
              Open totals include {report.drafts} {report.drafts === 1 ? "draft" : "drafts"} and {report.held} on HoldOn.
              {" "}Review and approval counts include these PRs when applicable.
            </p>
          )}
          {unknown && (
            <p>
              Review status is unavailable for {report.reviewUnknown} {prNoun(report.reviewUnknown)};
              {" "}review and approval counts may be higher.
            </p>
          )}
        </footer>
      )}
    </article>
  );
}

function prNoun(count: number, auto = false): string {
  return `${auto ? "AutoPR" : "PR"}${count === 1 ? "" : "s"}`;
}
