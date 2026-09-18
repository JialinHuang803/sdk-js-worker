import { useId, useState, type KeyboardEvent } from "react";
import type { EmitterIssue, EmitterPullRequest } from "../../data/emitter-contracts";
import { Panel } from "../../shared/Panel";
import { EmitterTable } from "./EmitterTable";

export function EmitterWorkPane({ issues, pullRequests }: {
  issues: EmitterIssue[];
  pullRequests: EmitterPullRequest[];
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = [
    { title: "Open issues", kind: "issues" as const, rows: issues },
    { title: "Open pull requests", kind: "pull requests" as const, rows: pullRequests },
  ];

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    if (event.key === "ArrowRight") next = (active + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (active + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return <Panel title="Emitter work">
    <div className="inbox-tabs emitter-work-tabs" role="tablist" aria-label="Emitter work"
      onKeyDown={navigateTabs}>
      {tabs.map((tab, index) => <button key={tab.kind} type="button" role="tab"
        id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
        aria-selected={active === index} tabIndex={active === index ? 0 : -1}
        className={active === index ? "active" : ""}
        onClick={() => setActive(index)}>
        {tab.title} <span>{tab.rows.length}</span>
      </button>)}
    </div>
    {tabs.map((tab, index) => <div key={tab.kind} role="tabpanel"
      id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`}
      hidden={active !== index} tabIndex={0}>
      <EmitterTable rows={tab.rows} kind={tab.kind} />
    </div>)}
  </Panel>;
}
