import { Construction } from 'lucide-react';

// coming-soon.tsx — the placeholder block the not-yet-built nav destinations render under their
// ScreenHeader so the nav never 404s and the IA is fully walkable now. A centered message in a
// dashed border-border block (the app's standard empty-state convention, §5) — icon + title + one
// line. Replaced wholesale when each screen is built; the route + header stay.

export function ComingSoon({ note }: { note?: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <Construction size={28} className="mb-3 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">Coming in a later wave</p>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {note ?? 'This screen is part of the navigation map but is not built yet.'}
      </p>
    </div>
  );
}

export default ComingSoon;
