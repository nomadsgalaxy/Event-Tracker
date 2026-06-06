import * as React from 'react';

import { cn } from '@/lib/utils';
import type { DashTag } from '@/lib/types-dashboard';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TagChip + FlairGlyph — the SHARED reusable tag/flair chip (DESIGN_ALIGNMENT.md §5; reused later
// by Calendar / Manifest / Event detail). A faithful port of the existing app's TagChip (index.html
// ~L7227) + FlairGlyph (~L7278): a rounded pill, color-tinted from the tag's hex (≈20% bg / ≈40%
// border), showing the flair glyph then the label. `compact` shows ONLY the flair (or the label's
// first letter when there's no flair) — the form the Dashboard timeline card uses.
//
// FLAG RENDERING (faithful within scope): the Python swaps regional-indicator FLAG emoji for bundled
// SVGs ONLY because Windows renders flag emoji as bare letters. We render the emoji natively (correct
// on macOS/iOS/Android; the two flags in real use — 🇺🇸/🇨🇿 — get crisp inline SVGs below so they're
// right on every OS), keeping the chip styling 1:1. The ~3MB EIT_FLAGS library is intentionally NOT
// vendored — the data + chip API are in place for a later swap if more flags appear.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// The two flags actually in use in the live data (CZ Managed / US Managed). Mirrors index.html
// FlagGlyph (~L7197) so they look identical on every OS regardless of the emoji font.
function FlagSvg({ iso, size }: { iso: 'us' | 'cz'; size: number }) {
  const w = Math.round(size * 1.4);
  if (iso === 'us') {
    return (
      <svg
        width={w}
        height={size}
        viewBox="0 0 14 10"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block', borderRadius: 1 }}
        aria-hidden
      >
        <rect width="14" height="10" fill="#fff" />
        {[0, 1.54, 3.08, 4.62, 6.15, 7.69, 9.23].map((y) => (
          <rect key={y} y={y} width="14" height="0.77" fill="#B22234" />
        ))}
        <rect width="6" height="5.39" fill="#3C3B6E" />
      </svg>
    );
  }
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 14 10"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', borderRadius: 1 }}
      aria-hidden
    >
      <rect width="14" height="5" fill="#fff" />
      <rect y="5" width="14" height="5" fill="#D7141A" />
      <polygon points="0,0 7,5 0,10" fill="#11457E" />
    </svg>
  );
}

// Map a regional-indicator flag emoji (two code points in 0x1F1E6..0x1F1FF) to its ISO-3166 alpha-2.
// Verbatim logic from index.html isoFromFlagEmoji (~L7060).
function isoFromFlagEmoji(str: string): string | null {
  if (!str) return null;
  const cps = Array.from(str);
  if (cps.length !== 2) return null;
  const a = str.codePointAt(0);
  const b = str.codePointAt(cps[0].length);
  if (a === undefined || b === undefined) return null;
  const A = 0x1f1e6;
  const Z = 0x1f1ff;
  if (a >= A && a <= Z && b >= A && b <= Z) {
    return String.fromCharCode(97 + (a - A)) + String.fromCharCode(97 + (b - A));
  }
  return null;
}

/**
 * FlairGlyph — single render path for a flair glyph. A US/CZ flag renders as a crisp inline SVG (so
 * it's right on Windows too); every other emoji/flag renders natively. Exported for reuse (the emoji
 * picker, event detail, etc.).
 */
export function FlairGlyph({
  emoji,
  size = 12,
  title,
}: {
  emoji: string;
  size?: number;
  title?: string;
}) {
  const iso = isoFromFlagEmoji(emoji);
  if (iso === 'us' || iso === 'cz') {
    return (
      <span title={title || iso.toUpperCase()} className="inline-flex items-center">
        <FlagSvg iso={iso} size={size} />
      </span>
    );
  }
  return (
    <span title={title} style={{ lineHeight: 1, fontSize: size }}>
      {emoji || ''}
    </span>
  );
}

export interface TagChipProps {
  /** The tag to render (label + flair + color). Renders nothing when null. */
  tag: DashTag | null | undefined;
  /** Compact form (timeline cards): show ONLY the flair, or the label's first letter when no flair. */
  compact?: boolean;
  /** Optional click — when set, the chip is a button (cursor-pointer); else a static span. */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}

/**
 * The shared tag/flair chip. Color-tinted from the tag's hex; renders the flair glyph then the label
 * (compact = flair-only). 1:1 with the existing app's TagChip.
 */
export function TagChip({ tag, compact = false, onClick, className }: TagChipProps) {
  if (!tag) return null;

  const hasFlair = !!tag.flair;
  // Compact with no flair → show the label's first letter (avoids an empty chip).
  const compactShowsLetter = compact && !hasFlair;
  const label = compact
    ? compactShowsLetter
      ? (tag.label?.[0]?.toUpperCase() ?? '?')
      : ''
    : tag.label;

  // ≈20% bg / ≈40% border tint from the hex, mirroring the Python (color + '33' / color + '66').
  const style: React.CSSProperties = tag.color
    ? { background: `${tag.color}33`, borderColor: `${tag.color}66` }
    : {};

  const content = (
    <>
      {hasFlair ? <FlairGlyph emoji={tag.flair} size={compact ? 11 : 12} /> : null}
      {label ? <span>{label}</span> : null}
    </>
  );

  const base = cn(
    'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-semibold text-foreground',
    tag.color ? '' : 'border-border bg-card',
    compact ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]',
    className
  );

  if (onClick) {
    return (
      <button
        type="button"
        title={tag.label}
        onClick={onClick}
        className={cn(base, 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}
        style={style}
      >
        {content}
      </button>
    );
  }

  return (
    <span title={tag.label} className={base} style={style}>
      {content}
    </span>
  );
}

export default TagChip;
