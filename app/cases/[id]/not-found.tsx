import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shown when getCase() returns null (missing or soft-deleted) — notFound() from the case detail
// route renders this.
export default function CaseNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <SearchX className="size-8 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Case not found</h1>
        <p className="text-sm text-muted-foreground">
          This road case doesn&apos;t exist or has been deleted.
        </p>
      </div>
      <Button asChild>
        <Link href="/cases">All cases</Link>
      </Button>
    </div>
  );
}
