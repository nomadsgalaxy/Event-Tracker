import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Single source of truth for event/case status color. Maps a state -> its --st-<state> token.
// Features import THIS, never inline a status color (DESIGN_SYSTEM.md §3).
const LABELS: Record<string, string> = {
  draft: 'Draft',
  upcoming: 'Upcoming',
  packing: 'Packing',
  ready: 'Ready',
  in_transit: 'In transit',
  onsite: 'On site',
  returning: 'Returning',
  unpacking: 'Unpacking',
  closed: 'Closed',
};

export function StatusBadge({
  state,
  className,
}: {
  state?: string | null;
  className?: string;
}) {
  const token = state ? `var(--st-${state})` : 'var(--muted-foreground)';
  return (
    <Badge
      variant="outline"
      // UPPERCASE to match the Python STATE_STYLES labels ('IN TRANSIT', 'DRAFT', 'ON SITE', …).
      // tracking-wide spaces the caps so they read like the Python pill, not a shouty run-on. The
      // CSS uppercase transform keeps the LABELS map (and any aria/title text) in sentence case.
      className={cn('gap-1.5 font-medium uppercase tracking-wide', className)}
      style={{ color: token, borderColor: token }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: token }}
        aria-hidden
      />
      {(state && LABELS[state]) || state || 'Unknown'}
    </Badge>
  );
}
