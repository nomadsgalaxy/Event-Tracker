import Link from 'next/link';
import {
  Box,
  Zap,
  CircleDashed,
  Layers,
  Briefcase,
  TriangleAlert,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/util/utils';
import type { ManifestCaseGroup, ManifestItemRow, ManifestLooseGroup } from '@/lib/views/manifest-view';

// ManifestCaseCard — one roadcase (or the loose-inventory pseudo-case) on the event manifest
// (DESIGN_ALIGNMENT §4.3). A faithful port of the shared window.ManifestCaseCard (index.html
// ~L15796): the rich case header (icon tile tinted by readiness, case id/slug + label, packed/total
// count, a thin progress bar, a flag count) over the item rows (kind glyph, × qty, name + sku/serial
// subline, the per-case StatusBadge, a warning glyph on flagged rows). The case header links to
// /cases/:id (a real <Link>); the loose header is a plain div (no case detail to open).
//
// ROW INTERACTIONS (signed-in, matching the Python onOpenItem/onFlag): the item NAME becomes a
// button that opens the ItemDetailsModal, and a flag/resolve button opens FlagItemModal/
// ResolveFlagModal. Both are SIBLING buttons inside the row (never nested inside another interactive
// element) so the a11y "no nested interactive" rule holds. When no callbacks are passed (signed-out
// public read), the name is a plain span and the flag button is absent. `openFlagByItemId` carries
// the open flag id per row so the flag button knows resolve-vs-flag.

// Per-kind row glyph (mirrors KIND_ICON, index.html ~L15771, mapped to lucide).
const KIND_GLYPH: Record<string, LucideIcon> = {
  equipment: Box,
  system: Box,
  peripheral: Zap,
  tool: Zap,
  consumable: CircleDashed,
  banner: Layers,
  fixture: Briefcase,
};

// Readiness accent: a warning amber when anything's flagged, success green at 100%, else the brand
// orange. Returns a token CSS var so the card never inlines a hex (DESIGN_SYSTEM §0).
function accentVar(flagged: number, pct: number): string {
  if (flagged > 0) return 'var(--warning)';
  if (pct === 100) return 'var(--st-ready)';
  return 'var(--primary)';
}

// The per-case packed state -> a --st-* token-driven chip. The manifest rows carry a packing
// disposition (packed/pending) or a flagged marker, NOT an event-lifecycle state, so we tint a small
// inline pill from the matching token (ready=packed/green, packing=pending/amber, in_transit=flagged
// reuses the orange — but flagged rows get the explicit warning treatment via the glyph + border).
function RowStatePill({ state }: { state: ManifestItemRow['state'] }) {
  const token =
    state === 'packed'
      ? 'var(--st-ready)'
      : state === 'flagged'
        ? 'var(--warning)'
        : 'var(--st-packing)';
  const label = state === 'packed' ? 'PACKED' : state === 'flagged' ? 'FLAGGED' : 'PENDING';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color: token, borderColor: token }}
    >
      <span className="inline-block size-1.5 rounded-full" style={{ background: token }} aria-hidden />
      {label}
    </span>
  );
}

// The signed-in row interaction callbacks, threaded from the screen (a client island).
export interface ManifestRowActions {
  /** Open the ItemDetailsModal for this item (signed-in only). */
  onOpenItem?: (itemId: string) => void;
  /** Flag/resolve this item — openFlagId is the id of the open flag (=> resolve), else null (=> flag). */
  onFlag?: (itemId: string, openFlagId: string | null) => void;
  /** Map itemId -> the open flag id (for the resolve-vs-flag decision + the button tint). */
  openFlagByItemId?: Record<string, string>;
}

