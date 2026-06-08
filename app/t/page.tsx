'use client';

import { useEffect, useState } from 'react';
import { Nfc } from 'lucide-react';
import { decodeTagViewerFragment } from '@/lib/integrations/tag-url';
import { ParsedTagView, tagHeading } from '@/components/inventory/parsed-tag-view';
import type { ParsedTag } from '@/lib/integrations/nfc-decoders';

// app/t/page.tsx — the PUBLIC tag viewer. A tag written by Event Tracker carries a URI record pointing
// here with the material data in the URL fragment; tapping it on ANY phone (iOS/Android) opens this
// page and renders the data. No auth, no DB: the page reads ONLY the fragment (client-side), so it
// shows exactly what the tag carries and exposes nothing about the inventory. See lib/integrations/
// tag-url + the middleware PUBLIC_PATHS exemption for '/t'.

export default function TagViewerPage() {
  const [parsed, setParsed] = useState<ParsedTag | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setParsed(decodeTagViewerFragment(window.location.hash));
    setReady(true);
    // Re-read if the fragment changes (e.g. a second tap on the same open tab).
    const onHash = () => setParsed(decodeTagViewerFragment(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-5 py-8">
      <div className="flex items-center gap-2">
        <Nfc size={18} className="text-primary" aria-hidden />
        <h1 className="text-base font-semibold text-foreground">
          {parsed ? tagHeading(parsed) : 'NFC tag'}
        </h1>
      </div>
      {!ready ? null : parsed ? (
        <>
          <ParsedTagView parsed={parsed} category={parsed.material_class === 'SLA' ? 'resin' : 'filament'} />
          <p className="text-[11px] text-muted-foreground">
            Read from the tag. This page shows only what the tag carries.
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          No tag data in this link. Tap an Event Tracker NFC tag, or open the URL written on one.
        </div>
      )}
    </div>
  );
}
