'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

// version-watcher.tsx — the "always-latest" guard. A no-service-worker port of the Python PWA's
// reg.update()-on-focus loop (index.html ~L1707): the build id is stamped into the bundle at build
// (NEXT_PUBLIC_BUILD_ID) and served live at /api/version. When a NEW build is deployed, an open tab's
// stamp no longer matches the server's, so we reload onto the fresh build — on the next focus /
// visibility regain, and on a slow interval. Mounted once in the root layout; renders nothing.
//
// We never yank the page out from under someone who's actively typing (an input/textarea/contenteditable
// is focused) — the reload is deferred to the next check. Transient/offline fetch failures are ignored.

const CURRENT = process.env.NEXT_PUBLIC_BUILD_ID ?? '';
const INTERVAL_MS = 15 * 60 * 1000; // mirror the Python 15-min recheck

export function VersionWatcher() {
  const reloaded = useRef(false);

  useEffect(() => {
    if (!CURRENT) return; // no stamp (shouldn't happen in a built app) → nothing to compare against

    let stopped = false;

    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };

    const check = async () => {
      if (stopped || reloaded.current) return;
      if (document.visibilityState !== 'visible') return; // don't poll a backgrounded tab
      let latest = '';
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        latest = data.buildId ?? '';
      } catch {
        return; // offline / transient — try again on the next tick
      }
      if (!latest || latest === CURRENT) return;
      if (isTyping()) return; // a new build is live, but defer the reload while the user is typing
      reloaded.current = true;
      toast.message('Updating to the latest version…');
      window.setTimeout(() => window.location.reload(), 400);
    };

    const onWake = () => {
      void check();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    const interval = window.setInterval(onWake, INTERVAL_MS);
    void check(); // initial check on mount (a no-op unless this tab is already behind)

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}

export default VersionWatcher;