function ItemRow({
  row,
  last,
  actions,
}: {
  row: ManifestItemRow;
  last: boolean;
  actions?: ManifestRowActions;
}) {
  const Glyph = KIND_GLYPH[row.kind] ?? Briefcase;
  const sub =
    row.serials.length > 0
      ? `${row.sku || row.id}${
          row.serials.length === 1 ? ` · ${row.serials[0]}` : ` · ${row.serials.length} serials`
        }`
      : row.sku || row.id;
  const canOpen = !!actions?.onOpenItem;
  const canFlag = !!actions?.onFlag;
  const openFlagId = actions?.openFlagByItemId?.[row.id] ?? null;
  return (
    <div
      className={cn(
        'grid grid-cols-[20px_44px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 sm:grid-cols-[20px_44px_minmax(0,1fr)_110px_104px]',
        !last && 'border-b border-border/60'
      )}
      style={row.flagged ? { background: 'color-mix(in oklab, var(--warning) 7%, transparent)' } : undefined}
    >
      <Glyph size={14} aria-hidden className="text-muted-foreground" />
      <span
        className={cn(
          'text-right font-mono text-xs tabular-nums',
          row.qty > 1 ? 'font-bold text-foreground' : 'text-muted-foreground'
        )}
      >
        × {row.qty}
      </span>
      <div className="min-w-0">
        {canOpen ? (
          <button
            type="button"
            onClick={() => actions!.onOpenItem!(row.id)}
            title={`Open details for ${row.name || 'item'}`}
            className="block max-w-full truncate text-left text-sm text-foreground underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {row.name}
          </button>
        ) : (
          <div className="truncate text-sm text-foreground">{row.name}</div>
        )}
        {sub ? (
          <div className="truncate font-mono text-[10px] text-muted-foreground">{sub}</div>
        ) : null}
      </div>
      {/* QR/Matrix code — desktop only, mono. */}
      <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">
        {row.qr || '—'}
      </span>
      <div className="flex items-center justify-end gap-1.5">
        <RowStatePill state={row.state} />
        {canFlag ? (
          <button
            type="button"
            onClick={() => actions!.onFlag!(row.id, openFlagId)}
            title={openFlagId ? 'Resolve flag' : 'Flag this item'}
            aria-label={openFlagId ? `Resolve flag on ${row.name}` : `Flag ${row.name}`}
            className="rounded p-1 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{ color: openFlagId ? 'var(--warning)' : 'var(--muted-foreground)' }}
          >
            <TriangleAlert size={13} aria-hidden />
          </button>
        ) : row.flagged ? (
          <TriangleAlert size={13} aria-hidden style={{ color: 'var(--warning)' }} />
        ) : null}
      </div>
    </div>
  );
}

// Shared header — used by a roadcase (clickable, links to the case detail) and the loose group (a
// plain div). `eyebrow` is the mono id/slug line; `title` the case label; `subline` the kit-for /
// description line; the right cluster carries the count + progress + an optional chevron.
function CardHeader({
  Icon,
  accent,
  eyebrow,
  title,
  subline,
  packed,
  total,
  flagged,
  pct,
  chevron,
  hasRows,
}: {
  Icon: LucideIcon;
  accent: string;
  eyebrow?: string;
  title: string;
  subline?: string;
  packed: number;
  total: number;
  flagged: number;
  pct: number;
  chevron: boolean;
  hasRows: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', hasRows && 'border-b border-border')}>
      <div
        className="grid size-8 shrink-0 place-items-center rounded-md border"
        style={{ borderColor: accent, background: 'var(--background)' }}
      >
        <Icon size={15} aria-hidden style={{ color: accent }} />
      </div>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <div className="truncate font-mono text-[10px] text-muted-foreground">{eyebrow}</div>
        ) : null}
        <div className="truncate text-sm font-semibold text-foreground">{title}</div>
        {subline ? (
          <div className="truncate text-[11px] text-muted-foreground">{subline}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className="font-mono text-xs tabular-nums"
          style={{ color: flagged > 0 ? 'var(--warning)' : 'var(--muted-foreground)' }}
        >
          {packed}/{total}
          {flagged > 0 ? ` · ${flagged}!` : ''}
        </span>
        <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
        </div>
        {chevron ? (
          <ChevronRight size={14} aria-hidden className="text-muted-foreground" />
        ) : null}
      </div>
    </div>
  );
}

