// app-footer.tsx — the persistent attribution footer, STICKY to the bottom of the viewport.
// "EventTracker by NomadsGalaxy", with EventTracker → eventtracker.dev and NomadsGalaxy →
// nomadsgalaxy.com. Server Component (no interactivity). `sticky bottom-0` keeps it pinned to the
// viewport bottom even while the page scrolls (it still reserves its own space, so nothing is hidden
// behind it); a solid bg lets content scroll under it. On mobile it sits ABOVE the fixed MobileNavBar
// (bottom-16 clears the 64px bar); md+ drops the reserve since the mobile bar is desktop-hidden.
export function AppFooter() {
  return (
    <footer className="sticky bottom-16 z-30 border-t border-border bg-background px-4 py-2.5 text-center text-xs text-muted-foreground md:bottom-0">
      <a
        href="https://eventtracker.dev"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground/80 underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        EventTracker
      </a>{' '}
      by{' '}
      <a
        href="https://nomadsgalaxy.com"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground/80 underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        NomadsGalaxy
      </a>
    </footer>
  );
}

export default AppFooter;
