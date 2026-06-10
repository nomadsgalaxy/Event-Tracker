'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseIcs, icsLocationToVenue, type IcsEvent } from '@/lib/integrations/ics';
import { importIcsEventsAction } from '@/app/event/actions';

// import-ics-button.tsx — "Import .ics": pick an iCalendar file, preview the events it contains
// (parsed in-browser with the same isomorphic parser the server re-runs), tick the ones to import,
// and create them as DRAFT events through the gated import action. One imported event navigates
// straight into its editor; several refresh the dashboard.

const MAX_BYTES = 1_000_000;

export function ImportIcsButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileText, setFileText] = useState('');
  const [events, setEvents] = useState<IcsEvent[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error('That .ics file is too large (max 1 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error('Could not read that file.');
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const found = parseIcs(text).filter((ev) => ev.startDate);
      if (found.length === 0) {
        toast.error('No calendar events with dates were found in that file.');
        return;
      }
      setFileText(text);
      setEvents(found);
      setPicked(new Set(found.map((_, i) => i)));
      setOpen(true);
    };
    reader.readAsText(file);
  }

  function doImport() {
    const indexes = [...picked];
    if (indexes.length === 0) {
      toast.warning('Pick at least one event to import.');
      return;
    }
    startTransition(async () => {
      const res = await importIcsEventsAction(fileText, indexes);
      if (!res.ok) {
        toast.error(res.error || 'Import failed.');
        return;
      }
      const created = res.created ?? [];
      toast.success(created.length === 1 ? `Imported "${created[0].name}" as a draft.` : `Imported ${created.length} draft events.`);
      setOpen(false);
      if (created.length === 1) router.push(`/event/${created[0].id}/edit`);
      else router.refresh();
    });
  }

  const fmtRange = (ev: IcsEvent) => (ev.endDate && ev.endDate !== ev.startDate ? `${ev.startDate} – ${ev.endDate}` : ev.startDate);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = ''; // allow re-picking the same file
        }}
      />
      <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
        <CalendarPlus size={14} aria-hidden />
        <span>Import .ics</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import calendar events</DialogTitle>
            <DialogDescription>
              {events.length === 1 ? 'One event found.' : `${events.length} events found.`} Each import
              creates a <strong className="text-foreground">draft</strong> with the show dates, venue and
              website — door times and logistics are set in the editor.
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {events.map((ev, i) => {
              const guess = icsLocationToVenue(ev.location);
              const where = [guess.name, guess.city].filter(Boolean).join(' · ');
              return (
                <label
                  key={`${ev.uid || ev.summary}-${i}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 hover:bg-accent/50"
                >
                  <Checkbox
                    checked={picked.has(i)}
                    onCheckedChange={(v) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (v === true) n.add(i);
                        else n.delete(i);
                        return n;
                      })
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{ev.summary || '(untitled)'}</span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {fmtRange(ev)}
                      {ev.startTime ? ` · ${ev.startTime}` : ''}
                    </span>
                    {where ? <span className="block truncate text-xs text-muted-foreground">{where}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={doImport} disabled={pending || picked.size === 0}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <CalendarPlus size={14} aria-hidden />}
              Import {picked.size === 1 ? 'event' : `${picked.size} events`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ImportIcsButton;
