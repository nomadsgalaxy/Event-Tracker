import { Skeleton } from '@/components/ui/skeleton';

// Shown while the Manifest Server Component reads events + cases + inventory live from the database
// and builds every event's manifest. A skeleton of the Archetype-A shell (event-list rail + a header
// over the progress card and case cards) so the layout doesn't jump when the data arrives.
export default function ManifestLoading() {
  return (
    <div className="flex min-h-0 flex-1">
      {/* event-list rail */}
      <aside className="hidden w-56 shrink-0 flex-col gap-2 border-r border-border bg-card px-3 py-4 md:flex">
        <Skeleton className="h-3 w-24" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
