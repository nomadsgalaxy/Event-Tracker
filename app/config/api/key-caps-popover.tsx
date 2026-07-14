'use client';

import { useMemo } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { CAPS, isDangerousCap } from '@/lib/auth/rbac';

// key-caps-popover.tsx — the clickable "N capabilities" cell in Config > API's All-API-keys table.
// Opens the full permission list the key was minted with (label + id, grouped, dangerous caps
// flagged). Read-only; enforcement is always storedCaps ∩ the owner's live role at request time.

export function KeyCapsPopover({ caps }: { caps: string[] }) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, { id: string; label: string; dangerous: boolean }[]>();
    for (const id of caps) {
      const def = CAPS[id];
      const group = def?.group || 'Other';
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push({ id, label: def?.label || id, dangerous: isDangerousCap(id) });
    }
    return [...byGroup.entries()];
  }, [caps]);

  const dangerousCount = caps.filter(isDangerousCap).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Show the ${caps.length} capabilities this key is scoped to`}
        >
          {caps.length} {caps.length === 1 ? 'capability' : 'capabilities'}
          {dangerousCount > 0 && <TriangleAlert className="size-3 text-warning" aria-hidden />}
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Scoped at mint time — every request re-intersects these with the owner&apos;s live role.
        </p>
        {caps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No capabilities (the key can do nothing).</p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map(([group, list]) => (
              <div key={group}>
                <p className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{group}</p>
                <ul className="flex flex-col gap-1">
                  {list.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{c.label}</span>
                        {c.dangerous && (
                          <Badge variant="outline" className="shrink-0 gap-1 text-[10px] text-warning" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
                            <TriangleAlert className="size-2.5" aria-hidden /> risky
                          </Badge>
                        )}
                      </span>
                      <code className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.id}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
