import { requireRole } from '@/lib/auth/auth';
import { getEvents, getInventory, getCases, getTags, getUserDisplayName, type TagDoc } from '@/lib/db/data';
import { getCaseLabels } from '@/lib/views/inventory';
import {
  eventCaseSignoffProgress,
  eventSignoffProgress,
  eventCanCommitReady,
  eventCanCommitClosed,
  packingBlockReason,
  buildManifestSnapshot,
  buildCheckinSweep,
  type CheckinSweep,
} from '@/lib/views/signoff-view';
import {
  buildEventManifest,
  type ManifestCaseGroup,
} from '@/lib/views/manifest-view';
import {
  itemIsSerial,
  itemUnits,
  itemOpenFlag,
  rowDispositionKind,
  type InventoryPayload,
} from '@/lib/views/inventory-shape';
import { viewerLeadsEvent } from '@/lib/views/event-view';
import { can } from '@/lib/auth/rbac';
import { itemCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';
import type { CasePayload, EventPayload, ManifestSnapshot } from '@/lib/types/types';
import type { DashTag } from '@/lib/types/types-dashboard';
import type { ItemDetailsCase } from '@/components/inventory/item-details-modal';
import { SignoffScreen } from './signoff-screen';
import type {
  SignoffVariant,
  SignoffEventRow,
  SignoffCaseGroup,
  SignoffReturnRow,
  LooseTargetCase,
  LooseTargetEvent,
} from './signoff-types';

// /signoff — the Sign-Off pool (DESIGN_ALIGNMENT §4.5; existing SignOffPool + SignOffEvent, index.html
// ~L21223 / ~L21395). TRUE 1:1 PORT.
//
// Archetype A: a LEFT SidebarRail (Packing | Unpacking variant toggle + the events in that variant's
// pool, each with a mini progress bar); the MAIN pane is the selected event's full sign-off surface.
//   • PACKING — the readiness summary + Ship-Kit gate + the per-case ManifestCaseCard list with a
//     Mark-boxed action + a Boxed-by stamp + a Box-all bulk.
//   • UNPACKING — the readiness summary + Unpack-Complete gate + a check-in sweep card + the per-ITEM
//     return sign-off table (sign/un-sign + a disposition picker + a Bulk Sign-off) + the LOOSE
//     section (Move-to-case / Send-to-event).
// Both share the manifest snapshot-of-record badge + Print Manifest + item details / flag / resolve.
//
// Every readiness value + every row is pre-computed HERE from the LIVE Mongo read so a count never
// drifts from the logic that produced it, and so the client island only opens modals + relays the
// gated Server Action result (no client data authority). Variant + selection URL-reflect via
// ?variant=packing|unpacking & ?event=<id> (a deep link / refresh / back lands on the same event).
//
// AUTH (OWNER OVERRIDE): requireRole('lead'). Sign-off is lead+ to even SEE (signoffPolicy.canSee);
// the page gates at the lead floor. Each Server Action re-gates with the finer commit/revert split.
export const dynamic = 'force-dynamic';

function toDashTag(doc: TagDoc): DashTag {
  const p = doc.payload ?? {};
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && p.flair === 'flag-us') flair = '🇺🇸';
  if (!flair && p.flair === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

// Deterministic "Mon D" formatter (server-side only — single timezone, no hydration concern). The
// client renders these pre-formatted strings so a locale/timezone difference can never mismatch.
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtShort(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${MONTHS_ABBR[d.getMonth()]} ${d.getDate()}`;
}

function eventCity(p: EventPayload): string {
  const venue = (p.venue ?? {}) as { city?: unknown; name?: unknown };
  return typeof venue.city === 'string' ? venue.city : typeof p.city === 'string' ? p.city : '';
}
function eventVenueName(p: EventPayload): string {
  const venue = (p.venue ?? {}) as { name?: unknown };
  return typeof venue.name === 'string' ? venue.name : '';
}

export default async function SignoffPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string; event?: string }>;
}) {
  const [user, eventDocs, invDocs, caseDocs, caseLabels, tagDocs] = await Promise.all([
    requireRole('lead'),
    getEvents(),
    getInventory(),
    getCases(),
    getCaseLabels(),
    getTags(),
  ]);

  const sp = await searchParams;
  const variant: SignoffVariant = sp.variant === 'unpacking' ? 'unpacking' : 'packing';
  const isPacking = variant === 'packing';
  const inventory = invDocs.map((d) => d.payload);
  const casesById: Record<string, CasePayload> = {};
  for (const c of caseDocs) casesById[c._id] = c.payload;

  const tagById = new Map<string, DashTag>();
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById.set(d._id, toDashTag(d));
  }

  // The pool = events whose lifecycle state matches the variant, newest-touched first (SignOffPool).
  const poolDocs = eventDocs
    .filter((e) => e.payload.state === variant)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // Lean rows for the LEFT pool list (its mini progress bar uses the variant-specific headProg).
  const eventRows: SignoffEventRow[] = poolDocs.map((doc) => {
    const p = doc.payload;
    const casesProg = eventCaseSignoffProgress(p);
    const itemsProg = eventSignoffProgress(p, inventory);
    const headProg = isPacking ? casesProg : { total: itemsProg.total, signed: itemsProg.signed };
    const ready = isPacking ? eventCanCommitReady(p, inventory) : eventCanCommitClosed(p, inventory);
    return {
      id: doc._id,
      name: p.name || doc._id,
      city: eventCity(p),
      state: p.state || 'draft',
      headSigned: headProg.signed,
      headTotal: headProg.total,
      flagged: itemsProg.flagged,
      ready,
    };
  });

  // The selected event MUST be in the current variant's pool (a stale id won't resolve).
  const selectedId = sp.event && poolDocs.some((d) => d._id === sp.event) ? sp.event : null;
  const selectedDoc = selectedId ? poolDocs.find((d) => d._id === selectedId)! : null;

  // Default everything to "no selection"; fill it when an event is chosen.
  let detail: SignoffDetailSeed | null = null;
  if (selectedDoc) {
    detail = await buildDetail(selectedDoc.payload, selectedDoc._id, {
      isPacking,
      inventory,
      casesById,
      caseLabels,
      tagById,
      eventDocs: eventDocs.map((e) => ({ id: e._id, payload: e.payload })),
      user,
    });
  }

  return (
    <SignoffScreen
      variant={variant}
      eventRows={eventRows}
      selectedId={selectedId}
      detail={detail}
    />
  );
}

// ── The fully-seeded detail the screen renders for the SELECTED event ───────────────────────────
export interface SignoffDetailSeed {
  id: string;
  name: string;
  city: string;
  venueName: string;
  state: string;
  lead: string;
  /** The viewer's display name, stamped on a service flag / repair note via the panel. */
  actorName: string;
  // Readiness summary
  casesSigned: number;
  casesTotal: number;
  itemsSigned: number;
  itemsTotal: number;
  flagged: number;
  ready: boolean;
  blockReason: string | null;
  // Gates (UX seams; the Server Action re-checks)
  canCommit: boolean; // signoff.commit (lead+ OR lead-of-event) — box / sign / ship / close
  canRevert: boolean; // signoff.revert (manager+) — un-box
  canManageLoose: boolean; // looseitem.manage (lead+)
  // Snapshot of record
  hasSnapshot: boolean;
  /** Pre-formatted capture timestamp (server-side ISO-ish) for the snapshot badge tooltip. */
  snapshotCapturedAtLabel: string;
  snapshotCapturedByName: string | null;
  // Pre-filled Ship-Kit form (from event.outbound)
  shipDefaults: { carrier: string; tracking: string; pickupDate: string; notes: string };
  // PACKING: per-case groups (the shared ManifestCaseCard data + the boxed-by stamp + flag state)
  caseGroups: SignoffCaseGroup[];
  // UNPACKING: per-item return rows (case rows + loose rows) + the check-in sweep
  caseReturnRows: SignoffReturnRow[];
  looseReturnRows: SignoffReturnRow[];
  sweep: CheckinSweep;
  // Loose move/send targets
  looseTargetCases: LooseTargetCase[];
  looseTargetEvents: LooseTargetEvent[];
  // Modal data (full item payloads + open-flag map + the case picker + matrix svgs + tags)
  itemsById: Record<string, InventoryPayload>;
  openFlagByItemId: Record<string, string>;
  casesForEditor: ItemDetailsCase[];
  itemMatrixSvgByItemId: Record<string, string>;
  tagsById: Record<string, DashTag>;
  // The frozen manifest snapshot (or the live preview), for Print Manifest
  printSnapshot: ManifestSnapshot;
}

async function buildDetail(
  p: EventPayload,
  eventId: string,
  ctx: {
    isPacking: boolean;
    inventory: InventoryPayload[];
    casesById: Record<string, CasePayload>;
    caseLabels: Record<string, string>;
    tagById: Map<string, DashTag>;
    eventDocs: { id: string; payload: EventPayload }[];
    user: { email: string; role: string };
  }
): Promise<SignoffDetailSeed> {
  const { isPacking, inventory, casesById, caseLabels, tagById, eventDocs, user } = ctx;
  const casesProg = eventCaseSignoffProgress(p);
  const itemsProg = eventSignoffProgress(p, inventory);
  const ready = isPacking ? eventCanCommitReady(p, inventory) : eventCanCommitClosed(p, inventory);
  const isLead = viewerLeadsEvent(p, user.email);
  const leadName = resolveLeadDisplay(p);

  // Build the shared event manifest (the per-case ManifestCaseCard data) — reuse the manifest helper.
  const manifest = buildEventManifest(p, eventId, inventory, casesById);

  // ── PACKING: per-case groups with the box state + boxed-by stamp + flag state ─────────────────
  const eventCases = p.cases || [];
  const caseGroups: SignoffCaseGroup[] = eventCases.map((cid) => {
    const mg: ManifestCaseGroup =
      manifest.caseGroups.find((g) => g.caseId === cid) ||
      ({ caseId: cid, label: caseLabels[cid] || cid, slug: '', kitFor: [], rows: [], total: 0, packed: 0, pending: 0, flagged: 0 } as ManifestCaseGroup);
    const so = (p.caseSignoffs || {})[cid] || null;
    return {
      group: mg,
      boxed: !!so,
      boxedByName: so?.by?.name || so?.by?.email || null,
      boxedAtLabel: fmtShort(so?.at),
      hasFlags: mg.flagged > 0,
    };
  });

  // ── UNPACKING: per-item return rows (one per case route / per serial-in-case / per loose row) ──
  const caseSet = new Set(eventCases);
  const caseReturnRows: SignoffReturnRow[] = [];
  const looseReturnRows: SignoffReturnRow[] = [];
  for (const item of inventory) {
    const flagsOpen = (item.flags || []).filter((f) => f.status === 'open');
    const hasFlags = flagsOpen.length > 0;
    if (itemIsSerial(item)) {
      // One synthesized row per case carrying ≥1 unit (mirrors the manifestRows serial branch).
      const byCase: Record<string, ReturnType<typeof itemUnits>> = {};
      for (const u of itemUnits(item)) {
        if (!u || !u.location || u.location === 'storage' || !caseSet.has(u.location)) continue;
        (byCase[u.location] = byCase[u.location] || []).push(u);
      }
      for (const cid of Object.keys(byCase)) {
        const us = byCase[cid];
        const allSigned = us.length > 0 && us.every((u) => u.signoff);
        const sig = us.map((u) => u.signoff).filter(Boolean)[0] || null;
        caseReturnRows.push({
          itemId: item.id || '',
          name: item.name || item.slug || item.id || '',
          caseId: cid,
          caseLabel: caseLabels[cid] || cid,
          loose: false,
          distIdx: 0,
          signed: allSigned,
          dispositionKind: allSigned ? sig?.kind ?? 'ok' : null,
          signedByName: allSigned ? sig?.byName || sig?.byEmail || null : null,
          signedAtLabel: allSigned ? fmtShort(sig?.at) : '',
          hasFlags,
          openFlagCount: flagsOpen.length,
        });
      }
      continue;
    }
    (item.distribution || []).forEach((d, distIdx) => {
      const matchedByCase = !!d.caseId && caseSet.has(d.caseId);
      const matchedByEvent = !d.caseId && d.eventId === eventId;
      if (!matchedByCase && !matchedByEvent) return;
      const kind = rowDispositionKind(d);
      const signed = !!d.signoff;
      const row: SignoffReturnRow = {
        itemId: item.id || '',
        name: item.name || item.slug || item.id || '',
        caseId: matchedByCase ? (d.caseId as string) : null,
        caseLabel: matchedByCase ? caseLabels[d.caseId as string] || (d.caseId as string) : 'Loose',
        loose: matchedByEvent,
        distIdx,
        signed,
        dispositionKind: signed ? kind ?? 'ok' : null,
        signedByName: signed ? d.signoff?.byName || d.signoff?.byEmail || null : null,
        signedAtLabel: signed ? fmtShort(d.signoff?.at) : '',
        hasFlags,
        openFlagCount: flagsOpen.length,
      };
      if (matchedByEvent) looseReturnRows.push(row);
      else caseReturnRows.push(row);
    });
  }

  // ── Check-in sweep (return reconciliation) ────────────────────────────────────────────────────
  const sweep = buildCheckinSweep(p, inventory);

  // ── Loose move/send targets ───────────────────────────────────────────────────────────────────
  // Move-to-case: the event's own assigned, non-retired cases.
  const looseTargetCases: LooseTargetCase[] = eventCases
    .map((cid) => ({ id: cid, label: caseLabels[cid] || cid, retired: !!casesById[cid]?.retiredAt }))
    .filter((c) => !c.retired)
    .map(({ id, label }) => ({ id, label }));
  // Send-to-event: other events accepting transfers (draft|upcoming|packing).
  const looseTargetEvents: LooseTargetEvent[] = eventDocs
    .filter((e) => e.id !== eventId && ['draft', 'upcoming', 'packing'].includes(String(e.payload.state)))
    .map((e) => ({ id: e.id, name: e.payload.name || e.id, state: String(e.payload.state) }));

  // ── Modal data (full item payloads for the rows + open-flag map + matrix svgs + case picker) ──
  const rowItemIds = new Set<string>();
  for (const g of caseGroups) for (const r of g.group.rows) if (r.id) rowItemIds.add(r.id);
  for (const r of [...caseReturnRows, ...looseReturnRows]) if (r.itemId) rowItemIds.add(r.itemId);
  const itemsById: Record<string, InventoryPayload> = {};
  const openFlagByItemId: Record<string, string> = {};
  for (const it of inventory) {
    const id = it.id ?? '';
    if (!id || !rowItemIds.has(id)) continue;
    itemsById[id] = it;
    const of = itemOpenFlag(it);
    if (of?.id) openFlagByItemId[id] = of.id;
  }

  const tenantHash = await activeTenantHash36();
  const encode = (payload: string): string => {
    if (!payload) return '';
    try {
      return dataMatrixSvg(payload);
    } catch {
      return '';
    }
  };
  const itemMatrixSvgByItemId: Record<string, string> = {};
  for (const id of rowItemIds) itemMatrixSvgByItemId[id] = encode(itemCode(id, tenantHash));

  const casesForEditor: ItemDetailsCase[] = Object.entries(casesById)
    .filter(([, cp]) => !cp.retiredAt)
    .map(([id, cp]) => ({ id, label: cp.label || cp.slug || id }));

  const tagsById: Record<string, DashTag> = Object.fromEntries(tagById);

  // ── Snapshot of record + the print snapshot (frozen if present, else a LIVE preview) ──────────
  const stored = p.signoff?.manifestSnapshot ?? null;
  const byName = await getUserDisplayName(user.email).catch(() => user.email);
  const printSnapshot: ManifestSnapshot =
    stored ||
    buildManifestSnapshot(
      p,
      inventory,
      Object.entries(casesById).map(([id, cp]) => ({ id, label: cp.label, slug: cp.slug })),
      { email: user.email, name: byName, role: user.role },
      { reason: 'preview' }
    );

  return {
    id: eventId,
    name: p.name || eventId,
    city: eventCity(p),
    venueName: eventVenueName(p),
    state: p.state || 'draft',
    lead: leadName,
    actorName: byName || user.email,
    casesSigned: casesProg.signed,
    casesTotal: casesProg.total,
    itemsSigned: itemsProg.signed,
    itemsTotal: itemsProg.total,
    flagged: itemsProg.flagged,
    ready,
    blockReason: isPacking ? packingBlockReason(p, inventory) : null,
    canCommit: can('signoff.commit', user.role, { isLeadOfEvent: isLead }),
    canRevert: can('signoff.revert', user.role),
    canManageLoose: can('looseitem.manage', user.role),
    hasSnapshot: !!stored,
    snapshotCapturedAtLabel: stored?.capturedAt
      ? new Date(stored.capturedAt).toISOString().slice(0, 16).replace('T', ' ')
      : '',
    snapshotCapturedByName: stored?.capturedBy?.name || null,
    shipDefaults: {
      carrier: p.outbound?.carrier || '',
      tracking: p.outbound?.tracking || '',
      pickupDate: p.outbound?.pickupDate || new Date().toISOString().slice(0, 10),
      notes: p.outbound?.notes || '',
    },
    caseGroups,
    caseReturnRows,
    looseReturnRows,
    sweep,
    looseTargetCases,
    looseTargetEvents,
    itemsById,
    openFlagByItemId,
    casesForEditor,
    itemMatrixSvgByItemId,
    tagsById,
    printSnapshot,
  };
}

// Resolve the event's lead to a display string (NAME from the roster — no PII).
function resolveLeadDisplay(p: EventPayload): string {
  const lead = p.lead;
  if (!lead) return '';
  const s = (p.staff ?? []).find((x) => x && (x.email === lead || x.name === lead));
  return (s?.name || s?.email || lead) ?? '';
}
