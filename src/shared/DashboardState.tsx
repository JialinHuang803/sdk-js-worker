export function DashboardState({
  kind,
  title,
  detail,
}: {
  kind: "loading" | "error" | "empty";
  title: string;
  detail?: string;
}) {
  return (
    <div className={`dashboard-state dashboard-state--${kind}`} role="status">
      {kind === "loading" && <span className="spinner" aria-hidden="true" />}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}
