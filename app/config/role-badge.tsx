import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { DEFAULT_ROLES } from '@/lib/rbac';

// role-badge.tsx — a small chip that maps a directory ROLE id to its color + label from the rbac
// role table (lib/rbac DEFAULT_ROLES). This is NOT an event/case STATUS — those are owned solely
// by StatusBadge / the --st-* tokens — so it uses the role table's own color tokens
// (var(--muted-foreground) / --success / --st-upcoming / --primary), never an --st-<state> token.
// Single source for role color so the Users table and the Permissions grid stay in lockstep.

const ROLE_BY_ID = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.id, r]));

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  const def = ROLE_BY_ID[role];
  const color = def?.color ?? 'var(--muted-foreground)';
  const label = def?.label ?? role ?? 'Unknown';
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 font-medium', className)}
      style={{ color, borderColor: color }}
    >
      <span className="inline-block size-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </Badge>
  );
}
