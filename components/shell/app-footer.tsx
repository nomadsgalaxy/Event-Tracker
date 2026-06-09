// app-footer.tsx — the persistent attribution footer. "EventTracker by NomadsGalaxy", with
// EventTracker -> eventtracker.dev and NomadsGalaxy -> nomadsgalaxy.com. Server Component (no
// interactivity). It's a NORMAL block at the END of the shell's flex column, NOT sticky: a sticky
// footer floats over scrolled content and hides the last rows, so the page never feels like it
// reaches the bottom. As a plain block the viewport content stops at the footer's top and you can
// scroll all the way down. On mobile the fixed MobileNavBar still overlays the viewport bottom, so
// the shell reserves that height with bottom padding on <body> (app/layout.tsx) and the footer lands
// just above the bar.
export function AppFooter() {
  return (
    <footer className="border-t border-border bg-background px-4 py-2.5 text-center text-xs text-muted-foreground">
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
