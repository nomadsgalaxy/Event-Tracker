'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

// app/login/google-one-tap.tsx — Google One Tap (GIS) on the login page. If the browser has an active
// Google session, Google surfaces the account in a one-tap prompt (and auto-signs a returning, already-
// consented user in). The prompt delivers a verified ID token to the callback, which we POST to
// /api/auth/google/onetap to mint the session. No prompt appears when there's no Google session.
//
// SETUP: the app origin (e.g. https://prusa.eventtracker.dev, and http://localhost:3100 for dev) must
// be listed under "Authorized JavaScript origins" for the OAuth client in Google Cloud, or One Tap is
// silently suppressed. The button-based "Continue with Google" redirect flow keeps working regardless.

interface CredentialResponse {
  credential?: string;
}
interface GsiId {
  initialize: (cfg: Record<string, unknown>) => void;
  prompt: () => void;
  cancel: () => void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export function GoogleOneTap({ clientId, next }: { clientId: string; next?: string }) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!clientId || startedRef.current) return;
    startedRef.current = true;

    async function onCredential(resp: CredentialResponse) {
      const credential = resp?.credential;
      if (!credential) return;
      try {
        const r = await fetch('/api/auth/google/onetap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential }),
        });
        if (r.ok) {
          window.location.assign(next && next.startsWith('/') ? next : '/');
          return;
        }
        // A refused account (wrong domain, offboarded) shouldn't nag — the button flow stays available.
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        if (data.error && data.error !== 'not_allowed' && data.error !== 'offboarded') {
          toast.error('Google sign-in failed', { description: data.error });
        }
      } catch {
        /* network hiccup — the user can use the button flow */
      }
    }

    function init() {
      const id = window.google?.accounts?.id;
      if (!id) return false;
      id.initialize({
        client_id: clientId,
        callback: onCredential,
        auto_select: true, // returning, already-consented user signs in with no click
        cancel_on_tap_outside: true,
        use_fedcm_for_prompt: true, // required path now that third-party cookies are going away
        context: 'signin',
      });
      id.prompt();
      return true;
    }

    // Load the GIS client once, then initialize. If it's already present, init immediately.
    if (init()) return;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', init, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', init, { once: true });
    document.head.appendChild(s);
  }, [clientId, next]);

  return null;
}

export default GoogleOneTap;
