import * as React from 'react';

import { cn } from '@/lib/util/utils';
import type { WeatherForecastDay } from '@/lib/types/types-dashboard';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WeatherChip — the SHARED compact per-day forecast chip (DESIGN_ALIGNMENT.md §5; reused later by
// Calendar cells / Event detail). A faithful port of the existing app's WeatherChip (index.html
// ~L22856): a condition emoji + the feels-like temperature, in a tiny muted inline row, with the
// full condition + both °F/°C in the title tooltip.
//
// UNIT PREF: the Python honors the user's temperature unit (unitPrefs.temperature), defaulting °F.
// Client unit-prefs aren't plumbed into the Next.js port yet, so `unit` defaults to 'F' (matching
// the Python default) and accepts an override for the later prefs wire-up. The tooltip always shows
// both scales, so the alternate unit is one hover away either way.
//
// Renders nothing when there's no useful signal (no emoji AND no temperature) — same guard as the
// Python, so an empty/garbage forecast never leaves a stray chip.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WeatherChipProps {
  /** The forecast day to render. Null/empty → renders nothing. */
  w: WeatherForecastDay | null | undefined;
  /** Preferred temperature unit. Defaults to 'F' (the Python default until prefs are plumbed). */
  unit?: 'F' | 'C';
  className?: string;
}

export function WeatherChip({ w, unit = 'F', className }: WeatherChipProps) {
  if (!w || (!w.emoji && w.feelsLikeF == null && w.feelsLikeC == null)) return null;

  const tF = w.feelsLikeF;
  const tC = w.feelsLikeC;

  // Tooltip shows BOTH scales (the alternate unit is always one hover away).
  const tooltipBoth =
    tF != null && tC != null
      ? `${tF}°F · ${tC}°C`
      : tF != null
        ? `${tF}°F`
        : tC != null
          ? `${tC}°C`
          : '';

  // Visible chip uses the preferred unit only (compact), converting if the other scale is the one set.
  const visibleTemp =
    unit === 'F'
      ? tF != null
        ? `${tF}°F`
        : tC != null
          ? `${Math.round((tC * 9) / 5 + 32)}°F`
          : ''
      : tC != null
        ? `${tC}°C`
        : tF != null
          ? `${Math.round(((tF - 32) * 5) / 9)}°C`
          : '';

  const title = `${w.label || ''}${tooltipBoth ? ' · feels ' + tooltipBoth : ''}`.trim();

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground',
        className
      )}
    >
      <span className="text-xs leading-none" aria-hidden>
        {w.emoji || '·'}
      </span>
      {visibleTemp ? (
        <span className="font-mono tabular-nums">{visibleTemp}</span>
      ) : null}
      <span className="sr-only">{title}</span>
    </span>
  );
}

export default WeatherChip;
