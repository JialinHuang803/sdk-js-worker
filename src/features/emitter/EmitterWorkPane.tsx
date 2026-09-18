import { useId, useState, type KeyboardEvent } from "react";
import type { EmitterActivityWindow, EmitterIssue, EmitterPullRequest } from "../../data/emitter-contracts";
import { Panel } from "../../shared/Panel";
import { EmitterActivityNotice, EmitterInboxView } from "./EmitterInbox";
import { EmitterTable } from "./EmitterTable";
import { unavailableEmitterActivity, type EmitterActivityActions, type EmitterActivityState } from "./useEmitterActivity";

export function EmitterWorkPane({
  issues, pullRequests, activity = unavailableEmitterActivity, actions, baseline, now = Date.now(),
}: {
  issues: EmitterIssue[];
  pullRequests: EmitterPullRequest[];
  activity?: EmitterActivityState;
  actions?: EmitterActivityActions;
  baseline?: EmitterActivityWindow;
  now?: number;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"attention" | "all">("attention");
  const excluded = activity.feed?.collectedAt ? activity.feed.excludedIssueNumbers
    : baseline?.excludedIssueNumbers ?? [5313];
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
    <div className="emitter-view-toggle" role="group" aria-label="Emitter work view">
      <button type="button" aria-pressed={mode === "attention"}
        onClick={() => setMode("attention")}>Needs attention</button>
      <button type="button" aria-pressed={mode === "all"}
        onClick={() => setMode("all")}>All open</button>
    </div>
    <EmitterActivityNotice activity={activity} baseline={baseline} retry={actions?.retry} now={now} />
    {tabs.map((tab, index) => <div key={tab.kind} role="tabpanel"
      id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`}
      hidden={active !== index} tabIndex={0}>
      {mode === "attention" ? <EmitterInboxView items={tab.rows} kind={tab.kind}
        activity={activity} actions={actions} excludedIssueNumbers={excluded} now={now} />
        : <EmitterTable rows={tab.rows} kind={tab.kind} />}
    </div>)}
  </Panel>;
}