export function ManifestCaseCard({
  group,
  codeSvg,
  actions,
}: {
  group: ManifestCaseGroup;
  /** The case's `eitm:…:c:<caseId>` Data Matrix SVG (server-built). Shown beside the header so the
   *  card reads as the case-manifest-of-record. Omitted/'' -> no code tile (the page never crashes). */
  codeSvg?: string;
  /** Signed-in row interactions (open item / flag). Omitted => public read-only rows. */
  actions?: ManifestRowActions;
}) {
  const pct = group.total > 0 ? Math.round((group.packed / group.total) * 100) : 0;
  const accent = accentVar(group.flagged, pct);
  const hasRows = group.rows.length > 0;
  const eyebrow =
    group.kitFor.length > 0
      ? `${group.slug || group.caseId} · kit for ${group.kitFor.join(', ')}`
      : group.slug || group.caseId;

  return (
    <div
      className="overflow-hidden rounded-lg border bg-card"
      style={group.flagged > 0 ? { borderColor: 'var(--warning)' } : undefined}
    >
      <div className="flex items-stretch">
        <Link
          href={`/cases/${encodeURIComponent(group.caseId)}`}
          className="block min-w-0 flex-1 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CardHeader
            Icon={Briefcase}
            accent={accent}
            eyebrow={eyebrow}
            title={group.label}
            packed={group.packed}
            total={group.total}
            flagged={group.flagged}
            pct={pct}
            chevron
            hasRows={hasRows}
          />
        </Link>
        {codeSvg ? (
          // The case's OWN Data Matrix — scan to open the case (the case-manifest-of-record). DM
          // scans dark-on-light, so it sits on a white tile regardless of the dark UI.
          <div
            className={cn(
              'hidden shrink-0 items-center justify-center px-3 sm:flex',
              hasRows && 'border-b border-border'
            )}
          >
            <span
              role="img"
              aria-label={`Data Matrix code for case ${group.label}`}
              className="grid size-12 place-items-center rounded border border-border bg-white p-0.5 [&>svg]:block [&>svg]:size-full"
              // Server-built, deterministic bwip-js SVG (no user HTML).
              dangerouslySetInnerHTML={{ __html: codeSvg }}
            />
          </div>
        ) : null}
      </div>
      {hasRows ? (
        <div>
          {group.rows.map((r, i) => (
            <ItemRow key={r.id} row={r} last={i === group.rows.length - 1} actions={actions} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-xs italic text-muted-foreground">No items in this case yet.</p>
      )}
    </div>
  );
}

export function ManifestLooseCard({ group, actions }: { group: ManifestLooseGroup; actions?: ManifestRowActions }) {
  const pct = group.total > 0 ? Math.round((group.packed / group.total) * 100) : 0;
  const accent = accentVar(group.flagged, pct);
  const hasRows = group.rows.length > 0;
  return (
    <div
      className="overflow-hidden rounded-lg border bg-card"
      style={{
        borderColor: group.flagged > 0 ? 'var(--warning)' : 'color-mix(in oklab, var(--primary) 35%, var(--border))',
      }}
    >
      <CardHeader
        Icon={Layers}
        accent={accent}
        title="Loose Inventory"
        subline="Items brought to the event outside of a roadcase."
        packed={group.packed}
        total={group.total}
        flagged={group.flagged}
        pct={pct}
        chevron={false}
        hasRows={hasRows}
      />
      {hasRows ? (
        <div>
          {group.rows.map((r, i) => (
            <ItemRow key={r.id} row={r} last={i === group.rows.length - 1} actions={actions} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default ManifestCaseCard;
