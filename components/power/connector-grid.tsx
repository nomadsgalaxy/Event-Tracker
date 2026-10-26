'use client';

// The connector tile picker (item inlets / cable ends / fixed plugs, and the event receptacle grid).
// ~85 connectors are too many to show at once, so it shows ONE group: the caller's detected group
// (the venue's region, the item's home region, or the group of what's already picked), which a
// dropdown overrides. Tiles in other groups stay selected while hidden; the dropdown counts them.

import { useState, type ReactNode } from 'react';
import { CONNECTOR_GROUP_LABEL, type ConnectorGroup } from '@/lib/power/connectors';
import { cn } from '@/lib/util/utils';

export type ConnectorTile = {
  id: string;
  label: string;
  group: ConnectorGroup;
  svg: ReactNode;
  sub: string;
  title?: string;
  /** Shown faded (still pickable) — e.g. a receptacle no assigned equipment can use. */
  dim?: boolean;
};

export function ConnectorTileButton({ tile, on, disabled, onClick }: { tile: ConnectorTile; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      title={tile.title ?? `${tile.label} · ${tile.sub}`}
      className={cn(
        'flex w-[84px] flex-col items-center gap-0.5 rounded-md border px-2 py-2 text-center transition-colors',
        on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50',
        tile.dim && 'opacity-40'
      )}
    >
      <span className="size-9 text-foreground">{tile.svg}</span>
      <span className="text-[10px] font-medium leading-tight">{tile.label}</span>
      <span className="text-[9px] tabular-nums leading-tight">{tile.sub}</span>
    </button>
  );
}

export function ConnectorGrid({
  items,
  isOn,
  onPick,
  disabled,
  detected,
  lead,
  label = 'Region / type',
}: {
  items: ConnectorTile[];
  isOn: (id: string) => boolean;
  onPick: (id: string, on: boolean) => void;
  disabled: boolean;
  /** The auto-detected group; followed until the user picks another one from the dropdown. */
  detected: ConnectorGroup;
  /** Always-visible tiles ahead of the group (the region-default plug, Fixed cord / Hardwired). */
  lead?: ReactNode;
  label?: string;
}) {
  const groups = [...new Set(items.map((i) => i.group))];
  const [override, setOverride] = useState<ConnectorGroup | null>(null);
  const shown = override && groups.includes(override) ? override : groups.includes(detected) ? detected : groups[0];
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {label}
        <select
          value={shown}
          onChange={(e) => setOverride(e.target.value as ConnectorGroup)}
          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs text-foreground outline-none dark:bg-input/30"
        >
          {groups.map((g) => {
            const picked = items.filter((i) => i.group === g && isOn(i.id)).length;
            return (
              <option key={g} value={g}>
                {CONNECTOR_GROUP_LABEL[g]}
                {g === detected ? ' (detected)' : ''}
                {picked ? ` · ${picked} selected` : ''}
              </option>
            );
          })}
        </select>
        {override && override !== detected ? (
          <button type="button" onClick={() => setOverride(null)} className="text-[11px] underline underline-offset-2 hover:text-foreground">
            back to {CONNECTOR_GROUP_LABEL[detected]}
          </button>
        ) : null}
      </label>
      <div className="flex flex-wrap gap-1.5">
        {lead}
        {items
          .filter((t) => t.group === shown)
          .map((t) => {
            const on = isOn(t.id);
            return <ConnectorTileButton key={t.id} tile={t} on={on} disabled={disabled} onClick={() => onPick(t.id, on)} />;
          })}
      </div>
    </div>
  );
}
