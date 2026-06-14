'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Box, Check, ChevronRight, Circle, Layers, QrCode, ScanLine, Search, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/util/utils';
import { useIsMobile } from './use-is-mobile';
import { decodeScanPayload, findInventoryByScan } from '@/lib/views/case-view';
import {
  caseContents,
  caseEventContext,
  dispositionCounts,
  itemCurrentOrLastCase,
  rowDispositionKind,
  type DispositionKind,
  type ScanCaseLean,
  type ScanContentEntry,
  type ScanEventLean,
  type ScanItemLean,
  type ScanPolicy,
} from '@/lib/views/scan';
import type { InventoryPayload } from '@/lib/views/inventory-shape';
import type { NfcTagEntry } from '@/lib/integrations/nfc-decoders';
import { ScannerView } from './scanner-view';
import { useNfcReader } from './use-nfc-reader';
import { TagDetailsSummary } from './tag-details-summary';
import { EventCasePicker } from './event-case-picker';
import { ManualItemPicker } from './manual-item-picker';
import { UnknownScanModal, type UnknownScan } from './unknown-scan-modal';
import {
  packItemAction,
  addToCaseAction,
  dispositionAction,
  markMissingAction,
  looseAddAction,
  attachSerialAction,
  countOnlyAction,
  adoptProductCodeAction,
  tagDataAction,
  packTaggedUnitAction,
} from './actions';
import type { ScanResult } from './use-scan-camera';

// app/scan/scan-screen.tsx — the interactive Scan-Pack flow. A faithful port of index.html
// ScanHybrid (~L16653): the camera/NFC scanning surface paired with the active-case context +
// contents + the pack / unpack / loose flows. Layout mirrors the source — DESKTOP is a two-column
// 1/3 scanner pane (camera + NFC + tag details + last-scan + toast) + 2/3 case/contents pane;
// MOBILE is a single column. A scan resolves through the shared lib codec + findInventoryByScan tier
// matcher and routes to: a case open, an item nav, the Pending Add-to-case prompt, or the
// UnknownScanModal adoption flow. Every WRITE goes through a gated Server Action (app/scan/actions).

interface ScanScreenProps {
  cases: ScanCaseLean[];
  events: ScanEventLean[];
  items: ScanItemLean[];
  role: string;
  policy: ScanPolicy;
  tenantHash: string;
  routeVariant: 'pack' | 'return' | 'event';
  routeCaseId: string | null;
  routeLooseEventId: string | null;
}

