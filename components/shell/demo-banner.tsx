import { Download, FlaskConical } from 'lucide-react';
import { IS_DEMO } from '@/lib/demo-flag';

// components/shell/demo-banner.tsx — a thin top strip shown ONLY in the demo build. It tells visitors
// this is a sandbox: their edits are private + reset when they clear their browser, and the admin/
// config settings are shown read-only so they can see what's configurable on their own deployment.
// Renders nothing outside demo mode (so prod/main is untouched). Server component — no interactivity.
export function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div
      role="note"
      className="flex items-center justify-center gap-2 border-b border-primary/30 bg-primary/10 px-4 py-1.5 text-center text-xs text-foreground"
    >
      <FlaskConical className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span>
        <strong className="font-semibold">Live demo.</strong> Your changes are private to this browser
        and reset when you clear it. Admin settings are read-only here — set them on your own deployment.
      </span>
      {/* Take your work with you: downloads the sandbox as an importable _eitBackup JSON. */}
      <a
        href="/api/demo/export"
        download
        className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/15"
      >
        <Download className="size-3.5" aria-hidden />
        Export my data
      </a>
    </div>
  );
}

export default DemoBanner;
