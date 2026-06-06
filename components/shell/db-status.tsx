// db-status.tsx — the RIGHT-cluster company + DB-status indicator (Server Component, no interactivity).
//
// This app is LIVE-DB: every read and write hits MongoDB directly, so there is no client cache to
// "sync" and no meaningful "last sync" time. The chip instead reports connection status: a green dot
// + "Database · Live". It renders server-side, and the page can only render after a successful DB
// read, so a visible chip means the database responded.
//
// Hidden below lg to protect the narrow center-nav budget; the dot + label are decorative there.

export function DbStatus({ company = 'EVENT TRACKER' }: { company?: string }) {
  return (
    <div
      className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 lg:flex"
      title="Database connected (live)"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-[var(--success)]" aria-hidden />
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          {company}
        </span>
        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          Database · Live
        </span>
      </div>
    </div>
  );
}

export default DbStatus;
