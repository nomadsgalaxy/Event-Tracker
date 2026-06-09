import './globals.css';
import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/util/utils';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TopBar } from '@/components/shell/top-bar';
import { MobileNavBar } from '@/components/shell/mobile-nav-bar';
import { ThemeStyle } from '@/components/shell/theme-style';
import { AppFooter } from '@/components/shell/app-footer';
import { VersionWatcher } from '@/components/shell/version-watcher';
import { DemoBanner } from '@/components/shell/demo-banner';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

const DESCRIPTION = 'Fully Self Hosted showcase inventory and event manager';

export const metadata: Metadata = {
  title: 'Event Tracker',
  description: DESCRIPTION,
  openGraph: { title: 'Event Tracker', description: DESCRIPTION, siteName: 'Event Tracker', type: 'website' },
  twitter: { card: 'summary', title: 'Event Tracker', description: DESCRIPTION },
};

// app/layout.tsx — the ONE persistent app shell (DESIGN_ALIGNMENT §1.1). A flex column:
//   <TopBar>          sticky h-14 dark bar (wordmark · workflow nav · right cluster)
//   <main> the stage  flex-1, min-h-0 — each SCREEN owns its own width, padding, and scroll
//   <MobileNavBar>    fixed bottom tab bar (mobile only)
//   <Toaster>         sonner, mounted once
//
// FULL-BLEED: there is NO global centered content column here — the old `<main className="mx-auto
// max-w-6xl …">` cap is removed. Sidebar screens (Archetype A) run edge-to-edge with their own rail;
// stack screens (Archetype B) apply their own `px-6 py-6`.
//
// SCROLL FLOOR: on mobile the MobileNavBar is `fixed` and overlays the bottom of the viewport, so
// <body> carries bottom padding equal to the bar height (+ the iOS safe-area inset). That makes the
// whole column — main AND the AppFooter — sit ABOVE the bar, so the last row is never hidden behind
// it and the footer (a normal, non-sticky block) is the true bottom of the scroll. md+ drops the
// reserve since the bar is desktop-hidden.
//
// The shell is a Server Component; the interactive bits live in small client islands inside TopBar /
// MobileNavBar (nav active-state, ⋯ overflow, user menu, install, bell). Auth is read inside those
// components — the layout wraps /login too, so it must never redirect.

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn('dark font-sans', geist.variable)} suppressHydrationWarning>
      <head>
        {/* Applies the signed-in user's saved accent theme app-wide (no FOUC, no client-only read). */}
        <ThemeStyle />
      </head>
      <body className="flex min-h-dvh flex-col bg-background text-foreground antialiased pb-[calc(4rem_+_env(safe-area-inset-bottom))] md:pb-0">
        <TooltipProvider delayDuration={200}>
          <DemoBanner />
          <TopBar />
          <main id="main" className="flex min-h-0 flex-1 flex-col">
            {children}
          </main>
          <AppFooter />
          <MobileNavBar />
        </TooltipProvider>
        <Toaster richColors position="bottom-right" />
        <VersionWatcher />
      </body>
    </html>
  );
}
