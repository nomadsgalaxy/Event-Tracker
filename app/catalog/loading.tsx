import { Skeleton } from '@/components/ui/skeleton';

// Shown while the merged catalog Server Component reads cases + inventory + warehouses live from the
// database. A skeleton of the Archetype-A shell (left rail + a header over a card grid) so the
// layout doesn't jump when data arrives.
export default function CatalogLoading() {
  return (
    <div className="flex min-h-0 flex-1">
      {/* rail */}
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r border-border bg-card px-3 py-4 md:flex">
        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ))}
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-80" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
