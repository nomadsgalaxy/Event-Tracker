'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Pencil, Plus, Trash2, X, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/util/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eyebrow } from '@/components/ui/eyebrow';
import { FlairGlyph } from '@/components/ui/tag-chip';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createTagAction, saveTagAction, deleteTagAction } from '../admin-actions';
import { useFlairLibrary, firstEmoji, type FlairDef } from './flair-library';

// tags-panel.tsx — the Config > Tags interactive manager. Faithful port of the Python TagsConfigPanel
// + FlairManagerCard (index.html ~L25931 / ~L25791): a tag-library card (CRUD over the universal tag
// library — create/rename/hidden/color/flair, usage counts, duplicate-pulse, rename-confirm at >3
// uses, admin-gated delete) followed by the Flair-library manager (reusable emoji flairs, a per-
// browser palette). Tag writes go through the gated Server Actions (tags.edit/tags.delete re-checked
// server-side); the live-DB read is the source of truth, so after each write we router.refresh().

export interface TagLibRow {
  id: string;
  label: string;
  hidden: boolean;
  color: string | null;
  flair: string | null;
  customEmoji: string;
  eventUses: number;
  itemUses: number;
}

// The 8-swatch palette, mirrored from window.TAG_COLOR_PALETTE (index.html ~L2912).
const TAG_COLOR_PALETTE: { name: string; hex: string }[] = [
  { name: 'Orange', hex: '#FD5000' },
  { name: 'Blue', hex: '#346EF4' },
  { name: 'Green', hex: '#65C900' },
  { name: 'Purple', hex: '#A78BFA' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Red', hex: '#EF4444' },
  { name: 'Teal', hex: '#06B6D4' },
  { name: 'Neutral', hex: '#888888' },
];

function totalUses(r: TagLibRow): number {
  return r.eventUses + r.itemUses;
}

export function TagsPanel({
  rows,
  canEdit,
  canDelete,
  isAdmin,
}: {
  rows: TagLibRow[];
  canEdit: boolean;
  canDelete: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [renameModal, setRenameModal] = React.useState<{ row: TagLibRow; newLabel: string } | null>(null);
  const [deleteModal, setDeleteModal] = React.useState<TagLibRow | null>(null);
  const [pulsingId, setPulsingId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const rowRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  const live = rows; // server already excludes tombstones
  const sortedVisible = live.filter((t) => !t.hidden).slice().sort((a, b) => a.label.localeCompare(b.label));
  const sortedHidden = live.filter((t) => t.hidden).slice().sort((a, b) => a.label.localeCompare(b.label));

  const triggerPulse = React.useCallback((id: string) => {
    setPulsingId(id);
    const node = rowRefs.current[id];
    node?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => setPulsingId((cur) => (cur === id ? null : cur)), 900);
  }, []);

  const findByLabel = React.useCallback(
    (raw: string, excludeId: string | null): TagLibRow | null => {
      const lower = raw.trim().toLowerCase();
      if (!lower) return null;
      return live.find((t) => t.id !== excludeId && t.label.toLowerCase() === lower) ?? null;
    },
    [live]
  );

  const refresh = () => router.refresh();

  const handleCreate = (label: string) => {
    const dupe = findByLabel(label, null);
    if (dupe) {
      triggerPulse(dupe.id);
      setCreating(false);
      return;
    }
    startTransition(async () => {
      const res = await createTagAction({ label, hidden: false });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      if (res.duplicate && res.id) {
        triggerPulse(res.id);
      }
      setCreating(false);
      refresh();
    });
  };

  const handleUpdate = (row: TagLibRow, patch: Partial<Pick<TagLibRow, 'hidden' | 'color' | 'flair' | 'customEmoji'>>) => {
    setBusyId(row.id);
    startTransition(async () => {
      const res = await saveTagAction(row.id, patch);
      setBusyId(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      refresh();
    });
  };

  const handleLabelSave = (row: TagLibRow, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === row.label) {
      setEditingId(null);
      return;
    }
    const dupe = findByLabel(trimmed, row.id);
    if (dupe) {
      triggerPulse(dupe.id);
      setEditingId(null);
      return;
    }
    if (totalUses(row) > 3) {
      setRenameModal({ row, newLabel: trimmed });
      setEditingId(null);
      return;
    }
    commitRename(row.id, trimmed);
    setEditingId(null);
  };

  const commitRename = (id: string, label: string) => {
    setBusyId(id);
    startTransition(async () => {
      const res = await saveTagAction(id, { label });
      setBusyId(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      refresh();
    });
  };

  const confirmRename = () => {
    if (!renameModal) return;
    commitRename(renameModal.row.id, renameModal.newLabel);
    setRenameModal(null);
  };

  const handleDeleteClick = (row: TagLibRow) => {
    const count = totalUses(row);
    // The >3-uses graduation: deleting a heavily-used tag needs admin (mirrors policy.canDelete).
    if (count > 3 && !isAdmin) {
      toast.warning(`Deleting a tag with ${count} uses requires admin authority.`);
      return;
    }
    setDeleteModal(row);
  };

  const confirmDelete = () => {
    if (!deleteModal) return;
    const id = deleteModal.id;
    setBusyId(id);
    startTransition(async () => {
      const res = await deleteTagAction(id);
      setBusyId(null);
      setDeleteModal(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('Tag deleted.');
      refresh();
    });
  };

  return (
    <div className="space-y-5">
      {/* ── Tag library card ── */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <Eyebrow>Tags</Eyebrow>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Tag library</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Universal tags — apply to events or inventory items. Hidden tags are searchable but
              won&apos;t render as chips on preview surfaces. Renaming a tag with more than 3 uses asks for
              confirmation.
            </p>
          </div>
          {canEdit && !creating && (
            <Button size="sm" onClick={() => setCreating(true)} disabled={isPending}>
              <Plus className="size-4" aria-hidden /> New tag
            </Button>
          )}
        </div>

        {creating && canEdit && (
          <NewTagForm
            existingLabels={live.map((t) => t.label.toLowerCase())}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            pending={isPending}
          />
        )}

        {live.length === 0 && !creating && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-xs italic text-muted-foreground">
            {canEdit ? 'No tags yet. Click "New tag" to create the first one.' : 'No tags yet. Manager+ can create them.'}
          </div>
        )}

        {sortedVisible.map((row) => (
          <TagRow
            key={row.id}
            row={row}
            canEdit={canEdit}
            canDelete={canDelete}
            editing={editingId === row.id}
            pulsing={pulsingId === row.id}
            busy={busyId === row.id}
            rowRef={(el) => (rowRefs.current[row.id] = el)}
            onStartEdit={() => setEditingId(row.id)}
            onCancelEdit={() => setEditingId(null)}
            onSaveLabel={(v) => handleLabelSave(row, v)}
            onUpdate={(patch) => handleUpdate(row, patch)}
            onDelete={() => handleDeleteClick(row)}
          />
        ))}

        {sortedHidden.length > 0 && (
          <>
            <div className="mt-3 border-t border-dashed border-border pt-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Hidden ({sortedHidden.length})
            </div>
            {sortedHidden.map((row) => (
              <TagRow
                key={row.id}
                row={row}
                canEdit={canEdit}
                canDelete={canDelete}
                editing={editingId === row.id}
                pulsing={pulsingId === row.id}
                busy={busyId === row.id}
                rowRef={(el) => (rowRefs.current[row.id] = el)}
                onStartEdit={() => setEditingId(row.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveLabel={(v) => handleLabelSave(row, v)}
                onUpdate={(patch) => handleUpdate(row, patch)}
                onDelete={() => handleDeleteClick(row)}
              />
            ))}
          </>
        )}
      </section>

      {/* ── Flair library manager ── */}
      <FlairManager canEdit={canEdit} />

      {/* Rename confirm (>3 uses) */}
      <Dialog open={renameModal !== null} onOpenChange={(v) => !v && setRenameModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm rename</DialogTitle>
            <DialogDescription>
              {renameModal && (
                <>
                  This tag is used in{' '}
                  <strong className="text-foreground">
                    {totalUses(renameModal.row)} place{totalUses(renameModal.row) === 1 ? '' : 's'}
                  </strong>
                  . Renaming updates all references automatically.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {renameModal && (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              <span className="text-muted-foreground">{renameModal.row.label}</span>
              <span className="mx-2 text-muted-foreground/60">→</span>
              <span className="font-semibold text-foreground">{renameModal.newLabel}</span>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={confirmRename} disabled={isPending}>
              {isPending && <Loader2 className="animate-spin" aria-hidden />}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteModal !== null} onOpenChange={(v) => !v && setDeleteModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete tag</DialogTitle>
            <DialogDescription>
              {deleteModal && (
                <>
                  Delete <strong className="text-foreground">{deleteModal.label}</strong>?{' '}
                  {totalUses(deleteModal) > 0 ? (
                    <>
                      This removes the tag from{' '}
                      <strong className="text-foreground">
                        {deleteModal.eventUses} event{deleteModal.eventUses === 1 ? '' : 's'}
                      </strong>{' '}
                      and{' '}
                      <strong className="text-foreground">
                        {deleteModal.itemUses} inventory item{deleteModal.itemUses === 1 ? '' : 's'}
                      </strong>
                      .
                    </>
                  ) : (
                    "The tag isn't currently in use."
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete} disabled={isPending}>
              {isPending && <Loader2 className="animate-spin" aria-hidden />}
              Yes, remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewTagForm({
  existingLabels,
  onSave,
  onCancel,
  pending,
}: {
  existingLabels: string[];
  onSave: (label: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [label, setLabel] = React.useState('');
  const trimmed = label.trim();
  const isDupe = !!trimmed && existingLabels.includes(trimmed.toLowerCase());
  const submit = () => {
    if (trimmed) onSave(trimmed);
  };
  return (
    <div className="mb-3 rounded-md border border-primary/60 bg-background p-2.5">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="New tag label…"
          aria-label="New tag label"
          className="flex-1"
        />
        <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!trimmed || pending}>
          {isDupe ? 'Highlight existing' : 'Create'}
        </Button>
      </div>
      {isDupe && (
        <p className="mt-1.5 text-[11px] text-primary">
          A tag named &quot;{trimmed}&quot; already exists — submit to highlight it instead of duplicating.
        </p>
      )}
    </div>
  );
}

function TagRow({
  row,
  canEdit,
  canDelete,
  editing,
  pulsing,
  busy,
  rowRef,
  onStartEdit,
  onCancelEdit,
  onSaveLabel,
  onUpdate,
  onDelete,
}: {
  row: TagLibRow;
  canEdit: boolean;
  canDelete: boolean;
  editing: boolean;
  pulsing: boolean;
  busy: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveLabel: (v: string) => void;
  onUpdate: (patch: Partial<Pick<TagLibRow, 'hidden' | 'color' | 'flair' | 'customEmoji'>>) => void;
  onDelete: () => void;
}) {
  const uses = totalUses(row);
  return (
    <div
      ref={rowRef}
      className={cn(
        'flex items-center gap-2.5 rounded border-b border-border px-2 py-2.5 transition-all',
        pulsing && 'bg-primary/10 ring-2 ring-inset ring-primary'
      )}
    >
      {/* Hidden toggle */}
      <button
        type="button"
        title={row.hidden ? 'Hidden — click to show on previews' : 'Visible — click to hide'}
        disabled={!canEdit || busy}
        onClick={() => onUpdate({ hidden: !row.hidden })}
        className={cn(
          'flex size-6 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          row.hidden ? 'text-muted-foreground/50' : 'text-primary'
        )}
        aria-label={row.hidden ? 'Show tag' : 'Hide tag'}
      >
        {row.hidden ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>

      {/* Color swatch */}
      <ColorSwatch color={row.color} disabled={!canEdit || busy} onChange={(c) => onUpdate({ color: c })} />

      {/* Flair */}
      <FlairSelect
        value={row.flair}
        customEmoji={row.customEmoji}
        disabled={!canEdit || busy}
        onChange={(v) => onUpdate(v)}
      />

      {/* Label */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            defaultValue={row.label}
            onBlur={(e) => onSaveLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = row.label;
                onCancelEdit();
              }
            }}
            className="h-8"
            aria-label={`Rename ${row.label}`}
          />
        ) : (
          <button
            type="button"
            onClick={canEdit ? onStartEdit : undefined}
            disabled={!canEdit}
            className="truncate text-left text-sm font-medium text-foreground outline-none focus-visible:underline disabled:cursor-default"
          >
            {row.label}
          </button>
        )}
      </div>

      {/* Use count */}
      <span className="min-w-[60px] whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
        {busy ? <Loader2 className="ml-auto size-3.5 animate-spin" aria-hidden /> : uses === 0 ? 'unused' : `${uses} use${uses === 1 ? '' : 's'}`}
      </span>

      {/* Delete */}
      {canDelete && (
        <button
          type="button"
          title={`Delete ${row.label}`}
          onClick={onDelete}
          disabled={busy}
          className="flex size-6 items-center justify-center rounded border border-border text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={`Delete ${row.label}`}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function ColorSwatch({
  color,
  disabled,
  onChange,
}: {
  color: string | null;
  disabled: boolean;
  onChange: (c: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={color ? `Color: ${color}` : 'No color (click to choose)'}
          className="size-6 shrink-0 rounded border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          style={{
            background:
              color ||
              'repeating-linear-gradient(45deg, var(--muted), var(--muted) 4px, var(--card) 4px, var(--card) 8px)',
          }}
          aria-label="Choose tag color"
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-6 gap-1">
          <button
            type="button"
            title="Clear color"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex size-6 items-center justify-center rounded border border-border bg-background text-xs text-muted-foreground"
            aria-label="Clear color"
          >
            <X className="size-3" aria-hidden />
          </button>
          {TAG_COLOR_PALETTE.map((p) => (
            <button
              key={p.hex}
              type="button"
              title={p.name}
              onClick={() => {
                onChange(p.hex);
                setOpen(false);
              }}
              className={cn(
                'size-6 rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring',
                color === p.hex ? 'border-2 border-foreground' : 'border-border'
              )}
              style={{ background: p.hex }}
              aria-label={p.name}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const LEGACY_FLAGS = ['flag-us', 'flag-cz'] as const;
const CUSTOM = '__custom__';
const NONE = '__none__';

function FlairSelect({
  value,
  customEmoji,
  disabled,
  onChange,
}: {
  value: string | null;
  customEmoji: string;
  disabled: boolean;
  onChange: (v: { flair: string | null; customEmoji: string }) => void;
}) {
  const flairs = useFlairLibrary();
  const isLegacy = value === 'flag-us' || value === 'flag-cz';
  const isCustom = value === 'custom';
  const isOrphan = !!value && !isLegacy && !isCustom && !flairs.some((f) => f.id === value);
  const selectValue = value ? (isCustom ? CUSTOM : value) : NONE;

  const handleSelect = (nv: string) => {
    if (nv === NONE) return onChange({ flair: null, customEmoji: '' });
    if (nv === CUSTOM) return onChange({ flair: 'custom', customEmoji: customEmoji || '' });
    if (nv === 'flag-us' || nv === 'flag-cz') return onChange({ flair: nv, customEmoji: '' });
    const f = flairs.find((x) => x.id === nv);
    onChange({ flair: nv, customEmoji: f ? f.emoji : customEmoji || '' });
  };

  return (
    <div className="flex items-center gap-1">
      <Select value={selectValue} disabled={disabled} onValueChange={handleSelect}>
        <SelectTrigger className="h-8 w-36 text-xs" aria-label="Tag flair">
          <SelectValue placeholder="No flair" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No flair</SelectItem>
          {flairs.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.emoji} {f.label || f.emoji}
            </SelectItem>
          ))}
          {isLegacy && <SelectItem value={value!}>{value === 'flag-us' ? '🇺🇸 USA (flag)' : '🇨🇿 CZ (flag)'}</SelectItem>}
          {isOrphan && <SelectItem value={value!}>{(customEmoji || '•') + ' (removed flair)'}</SelectItem>}
          <SelectItem value={CUSTOM}>Custom emoji…</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && (
        <span className="inline-flex items-center gap-1">
          {customEmoji ? <FlairGlyph emoji={customEmoji} size={16} /> : null}
          <Input
            value={customEmoji}
            disabled={disabled}
            onChange={(e) => onChange({ flair: 'custom', customEmoji: firstEmoji(e.target.value) })}
            placeholder="🌟"
            aria-label="Custom emoji"
            className="h-8 w-12 text-center text-base"
          />
        </span>
      )}
    </div>
  );
}

// ── Flair library manager (the per-browser reusable-flair palette) ──────────────────────────────
function FlairManager({ canEdit }: { canEdit: boolean }) {
  const flairs = useFlairLibrary();
  const [draft, setDraft] = React.useState({ emoji: '', label: '' });
  const [editId, setEditId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState({ emoji: '', label: '' });

  const add = () => {
    if (!draft.emoji.trim()) return;
    useFlairLibrary.add(draft);
    setDraft({ emoji: '', label: '' });
  };
  const startEdit = (f: FlairDef) => {
    setEditId(f.id);
    setEditDraft({ emoji: f.emoji, label: f.label || '' });
  };
  const saveEdit = () => {
    if (!editId || !editDraft.emoji.trim()) return;
    useFlairLibrary.update(editId, editDraft);
    setEditId(null);
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3">
        <Eyebrow>Tags</Eyebrow>
        <h2 className="mt-1 text-lg font-semibold text-foreground">Flair library</h2>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
          Reusable emoji flairs you can attach to any tag from its row. Edit or remove these presets —
          removing one leaves any tag already using it unchanged (it keeps the emoji).
        </p>
      </div>

      {canEdit && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {draft.emoji ? <FlairGlyph emoji={draft.emoji} size={18} /> : null}
          <Input
            value={draft.emoji}
            onChange={(e) => setDraft((s) => ({ ...s, emoji: firstEmoji(e.target.value) }))}
            placeholder="⭐"
            aria-label="Flair emoji"
            className="h-9 w-12 text-center text-base"
          />
          <Input
            value={draft.label}
            onChange={(e) => setDraft((s) => ({ ...s, label: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="Label (optional)"
            aria-label="Flair label"
            className="h-9 min-w-[140px] flex-1"
          />
          <Button size="sm" onClick={add} disabled={!draft.emoji.trim()}>
            <Plus className="size-4" aria-hidden /> Add flair
          </Button>
        </div>
      )}

      {flairs.length === 0 ? (
        <div className="p-3 text-center text-xs italic text-muted-foreground">No flairs. Add one above.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {flairs.map((f) => (
            <div key={f.id} className="flex items-center gap-2.5 rounded border border-border px-2.5 py-2">
              {editId === f.id ? (
                <>
                  {editDraft.emoji ? <FlairGlyph emoji={editDraft.emoji} size={18} /> : null}
                  <Input
                    value={editDraft.emoji}
                    onChange={(e) => setEditDraft((s) => ({ ...s, emoji: firstEmoji(e.target.value) }))}
                    aria-label="Flair emoji"
                    className="h-8 w-12 text-center text-base"
                  />
                  <Input
                    value={editDraft.label}
                    onChange={(e) => setEditDraft((s) => ({ ...s, label: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit();
                      if (e.key === 'Escape') setEditId(null);
                    }}
                    aria-label="Flair label"
                    className="h-8 flex-1"
                  />
                  <Button size="sm" onClick={saveEdit}>
                    <Check className="size-4" aria-hidden /> Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex w-7 justify-center">
                    <FlairGlyph emoji={f.emoji} size={18} />
                  </span>
                  <span className="flex-1 text-sm text-foreground">
                    {f.label || <span className="text-muted-foreground">(no label)</span>}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      title="Edit flair"
                      onClick={() => startEdit(f)}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Edit flair ${f.label || f.emoji}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      title="Delete flair"
                      onClick={() => useFlairLibrary.remove(f.id)}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Delete flair ${f.label || f.emoji}`}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!canEdit && <p className="mt-2.5 text-[11px] text-muted-foreground">Manager+ can add or edit flairs.</p>}
    </section>
  );
}

export default TagsPanel;
