'use client';

import { useEffect, useState } from 'react';

// app/scan/use-is-mobile.ts — a tiny breakpoint probe for the Scan-Pack two-column / single-column
// switch. Mirrors window.useViewport().isMobile in the Python app (the < md breakpoint at 768px).
// SSR-safe: starts at the DESKTOP default (false) so the server render + first client paint agree
// (no hydration flash), then corrects on mount + resize. Scan-Pack is mobile-first but its desktop
// layout is a real two-column pane, so this is the one piece of JS-level width the screen needs.

export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < breakpoint);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [breakpoint]);
  return isMobile;
}
