import { Skeleton } from '@/components/ui/skeleton';

// Shown while the calendar Server Component reads live from the database. A skeleton of the
// Archetype-A shell — the left view rail + the header + the Year-view mini-month grid — so the
// layout doesn't jump when data arrives.
export default function CalendarLoading() {
  return (
    <div className="flex min-h-0 flex-1">
      {/* Left rail skeleton (desktop only). */}
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r border-border bg-card px-3 py-4 md:flex">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-12" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </aside>

      {/* Main column skeleton. */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-48" />
          </div>
          <div className="flex gap-1">
            <Skeleton className="h-7 w-7" />
            <Skeleton className="h-7 w-7" />
            <Skeleton className="h-7 w-24" />
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
          {/* Mini-month grid. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3">
                <Skeleton className="mb-2 h-3 w-10" />
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: 28 }).map((_, j) => (
                    <Skeleton key={j} className="h-2.5 w-full" />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Schedule panel. */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-36" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
