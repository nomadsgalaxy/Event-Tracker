// sync-chip.tsx — the RIGHT-cluster company + DB-sync indicator (Server Component, no interactivity).
//
// Mirrors the existing app's header chip: the company name over a mono "LAST DB SYNC · HH:MM" line,
// led by a small GREEN status dot. This wave ships it STATIC ('EVENT TRACKER' + a placeholder time)
// per the task scope — the live sync timestamp + green/amber/red health state are a later wave that
// will read the eit_sync monitor. The markup is the final shape so wiring it up is a data swap only.
//
// Hidden below lg to protect the narrow center-nav budget; the dot + label are decorative there.

export function SyncChip({
  company = 'EVENT TRACKER',
  lastSync,
}: {
  company?: string;
  /** A pre-formatted clock string (e.g. "14:32"); omitted → an em dash placeholder. */
  lastSync?: string;
}) {
  return (
    <div className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 lg:flex">
      <span
        className="size-1.5 shrink-0 rounded-full bg-[var(--success)]"
        aria-hidden
      />
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          {company}
        </span>
        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          Last DB sync · {lastSync ?? '—'}
        </span>
      </div>
    </div>
  );
}

export default SyncChip;
