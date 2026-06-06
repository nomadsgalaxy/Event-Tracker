'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// useUnsavedGuard — stop a dirty form from being abandoned by an accidental navigation.
//
// The App Router does CLIENT-SIDE navigation for every <Link> click, and the browser's
// `beforeunload` event only fires for a real document unload (reload, tab close, typing a new URL) —
// NOT for an in-app navigation. So a half-edited form is silently lost the moment you click a nav
// tab, a dashboard card, or a user-menu link. A `beforeunload` handler alone does nothing for those.
//
// This hook closes all three escape routes while `dirty` is true:
//   1. beforeunload  — the native prompt for reload / close / external URL.
//   2. anchor clicks — a CAPTURE-phase document listener catches same-origin <a> navigations (every
//                      Link), cancels them, and raises the in-app discard dialog instead.
//   3. back/forward  — a history sentinel turns a Back press into the same dialog.
//
// On confirm we set a bypass flag and replay the intended navigation; on dismiss we stay put. The
// editor's own Cancel/Save buttons call router.push directly — those are programmatic (not anchor
// clicks) and run only after the form is reset to clean, so they pass through untouched.

type Pending = { kind: 'url'; href: string } | { kind: 'back' } | null;

export interface UnsavedGuard {
  /** True while the discard dialog should be shown. */
  promptOpen: boolean;
  /** Proceed with the navigation the user attempted (discard edits). */
  confirmLeave: () => void;
  /** Stay on the page (keep editing). */
  dismiss: () => void;
  /** Programmatic, guarded navigation for the editor's own Cancel button. */
  guardedPush: (href: string) => void;
}

export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const router = useRouter();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypassRef = useRef(false);
  const [pending, setPending] = useState<Pending>(null);

  // 1. Native unload — reload, tab close, or typing a new URL.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && !bypassRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 2. In-app anchor navigations (every <Link>). Capture phase so we run BEFORE Link's own handler
  // and can cancel the SPA navigation. We only intercept a plain left-click, same-origin, same-tab,
  // non-download link to a DIFFERENT location — everything else (new-tab, external, download, in-page
  // hash) behaves normally.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || bypassRef.current) return;
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const target = anchor.getAttribute('target');
      if (target && target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return; // external link
      const dest = url.pathname + url.search + url.hash;
      const here = window.location.pathname + window.location.search + window.location.hash;
      if (dest === here) return; // same page (incl. pure in-page hash)
      e.preventDefault();
      e.stopPropagation();
      setPending({ kind: 'url', href: dest });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // 3. Back / forward. Arm only while dirty. Push one sentinel on arm; each blocked pop re-pushes one,
  // so exactly two extra entries exist (mount + the blocked pop) when we replay a confirmed Back.
  useEffect(() => {
    if (!dirty) return;
    window.history.pushState(null, '', window.location.href);
    const onPop = () => {
      if (!dirtyRef.current || bypassRef.current) return;
      window.history.pushState(null, '', window.location.href); // stay put, ask first
      setPending({ kind: 'back' });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [dirty]);

  const confirmLeave = useCallback(() => {
    const p = pending;
    setPending(null);
    bypassRef.current = true;
    if (!p) return;
    if (p.kind === 'url') {
      router.push(p.href);
    } else {
      window.history.go(-2); // skip both sentinels to reach the real previous page
    }
  }, [pending, router]);

  const dismiss = useCallback(() => setPending(null), []);

  const guardedPush = useCallback(
    (href: string) => {
      if (dirtyRef.current && !bypassRef.current) {
        setPending({ kind: 'url', href });
      } else {
        bypassRef.current = true;
        router.push(href);
      }
    },
    [router]
  );

  return { promptOpen: pending !== null, confirmLeave, dismiss, guardedPush };
}

// Drop-in discard dialog wired to a guard. Default focus is the safe option (Keep editing).
export function UnsavedChangesDialog({
  guard,
  title = 'Discard unsaved changes?',
  description = 'You have changes that haven’t been saved. Leaving now will lose them.',
}: {
  guard: UnsavedGuard;
  title?: string;
  description?: string;
}) {
  return (
    <Dialog open={guard.promptOpen} onOpenChange={(o) => !o && guard.dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={guard.dismiss} autoFocus>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={guard.confirmLeave}>
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
