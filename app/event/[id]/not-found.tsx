import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shown when getEvent() returns null (missing or soft-deleted) — notFound() from
// either the detail or the edit route renders this.
export default function EventNotFound() {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX aria-hidden />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Event not found</h1>
        <p className="text-sm text-muted-foreground">
          This event doesn&rsquo;t exist or has been deleted.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}
