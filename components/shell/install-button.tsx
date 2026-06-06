'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

// install-button.tsx — the PWA "INSTALL" affordance in the TopBar right cluster.
//
// This wave ships the SLOT, not the install flow: the button captures the browser's
// `beforeinstallprompt` event (when one is offered) and, on click, calls prompt(); when no prompt is
// available it is hidden entirely so we never show a dead control. The full installability criteria
// (manifest + service worker) are a later PWA wave — this keeps the placement + a11y final and
// becomes live the moment the manifest lands, with no shell change.

// Minimal shape for the non-standard event so we avoid `any` while keeping it self-contained.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallButton() {
  const [deferred, setDeferred] = React.useState<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // stash it; we trigger the prompt from our own button
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // No installable prompt available (already installed, unsupported, or no manifest yet) → render
  // nothing rather than a no-op button.
  if (!deferred) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden sm:inline-flex"
      onClick={async () => {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === 'accepted') setDeferred(null);
      }}
    >
      <Download size={16} aria-hidden />
      Install
    </Button>
  );
}

export default InstallButton;
