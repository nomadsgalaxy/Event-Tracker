import Link from 'next/link';
import { Box } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Shown when getInventoryItem returns null (missing or soft-deleted id).
export default function ItemNotFound() {
  return (
    <div className="mx-auto mt-10 max-w-lg">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Box size={24} className="text-muted-foreground" aria-hidden />
          <div>
            <p className="text-base font-medium">Item not found</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This inventory item does not exist or has been deleted.
            </p>
          </div>
          <Button asChild>
            <Link href="/catalog">Back to inventory</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
