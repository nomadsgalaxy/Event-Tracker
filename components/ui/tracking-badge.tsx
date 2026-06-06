import * as React from 'react';

import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TrackingBadge — the SHARED inline carrier-tracking affordance next to a shipment / pallet
// tracking number (DESIGN_ALIGNMENT §0 feature-parity; reused by the Shipping tab + the read-only
// Pallets view). A faithful port of index.html TrackingBadge (~L11316).
//
// PROVIDER STATE (matches the live deploy): no live-status tracking provider (EasyPost / 17TRACK /
// AfterShip key) is wired into the Next.js stack yet, so — exactly like the Python's no-provider
// branch — we render the FREE, no-login 17TRACK manual tracker link, pre-filled with the number.
// That covers parcel + LTL (incl. UniShippers). The render is deterministic (a static link, no
// client-only reads), so this is safe in a Server Component AND needs no mount-gate. When a free
// 17TRACK key later lands behind a /ship-track proxy, the inline live-status chip slots in here
// (the Python's `state==='done'` branch) without changing any call site.
//
// Renders nothing when there's no tracking number — same guard as the Python.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TrackingBadgeProps {
  /** The carrier tracking number. Blank/whitespace → renders nothing. */
  number?: string | null;
  /** Carrier hint (threaded for the future live-status lookup; unused by the link-out). */
  carrier?: string | null;
  className?: string;
}

export function TrackingBadge({ number, carrier, className }: TrackingBadgeProps) {
  void carrier; // reserved for the future live-status lookup (mirrors the Python signature)
  const num = String(number ?? '').trim();
  if (!num) return null;

  // The 17TRACK web tracker pre-fills the number (free, no login). Mirrors the Python no-provider
  // link-out: `https://t.17track.net/en#nums=<num>`.
  const href = `https://t.17track.net/en#nums=${encodeURIComponent(num)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open a free manual tracking page. A free 17TRACK key in Config → Shipping Data adds inline live status."
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground',
        className
      )}
    >
      Track
      <span aria-hidden>↗</span>
    </a>
  );
}

export default TrackingBadge;
