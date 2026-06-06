import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shown when getWarehouse() returns null (missing or soft-deleted) — notFound() from the
// warehouse detail route renders this.
export default function WarehouseNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <SearchX className="size-8 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Warehouse not found</h1>
        <p className="text-sm text-muted-foreground">
          This warehouse doesn&apos;t exist or has been deleted.
        </p>
      </div>
      <Button asChild>
        <Link href="/warehouses">All warehouses</Link>
      </Button>
    </div>
  );
}