export function ScanScreen({
  cases,
  events,
  items,
  role,
  policy,
  tenantHash,
  routeVariant,
  routeCaseId,
  routeLooseEventId,
}: ScanScreenProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const isDesktop = !isMobile;

  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ item: InventoryPayload; id: string; matchField: string } | null>(null);
  const [unknown, setUnknown] = useState<UnknownScan | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [lastScan, setLastScan] = useState<{ text: string; format: string; at: number } | null>(null);
  const [lastTag, setLastTag] = useState<NfcTagEntry | null>(null);
  const [isPending, startTransition] = useTransition();

  const itemById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items]);
  const inventory = useMemo(() => items.map((x) => x.payload), [items]);

  // ── Loose mode (scan into an event, not a case) ────────────────────────────────────────────────
  const routeIsLoose = routeVariant === 'event';
  const looseTargetEvent = routeLooseEventId ? events.find((e) => e.id === routeLooseEventId) ?? null : null;

  // ── Deep-link: seed the active case from /scan/pack/<caseId> (UUID or slug), once. ─────────────
  useEffect(() => {
    if (!routeCaseId || activeCaseId) return;
    const found = cases.find((c) => c.id === routeCaseId || c.slug === routeCaseId);
    if (found) setActiveCaseId(found.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeCaseId, cases.length]);

  const activeCase = activeCaseId ? cases.find((c) => c.id === activeCaseId) ?? null : null;
  const ctx = useMemo(() => caseEventContext(activeCaseId, events), [activeCaseId, events]);
  const isUnpackMode = ctx.mode === 'unpack';

  // ── Returning → Unpacking auto-transition (server-side mode is derived from the live event state,
  // so opening a returning-state case already renders the unpack UI; the audit transition is a
  // server concern handled by the event-state flow). We surface a toast on the first open. ────────
  const transitionedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeCase || !ctx.event) return;
    if (ctx.event.state === 'returning' && transitionedRef.current !== activeCaseId) {
      transitionedRef.current = activeCaseId;
      toast.info(`${ctx.event.name || ctx.eventId} → Unpacking`);
    }
  }, [activeCaseId, activeCase, ctx.event, ctx.eventId]);

  // ── The active case's expected contents + the running counts ────────────────────────────────────
  const contents = useMemo<ScanContentEntry[]>(() => caseContents(activeCaseId, inventory), [activeCaseId, inventory]);
  const totalRows = contents.length;
  const packedRows = contents.filter((r) => r.dist.state === 'packed').length;
  const allPacked = totalRows > 0 && packedRows === totalRows;
  const dispCounts = useMemo(() => dispositionCounts(contents), [contents]);
  const reconciledRows = totalRows - dispCounts.none - dispCounts.missing;

  // ── Server-action helpers (optimistic toast + router.refresh re-read) ──────────────────────────
  const runWrite = useCallback(
    (fn: () => Promise<{ ok?: boolean; error?: string }>, onOk?: () => void) => {
      startTransition(async () => {
        const res = await fn();
        if (res.error) {
          toast.error(res.error);
          return;
        }
        onOk?.();
        router.refresh();
      });
    },
    [router]
  );

  // ── Pack toggle (row tap + steady scan into an open case) ──────────────────────────────────────
  const toggleRowPacked = useCallback(
    (entry: ScanContentEntry) => {
      if (!activeCaseId) return;
      const packed = entry.dist.state === 'packed';
      if (packed && !policy.canUnPack) {
        toast.warning('Authorized+ to un-pack rows');
        return;
      }
      runWrite(
        () => packItemAction({}, fd({ itemId: entry.itemId, caseId: activeCaseId, packed: packed ? 'false' : 'true' })),
        () => toast.success(`${packed ? 'Un-packed' : 'Packed'} ${entry.item.name}`)
      );
    },
    [activeCaseId, policy.canUnPack, runWrite]
  );

  // ── Disposition cycle (unpack mode row tap): null → ok → damaged → consumed → sold → null ───────
  const cycleRowDisposition = useCallback(
    (entry: ScanContentEntry) => {
      if (!activeCaseId) return;
      const order: (DispositionKind | null)[] = [null, 'ok', 'damaged', 'consumed', 'sold'];
      const cur = rowDispositionKind(entry.dist);
      const ix = order.indexOf(cur);
      const next = order[(ix + 1) % order.length];
      runWrite(() => dispositionAction({ itemId: entry.itemId, caseId: activeCaseId, disposition: next }));
    },
    [activeCaseId, runWrite]
  );

  const markUnscannedMissing = useCallback(() => {
    if (!activeCaseId) return;
    runWrite(
      () => markMissingAction({ caseId: activeCaseId }),
      () => toast.warning('Unscanned items → Missing')
    );
  }, [activeCaseId, runWrite]);

  // ── Add-to-case (Pending prompt: Add / Add+pack / loose-add in loose mode) ─────────────────────
  const handleAddToCase = useCallback(
    (item: InventoryPayload, id: string, alsoPack: boolean) => {
      if (routeIsLoose) {
        if (!routeLooseEventId) {
          toast.warning('Open a /scan/event/<id> URL with a valid event id.');
          return;
        }
        if (!policy.canAddLoose) {
          toast.warning('Lead+ required to add loose items');
          return;
        }
        runWrite(
          () => looseAddAction({ itemId: id, eventId: routeLooseEventId }),
          () => {
            setPending(null);
            toast.success(`${item.name} · loose @ ${looseTargetEvent?.payload.name ?? 'event'}`);
          }
        );
        return;
      }
      if (!activeCaseId) return;
      runWrite(
        () => addToCaseAction({ itemId: id, caseId: activeCaseId, alsoPack }),
        () => {
          setPending(null);
          toast.success(`${item.name}${alsoPack ? ' · packed' : ' · added'}`);
        }
      );
    },
    [routeIsLoose, routeLooseEventId, policy.canAddLoose, activeCaseId, looseTargetEvent, runWrite]
  );

  // Route a resolved item the same way for a camera scan, an NFC tap, or the manual picker: into the
  // active case's Add prompt when packing, else open the item's current/last case (or note it's never
  // been packed). Shared so scanning a bound NFC tag behaves exactly like scanning the item's label.
  const routeMatchedItem = useCallback(
    (item: InventoryPayload, id: string, matchField: string) => {
      if (activeCaseId) {
        setPending({ item, id, matchField });
        return;
      }
      const r = itemCurrentOrLastCase(item);
      const label = item.name || item.slug || item.id;
      if (r.caseId && r.status === 'current') {
        toast.success(`${label} · currently in case`);
        window.location.href = '/cases/' + r.caseId;
      } else if (r.caseId && r.status === 'last') {
        toast.info(`${label} · last seen in this case`);
        window.location.href = '/cases/' + r.caseId;
      } else {
        toast.warning(`${label} · not in a case yet`);
      }
    },
    [activeCaseId]
  );

  // ── Resolve a scanned/typed code (camera onScan, NFC, manual picker) ───────────────────────────
  const handleScan = useCallback(
    (s: ScanResult) => {
      if (!s || !s.text) return;
      setLastScan({ text: s.text, format: s.format || '', at: s.at || Date.now() });

      // 1. EIT eitm: payload — tenant-gate, then route by kind.
      const eit = decodeScanPayload(s.text);
      if (eit) {
        if (eit.tenantHash && tenantHash && eit.tenantHash !== tenantHash) {
          toast.error('Matrix belongs to another deployment');
          return;
        }
        if (eit.kind === 'case') {
          const found = cases.find((c) => c.id === eit.id || c.slug === eit.id);
          if (found) {
            setActiveCaseId(found.id);
            setPending(null);
            setUnknown(null);
            toast.success(`Opened ${found.label || found.slug || found.id}`);
          } else {
            toast.warning(`Case not found: ${eit.id}`);
          }
          return;
        }
        if (eit.kind === 'item') {
          const found = itemById.get(eit.id);
          if (found) {
            routeMatchedItem(found.payload, found.id, 'id');
            return;
          }
          toast.warning('Item not found');
          return;
        }
        if (eit.kind === 'event') {
          const ev = events.find((e) => e.id === eit.id || e.payload.id === eit.id);
          if (ev) {
            setPending(null);
            setUnknown(null);
            toast.success(`Opened ${ev.payload.name || ev.id}`);
            window.location.href = '/event/' + ev.id;
          } else {
            toast.warning(`Event not found: ${eit.id}`);
          }
          return;
        }
      }

      // 2. Foreign code — tier match via findInventoryByScan.
      const result = findInventoryByScan(items, s.text);
      if (result.tier === 'exact' && result.itemId) {
        const e = itemById.get(result.itemId);
        if (e) routeMatchedItem(e.payload, e.id, result.matchField || 'match');
      } else if (result.tier === 'exact' && result.itemIds) {
        setUnknown({ text: s.text, format: s.format, suggestions: result.itemIds.map((id) => itemById.get(id)?.payload).filter((x): x is InventoryPayload => !!x), multiExact: true });
      } else if (result.tier === 'substring' && result.itemIds) {
        setUnknown({ text: s.text, format: s.format, suggestions: result.itemIds.map((id) => itemById.get(id)?.payload).filter((x): x is InventoryPayload => !!x), multiExact: false });
      } else {
        setUnknown({ text: s.text, format: s.format, suggestions: [], multiExact: false });
      }
    },
    [cases, events, items, itemById, activeCaseId, tenantHash, routeMatchedItem]
  );

  // ── NFC tag handler — UID match via findInventoryByScan, then refresh tag data ────────────────
  const handleNfcTag = useCallback(
    (entry: NfcTagEntry) => {
      setLastTag(entry);
      if (!entry || !entry.tagUid) return;
      const result = findInventoryByScan(items, entry.tagUid);
      if (result.tier === 'exact' && result.itemId) {
        const e = itemById.get(result.itemId);
        if (e) {
          const tagEntry = {
            tagUid: entry.tagUid,
            format: entry.format,
            category: entry.category,
            parsed: (entry.parsed as Record<string, unknown> | null) ?? undefined,
            raw: entry.raw,
            lastReadAt: entry.lastReadAt,
          };
          const cId = activeCaseId;
          // A spool (serial consumable matched by its bound tag) packs THAT specific unit into the open
          // case. Refresh the tag first (keeps remaining-weight current), then pack — sequenced in one
          // thunk so the two units[] writes don't race.
          const spoolPack = !!cId && !isUnpackMode && e.payload.tracking === 'serial' && result.matchField === 'nfc';
          if (spoolPack) {
            runWrite(
              async () => {
                await tagDataAction({ itemId: e.id, entry: tagEntry });
                return packTaggedUnitAction({ itemId: e.id, caseId: cId as string, tagUid: entry.tagUid });
              },
              () => toast.success(`${e.payload.name || 'Spool'} · packed into case`)
            );
          } else {
            // Otherwise refresh the tag (best-effort) and bring the item up like scanning its label.
            runWrite(() => tagDataAction({ itemId: e.id, entry: tagEntry }));
            toast.success(`${e.payload.name || 'Item'} · matched from tag`);
            routeMatchedItem(e.payload, e.id, result.matchField || 'nfc');
          }
        }
      } else if (result.tier === 'substring' && result.itemIds) {
        setUnknown({ text: entry.tagUid, format: 'nfc:' + entry.format, suggestions: result.itemIds.map((id) => itemById.get(id)?.payload).filter((x): x is InventoryPayload => !!x), multiExact: false });
      } else {
        setUnknown({ text: entry.tagUid, format: 'nfc:' + entry.format, suggestions: [], multiExact: false });
      }
    },
    [items, itemById, runWrite, routeMatchedItem, activeCaseId, isUnpackMode]
  );

  const nfc = useNfcReader({ onTag: handleNfcTag });

  // ── Last-scan shortcut resolution (clickable card → open item/case/event) ──────────────────────
  const lastScanTarget = useMemo(() => {
    if (!lastScan || !lastScan.text) return null;
    const eit = decodeScanPayload(lastScan.text);
    if (eit) {
      if (eit.tenantHash && tenantHash && eit.tenantHash !== tenantHash) return null;
      if (eit.kind === 'case') {
        const c = cases.find((x) => x.id === eit.id || x.slug === eit.id);
        if (c) return { kind: 'case' as const, id: c.id, label: c.label || c.slug || c.id, item: null };
      }
      if (eit.kind === 'item') {
        const e = itemById.get(eit.id);
        if (e) return { kind: 'item' as const, id: e.id, label: e.payload.name || e.payload.slug || e.id, item: e.payload };
      }
      if (eit.kind === 'event') {
        const ev = events.find((x) => x.id === eit.id || x.payload.id === eit.id);
        if (ev) return { kind: 'event' as const, id: ev.id, label: ev.payload.name || ev.id, item: null };
      }
    }
    const result = findInventoryByScan(items, lastScan.text);
    if (result.tier === 'exact' && result.itemId) {
      const e = itemById.get(result.itemId);
      if (e) return { kind: 'item' as const, id: e.id, label: e.payload.name || e.payload.slug || e.id, item: e.payload };
    }
    return null;
  }, [lastScan, cases, events, items, itemById, tenantHash]);

  const openLastScan = useCallback(() => {
    if (!lastScanTarget) return;
    if (lastScanTarget.kind === 'case') {
      window.location.href = '/cases/' + lastScanTarget.id;
      return;
    }
    if (lastScanTarget.kind === 'event') {
      window.location.href = '/event/' + lastScanTarget.id;
      return;
    }
    const r = lastScanTarget.item ? itemCurrentOrLastCase(lastScanTarget.item) : { caseId: null };
    if (r.caseId) window.location.href = '/cases/' + r.caseId;
    else toast.warning(`${lastScanTarget.label} · never packed in a case`);
  }, [lastScanTarget]);

  // ── HID / typed-code fallback (a USB/Bluetooth wedge scanner types + Enter) ────────────────────
  const [codeValue, setCodeValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submitCode = useCallback(() => {
    const v = codeValue.trim();
    setCodeValue('');
    if (v) handleScan({ text: v, format: 'manual', at: Date.now() });
    inputRef.current?.focus();
  }, [codeValue, handleScan]);

  // ── Section bindings (arranged differently for desktop vs mobile, like the source) ─────────────
  const titleStr = routeIsLoose
    ? 'LOOSE MODE · ' + (looseTargetEvent ? looseTargetEvent.payload.name || 'EVENT' : 'EVENT')
    : activeCase
      ? (activeCase.slug || activeCase.id) + ' · OPEN'
      : 'NO CASE — SCAN ANY';

  const sectionLooseBanner = routeIsLoose ? (
    <div className="flex items-center gap-2.5 rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft, rgba(253,80,0,.06))' }}>
      <div className="grid size-8 shrink-0 place-items-center rounded" style={{ background: 'rgba(253,80,0,.16)' }}>
        <Layers size={16} style={{ color: 'var(--accent)' }} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--accent)' }}>Loose mode</div>
        <div className="text-[13px] font-semibold leading-tight text-foreground">{looseTargetEvent ? looseTargetEvent.payload.name || looseTargetEvent.id : 'Event not found'}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {looseTargetEvent ? 'Scans add a loose distribution row to this event (no road case).' : 'Open a /scan/event/<id> URL with a valid event id.'}
        </div>
      </div>
    </div>
  ) : null;

  const sectionActiveCase = activeCase ? (
    <div className="flex items-center gap-2.5 rounded-lg border p-3" style={{ borderColor: 'var(--accent)' }}>
      <div className="grid size-8 shrink-0 place-items-center rounded" style={{ background: 'rgba(253,80,0,.16)' }}>
        <Box size={16} style={{ color: 'var(--accent)' }} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11px] text-muted-foreground">{activeCase.slug || activeCase.id}</div>
        <div className="text-[13px] font-semibold leading-tight text-foreground">{activeCase.label || ''}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {ctx.isAssigned ? '→ ' + (ctx.event?.name || ctx.eventId) : 'NO EVENT YET'}
        </div>
      </div>
      <StatusBadge state={ctx.isAssigned ? ctx.event?.state || 'packing' : 'draft'} />
    </div>
  ) : (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-center text-[11px] text-muted-foreground">
        Scan a roadcase Matrix, tap <span style={{ color: 'var(--accent)' }}>Pick a case</span> below, or use Find item.
      </p>
      <Button size="sm" onClick={() => setShowPicker(true)}>Pick a case</Button>
    </div>
  );

  const sectionCamera = (
    <ScannerView
      onScan={handleScan}
      height={activeCase ? (isDesktop ? 240 : 160) : isDesktop ? 280 : 200}
      label={activeCase ? 'SCAN INTO ' + (activeCase.slug || activeCase.id) : 'SCAN A CASE MATRIX'}
    />
  );

  const sectionNFC = nfc.supported ? (
    <div className="flex gap-2">
      <Button
        variant={nfc.active ? 'default' : 'outline'}
        size="sm"
        className="flex-1"
        onClick={() => (nfc.active ? nfc.stop() : nfc.start())}
      >
        <QrCode size={12} aria-hidden /> {nfc.active ? 'NFC reading…' : 'Tap NFC'}
      </Button>
    </div>
  ) : null;

  const sectionNFCError =
    nfc.error === 'permission-denied' ? (
      <div className="rounded-lg border border-warning/60 bg-warning/5 p-2 text-[11px] text-muted-foreground">
        NFC permission denied. Enable in browser settings, then tap again.
      </div>
    ) : null;

  const sectionTagDetails = lastTag && lastTag.category !== 'generic' ? <TagDetailsSummary entry={lastTag} /> : null;

  const sectionLastScan = lastScan ? (
    lastScanTarget ? (
      <button
        type="button"
        onClick={openLastScan}
        className="flex w-full items-center gap-2 rounded border bg-success/5 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ borderColor: 'var(--success)' }}
        title={'Open ' + lastScanTarget.kind + ': ' + lastScanTarget.label}
      >
        <QrCode size={12} style={{ color: 'var(--success)' }} aria-hidden />
        <div className="min-w-0 flex-1">
          <Eyebrow style={{ color: 'var(--success)' }}>
            Last scan · {lastScanTarget.kind === 'case' ? 'open case' : lastScanTarget.kind === 'event' ? 'open event' : 'open item'}
          </Eyebrow>
          <div className="truncate text-xs font-semibold text-foreground">{lastScanTarget.label}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{lastScan.text}</div>
        </div>
        <ChevronRight size={12} className="text-muted-foreground" aria-hidden />
      </button>
    ) : (
      <div className="flex items-center gap-2 rounded border border-border bg-card p-2">
        <QrCode size={12} className="text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <Eyebrow className="text-muted-foreground">Last scan</Eyebrow>
          <div className="truncate font-mono text-[11px] text-foreground">{lastScan.text}</div>
        </div>
        <span className="font-mono text-[9px] text-muted-foreground">{lastScan.format || ''}</span>
      </div>
    )
  ) : null;

  const sectionCounters = activeCase && isUnpackMode ? (
    <div className="grid grid-cols-5 overflow-hidden rounded-lg border border-border">
      {(
        [
          { k: 'ok', l: 'OK', v: dispCounts.ok, c: 'var(--success)' },
          { k: 'damaged', l: 'Damaged', v: dispCounts.damaged, c: 'var(--error)' },
          { k: 'consumed', l: 'Consumed', v: dispCounts.consumed, c: 'var(--warning)' },
          { k: 'sold', l: 'Sold', v: dispCounts.sold, c: 'var(--primary)' },
          { k: 'missing', l: 'Missing', v: dispCounts.missing, c: 'var(--muted-foreground)' },
        ] as const
      ).map((b, i) => (
        <div key={b.k} className={cn('px-1.5 py-2 text-center', i && 'border-l border-border')}>
          <div className="font-mono text-lg font-bold" style={{ color: b.c }}>{b.v}</div>
          <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{b.l}</div>
        </div>
      ))}
    </div>
  ) : null;

  const sectionContents = activeCase ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex items-baseline justify-between">
        <Eyebrow>{isUnpackMode ? 'Reconciled' : 'In this case'} · {totalRows} items</Eyebrow>
        <span
          className="font-mono text-[11px]"
          style={{
            color: isUnpackMode
              ? reconciledRows === totalRows
                ? 'var(--success)'
                : 'var(--warning)'
              : allPacked
                ? 'var(--success)'
                : 'var(--accent)',
          }}
        >
          {isUnpackMode ? `${reconciledRows} / ${totalRows}` : `${packedRows} / ${totalRows}`}
        </span>
      </div>
      <ul className="flex-1 overflow-y-auto" aria-label={`Contents of ${activeCase.label}`}>
        {totalRows === 0 && (
          <li className="px-5 py-5 text-center text-[11px] text-muted-foreground">No items yet — scan or use Find item.</li>
        )}
        {contents.map((entry, i) => {
          const it = entry.item;
          const d = entry.dist;
          const sub = it.qr || it.sku || (d.serials && d.serials.join(', ')) || '';
          const isPacked = d.state === 'packed';
          const dispKind = rowDispositionKind(d);
          return (
            <li key={entry.itemId}>
              <button
                type="button"
                disabled={isPending}
                onClick={() => (isUnpackMode ? cycleRowDisposition(entry) : toggleRowPacked(entry))}
                className={cn(
                  'flex w-full items-center justify-between gap-2 py-2 text-left',
                  i && 'border-t border-border',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed'
                )}
                aria-label={`${it.name} — ${isUnpackMode ? dispKind || 'tap to set disposition' : isPacked ? 'packed' : 'tap to pack'}`}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-xs leading-tight"
                    style={{ color: isUnpackMode && dispKind === 'missing' ? 'var(--muted-foreground)' : 'var(--foreground)' }}
                  >
                    {(d.qty > 1 ? '×' + d.qty + ' ' : '') + it.name}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">{sub}</div>
                </div>
                {isUnpackMode ? (
                  <DispChip kind={dispKind} />
                ) : isPacked ? (
                  <Check size={13} style={{ color: 'var(--success)' }} aria-hidden />
                ) : (
                  <Circle size={13} className="text-muted-foreground/50" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!isUnpackMode && allPacked && (
        <Button className="mt-2" onClick={() => goSignoff('packing')}>
          All {totalRows} packed — Sign off →
        </Button>
      )}
      {isUnpackMode && totalRows > 0 && (
        <div className="mt-2 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={markUnscannedMissing} disabled={isPending}>
            Mark unscanned missing
          </Button>
          <Button className="flex-1" onClick={() => goSignoff('unpacking')}>
            Sign off →
          </Button>
        </div>
      )}
    </div>
  ) : null;

  const sectionActions = (
    <div className="flex gap-2">
      <Button variant="outline" className="flex-1" onClick={() => setShowFind(true)}>
        <Search size={12} aria-hidden /> Find item
      </Button>
      {activeCase && (
        <Button variant="outline" className="flex-1" onClick={() => setShowPicker(true)}>
          <QrCode size={12} aria-hidden /> Switch case
        </Button>
      )}
    </div>
  );

  // The HID / typed code input (mirrors the wedge-scanner fallback; always available).
  const sectionTypedInput = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submitCode();
      }}
      className="flex items-stretch gap-2"
    >
      <label htmlFor="scan-code" className="sr-only">Scan or type a code</label>
      <input
        id="scan-code"
        ref={inputRef}
        value={codeValue}
        onChange={(e) => setCodeValue(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Or type / wedge-scan a code…"
        className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <Button type="submit" variant="outline" size="sm" disabled={!codeValue.trim()}>
        <ScanLine size={14} aria-hidden /> Scan
      </Button>
    </form>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — the mobile-shell title strip (matches the MobileShell title). */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <Eyebrow asChild>
          <h1 className="font-mono text-xs font-bold tracking-[0.08em] text-foreground">{titleStr}</h1>
        </Eyebrow>
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
          <ScanLine size={11} aria-hidden /> {isUnpackMode ? 'Return mode' : 'Pack mode'}
        </span>
      </header>

      {isDesktop ? (
        <div className="flex min-h-0 flex-1 flex-row gap-3.5 p-3.5">
          {/* LEFT 1/3 — scanner + NFC + last-scan info */}
          <div className="flex min-h-0 basis-1/3 flex-col gap-2.5">
            {sectionCamera}
            {sectionTypedInput}
            {sectionNFC}
            {sectionNFCError}
            {sectionTagDetails}
            {sectionLastScan}
          </div>
          {/* RIGHT 2/3 — active-case context + contents + actions */}
          <div className="flex min-h-0 basis-2/3 flex-col gap-2.5">
            {sectionLooseBanner}
            {sectionActiveCase}
            {sectionCounters}
            {sectionContents}
            {sectionActions}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-2.5 p-3.5">
          {sectionLooseBanner}
          {sectionActiveCase}
          {sectionCamera}
          {sectionTypedInput}
          {sectionNFC}
          {sectionNFCError}
          {sectionTagDetails}
          {sectionLastScan}
          {sectionCounters}
          {sectionContents}
          {sectionActions}
        </div>
      )}

      {/* Pending Add-to-case prompt (Cancel / Add / Add+pack). */}
      {pending && (activeCase || routeIsLoose) && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/[.78]"
          onClick={() => setPending(null)}
        >
          <div
            className="m-3.5 flex w-full max-w-sm flex-col gap-3 rounded-lg border bg-popover p-4"
            style={{ borderColor: 'var(--accent)' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Add item to case"
          >
            <Eyebrow style={{ color: 'var(--accent)' }}>
              {routeIsLoose ? 'Add loose to ' + (looseTargetEvent?.payload.name || 'event') + '?' : 'Add to ' + (activeCase?.slug || activeCase?.id) + '?'}
            </Eyebrow>
            <div className="text-sm font-semibold text-foreground">{pending.item.name}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {pending.item.qr || pending.item.sku || pending.id} · matched on {pending.matchField}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="outline" className="flex-1" disabled={isPending} onClick={() => handleAddToCase(pending.item, pending.id, false)}>
                Add
              </Button>
              {!routeIsLoose && (
                <Button className="flex-1" disabled={isPending} onClick={() => handleAddToCase(pending.item, pending.id, true)}>
                  Add + pack
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Unknown scan modal — adoption guard. */}
      {unknown && (
        <UnknownScanModal
          scan={unknown}
          items={items}
          activeCaseId={activeCaseId}
          role={role}
          open={!!unknown}
          onOpenChange={(v) => !v && setUnknown(null)}
          onPickItem={(item, id) => {
            setUnknown(null);
            if (activeCaseId) setPending({ item, id, matchField: 'picker' });
            else routeItemToCase(item);
          }}
          onAttachSerial={(item, id) => {
            if (!activeCaseId || !unknown) return;
            runWrite(
              () => attachSerialAction({ itemId: id, caseId: activeCaseId, serial: unknown.text }),
              () => {
                setUnknown(null);
                toast.success(`Serial linked to ${item.name}`);
              }
            );
          }}
          onCountOnly={(item, id) => {
            if (!activeCaseId) return;
            runWrite(
              () => countOnlyAction({ itemId: id, caseId: activeCaseId }),
              () => {
                setUnknown(null);
                toast.success(`+1 ${item.name}`);
              }
            );
          }}
          onAdoptAsProductCode={(item, id) => {
            if (!unknown) return;
            runWrite(
              () => adoptProductCodeAction({ itemId: id, code: unknown.text, caseId: activeCaseId }),
              () => {
                setUnknown(null);
                toast.success(`Code linked to ${item.name}`);
              }
            );
          }}
          onCreateNew={() => {
            if (!unknown) return;
            setUnknown(null);
            if (activeCaseId) window.location.href = '/cases/' + activeCaseId + '?newItemQr=' + encodeURIComponent(unknown.text);
          }}
        />
      )}

      {/* Manual item picker (Find item). */}
      <ManualItemPicker
        items={items}
        activeCaseId={activeCaseId}
        open={showFind}
        onOpenChange={setShowFind}
        onPick={(item, id) => {
          setShowFind(false);
          if (activeCaseId || routeIsLoose) setPending({ item, id, matchField: 'picker' });
          else toast.warning('Pick or scan a case first');
        }}
      />

      {/* Event/Case picker — manual fallback (3 tabs). */}
      <EventCasePicker
        events={events}
        cases={cases}
        open={showPicker}
        onOpenChange={setShowPicker}
        onPick={(caseId) => {
          setShowPicker(false);
          setActiveCaseId(caseId);
          setPending(null);
          setUnknown(null);
          const c = cases.find((x) => x.id === caseId);
          if (c) toast.success(`Opened ${c.label || c.slug || c.id}`);
        }}
      />
    </div>
  );

  // Sign-off nav (the Next.js Sign-Off pool is query-param driven: ?variant=&event=). Mirrors the
  // Python's /signoff/{packing|unpacking}/<eventId> deep link.
  function goSignoff(variant: 'packing' | 'unpacking') {
    const qs = new URLSearchParams({ variant });
    if (ctx.eventId) qs.set('event', ctx.eventId);
    window.location.href = '/signoff?' + qs.toString();
  }

  // Route an item picked from the UnknownScanModal with NO active case → its first case detail.
  function routeItemToCase(item: InventoryPayload) {
    const cids = item.tracking === 'serial'
      ? Array.from(new Set((item.units || []).filter((u) => u && !u.deletedAt && u.location && u.location !== 'storage').map((u) => u.location as string)))
      : Array.from(new Set((item.distribution || []).map((d) => d.caseId).filter((c): c is string => !!c)));
    if (cids[0]) window.location.href = '/cases/' + cids[0];
  }
}

// FormData helper for the packItemAction (the only Server Action that still takes a FormData prev).
function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

function DispChip({ kind }: { kind: DispositionKind | null }) {
  if (!kind) {
    return <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-muted-foreground/50">tap</span>;
  }
  const col: Record<DispositionKind, string> = {
    ok: 'var(--success)',
    damaged: 'var(--error)',
    consumed: 'var(--warning)',
    sold: 'var(--primary)',
    missing: 'var(--muted-foreground)',
    other: 'var(--muted-foreground)',
  };
  const lbl: Record<DispositionKind, string> = { ok: 'OK', damaged: 'DAMAGED', consumed: 'CONSUMED', sold: 'SOLD', missing: 'MISSING', other: 'OTHER' };
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.06em]" style={{ color: col[kind] }}>
      {kind === 'damaged' ? <TriangleAlert size={10} aria-hidden /> : null}
      {lbl[kind]}
    </span>
  );
}

export default ScanScreen;
