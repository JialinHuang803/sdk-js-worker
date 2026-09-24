import type { PullRequestRecord } from "../../data/contracts";
import { getNextStep } from "./nextStep";

export function PrTable({
  rows,
  now,
}: {
  rows: PullRequestRecord[];
  now: Date;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Plane</th>
            <th>Packages / API versions</th>
            <th>Failed checks</th>
            <th>Conflicts</th>
            <th>Next step</th>
            <th>Created</th>
            <th>Release plan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pr) => (
            <tr key={`${pr.repository}-${pr.number}`}>
              <td className="pr-cell">
                <a href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number} {pr.title}
                </a>
                <div className="badges">
                  {pr.draft && <span className="badge">Draft</span>}
                  {(pr.reviewDecision === "approved" || pr.recordedApproval === true) && (
                    <span className="badge" title={pr.reviewDecision === "approved"
                      ? "GitHub reports that required approvals are satisfied."
                      : "An undismissed approval is recorded on the current revision; this does not imply all required approvals are satisfied."}>
                      {pr.reviewDecision === "approved" ? "Approved" : "Approval recorded"}
                    </span>
                  )}
                  {pr.completeness.changedFiles === "partial" && (
                    <span className="badge badge--warning">Partial files</span>
                  )}
                  {pr.completeness.metadata === "partial" && (
                    <span className="badge badge--warning">Partial metadata</span>
                  )}
                  {pr.warnings.length > 0 && (
                    <span className="badge badge--warning">
                      {pr.warnings.length} warning{pr.warnings.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </td>
              <td>
                <span className={`plane plane--${pr.plane}`}>
                  {pr.plane === "management" ? "Management" : "Data"}
                </span>
              </td>
              <td className="packages-cell">
                {pr.packages.length === 0 ? (
                  <span className="unknown">Unknown package</span>
                ) : (
                  pr.packages.map((pkg) => (
                    <div className="package" key={pkg.root}>
                      <div className="package__heading">
                        <strong>{pkg.name ?? pkg.root}</strong>
                        {pkg.breakingChanges === true && (
                          <span className="badge badge--warning">Breaking change</span>
                        )}
                        {pkg.state !== "available" && (
                          <span className="badge badge--warning">
                            {pkg.state === "removed"
                              ? "Removed or renamed"
                              : pkg.state === "metadata-missing"
                                ? "Metadata missing"
                                : "Package missing"}
                          </span>
                        )}
                      </div>
                      <span>{pkg.version ?? "version unknown"}</span>
                      {pkg.breakingChanges === null && (
                        <small>Breaking-change status unavailable</small>
                      )}
                      {pkg.breakingChanges === true && pkg.changelogUrl && (
                        <a href={pkg.changelogUrl} target="_blank" rel="noreferrer">
                          Changelog
                        </a>
                      )}
                      {pkg.apiVersions.length > 0 ? (
                        <ul>
                          {pkg.apiVersions.map((api) => (
                            <li key={api.namespace}>
                              {api.namespace}: {api.versions.join(", ")}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <small>API versions unavailable</small>
                      )}
                      {pkg.note && <small>{pkg.note}</small>}
                    </div>
                  ))
                )}
              </td>
              <td>
                <CheckSummary pr={pr} />
              </td>
              <td>
                {pr.conflicts === null ? (
                  <span className="unknown">Checking</span>
                ) : pr.conflicts ? (
                  <span className="status status--danger">Conflicts</span>
                ) : (
                  <span className="status status--good">None reported</span>
                )}
              </td>
              <td>
                <NextStepSummary pr={pr} />
              </td>
              <td>
                <time dateTime={pr.createdAt}>
                  {formatAge(pr.createdAt, now)}
                  <small>{new Date(pr.createdAt).toLocaleDateString()}</small>
                </time>
              </td>
              <td>
                {pr.releasePlanUrl ? (
                  <a href={pr.releasePlanUrl} target="_blank" rel="noreferrer">
                    Open plan
                  </a>
                ) : (
                  <span className="unknown">Not found</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NextStepSummary({ pr }: { pr: PullRequestRecord }) {
  const nextStep = getNextStep(pr);
  return (
    <div className="next-step">
      <span className={`next-step__badge next-step__badge--${nextStep.kind}`}>
        {nextStep.label}
      </span>
      <small>{nextStep.detail}</small>
    </div>
  );
}

function CheckSummary({ pr }: { pr: PullRequestRecord }) {
  if (pr.checks.failedCount === null) {
    return <span className="unknown">Unknown</span>;
  }
  const failed = pr.checks.failedCount;
  const qualification: Record<typeof pr.checks.qualification, string> = {
    complete: "",
    pending: " · checks pending",
    "no-checks": " · no checks reported",
    cancelled: " · cancelled checks",
    partial: " · partial results",
    unknown: " · status unknown",
  };
  return (
    <span className={failed > 0 ? "status status--danger" : "status"}>
      {failed} failed{qualification[pr.checks.qualification]}
    </span>
  );
}

function formatAge(value: string, now: Date): string {
  const days = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(value)) / 86_400_000),
  );
  if (days === 0) return "Today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
