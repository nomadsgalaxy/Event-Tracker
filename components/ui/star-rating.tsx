'use client';

import * as React from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/util/utils';

// components/ui/star-rating.tsx — the shared 1–5 star widget.
//
// Interactive (onChange set): a radiogroup of five buttons; clicking the current value clears it
// (a mistaken tap must be undoable). Read-only (no onChange): a static row for report/display use.
// Used by the event editor's HotelEditor and the post-event FeedbackCard.

export function StarRating({
  value,
  onChange,
  size = 16,
  label = 'Rating',
  className,
}: {
  value: number;
  onChange?: (n: number) => void;
  size?: number;
  label?: string;
  className?: string;
}) {
  if (!onChange) {
    return (
      <span className={cn('inline-flex items-center', className)} role="img" aria-label={`${label}: ${value || 0} of 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            size={size}
            className={n <= value ? 'fill-primary text-primary' : 'text-muted-foreground/50'}
            aria-hidden
          />
        ))}
      </span>
    );
  }
  return (
    <div className={cn('flex items-center', className)} role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={() => onChange(n === value ? 0 : n)}
          className="rounded p-1 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Star size={size} className={n <= value ? 'fill-primary text-primary' : 'text-muted-foreground'} aria-hidden />
        </button>
      ))}
    </div>
  );
}
