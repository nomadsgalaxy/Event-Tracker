'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { matchesQuery } from '@/app/_dashboard/dash-utils';
import type { DashEvent } from '@/lib/types/types-dashboard';

// Find — a shadcn Command palette over the server-fetched event list. Pure client-side
// filtering of an already-loaded list (a keystroke never costs a round-trip), ported from the
// current app's "Find an event" modal (index.html ~L15465). Haystack = name/city/lead/venue/tags
// via the shared dash-utils.matchesQuery, so the Find search and the inline tab list agree.
//
// cmdk's own fuzzy filter is disabled (shouldFilter={false}); we drive the visible set with the
// app's matchesQuery so the search semantics are identical to the inline filter and the legacy app.
// Opens on click OR ⌘K / Ctrl-K. Selecting an event navigates to its detail route.

export function FindCommand({ events }: { events: DashEvent[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  // ⌘K / Ctrl-K toggles the palette — the conventional quick-switcher shortcut.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const matches = React.useMemo(() => {
    const list = events.filter((e) => matchesQuery(e, query));
    // Cap the rendered set like the legacy modal (slice(0, 60)) so a huge DB stays responsive.
    return list.slice(0, 60);
  }, [events, query]);

  function go(id: string) {
    setOpen(false);
    setQuery('');
    router.push(`/event/${encodeURIComponent(id)}`);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5"
        aria-label="Find an event"
      >
        <Search size={14} aria-hidden />
        <span>Find</span>
        <kbd className="ml-1 hidden rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-1/3 max-w-lg translate-y-0 overflow-hidden p-0" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Find an event</DialogTitle>
            <DialogDescription>
              Search every event by name, city, lead, venue, or tag.
            </DialogDescription>
          </DialogHeader>
          {/* Our own Command wrapper so the cmdk context exists; shouldFilter is OFF — the
              visible set is driven entirely by the app's matchesQuery (parity with the legacy
              modal + the inline tab filter). */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search events by name, city, lead, venue, or tag…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {events.length === 0
                  ? 'No events yet.'
                  : `No events match “${query.trim()}”.`}
              </CommandEmpty>
              {matches.length > 0 ? (
                <CommandGroup
                  heading={`${matches.length} ${matches.length === 1 ? 'event' : 'events'}`}
                >
                  {matches.map((e) => (
                    <CommandItem
                      key={e.id}
                      // value is only an identity here (cmdk filtering disabled); the visible
                      // set is driven by matchesQuery, not cmdk's fuzzy match.
                      value={`${e.id} ${e.name} ${e.city}`}
                      onSelect={() => go(e.id)}
                      className="gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {e.name || 'Untitled event'}
                        {e.city ? (
                          <span className="text-muted-foreground"> · {e.city}</span>
                        ) : null}
                        {!e.startDate ? (
                          <span className="text-muted-foreground"> · no date</span>
                        ) : null}
                      </span>
                      <StatusBadge state={e.state} className="shrink-0" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
