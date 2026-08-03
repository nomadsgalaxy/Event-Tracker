'use client';

import { useEffect, useState } from 'react';

// components/hooks/use-is-mobile.ts — THE mobile probe (the app's < md breakpoint at 768px), shared
// by any screen that needs JS-level layout branching (Scan-Pack's two-column/single-column switch).
// matchMedia with a change listener — fires only when the breakpoint actually flips, not on every
// resize pixel.
//
// SSR: `initial` seeds the server render + first client paint. Pass the server's user-agent hint
// (lib/util/is-mobile-ua — server-safe on purpose) so a phone gets the mobile layout on the FIRST paint instead of a desktop flash;
// omit it for the old desktop-first default. Either way the value corrects on mount from the real
// viewport, so a UA guess can never stick wrong.

export function useIsMobile(breakpoint = 768, initial = false): boolean {
  const [isMobile, setIsMobile] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);
  return isMobile;
}
