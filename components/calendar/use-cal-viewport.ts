'use client';

import { useEffect, useState } from 'react';

// useCalViewport — a tiny breakpoint + orientation probe for the Week view's hour grid. The Python
// renders a responsive day-column count (3 mobile / 5 tablet / 7 desktop) and a portrait-mode
// "Rotate for week view" hint (CalWeek ~L23163), which needs JS-level width/orientation knowledge —
// Tailwind's CSS breakpoints can't change a JS-driven column count or a hint-card condition.
//
// SSR-safe: starts at the desktop defaults (dayCount 7, not portrait) so the server render and the
// first client paint agree (no hydration mismatch / no portrait flash), then corrects on mount. The
// thresholds mirror the app's md (768) / lg (1024) breakpoints: <768 = mobile, 768–1023 = tablet,
// ≥1024 = desktop.

export interface CalViewport {
  /** 3 (mobile) / 5 (tablet) / 7 (desktop) — the Week view's visible day-column count. */
  dayCount: number;
  /** True on a narrow viewport in portrait orientation → show the "rotate" hint. */
  isPortraitMobile: boolean;
}

function read(): CalViewport {
  if (typeof window === 'undefined') return { dayCount: 7, isPortraitMobile: false };
  const w = window.innerWidth;
  const isMobile = w < 768;
  const isTablet = w >= 768 && w < 1024;
  const dayCount = isMobile ? 3 : isTablet ? 5 : 7;
  // Portrait = taller than wide. The hour grid is unreadable in mobile portrait → hint to rotate.
  const isPortrait = window.innerHeight >= window.innerWidth;
  return { dayCount, isPortraitMobile: isMobile && isPortrait };
}

export function useCalViewport(): CalViewport {
  // Desktop default for SSR/first paint; corrected on mount.
  const [vp, setVp] = useState<CalViewport>({ dayCount: 7, isPortraitMobile: false });

  useEffect(() => {
    const update = () => setVp(read());
    update();
    window.addEventListener('resize', update);
    const mq = window.matchMedia('(orientation: portrait)');
    mq.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      mq.removeEventListener('change', update);
    };
  }, []);

  return vp;
}
