'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';

// csv-import-modal.tsx — the generic dry-run CSV importer (CsvImportModal). A faithful port of
// index.html CsvImportModal (~L19719): reads a file, parses it, maps columns by the EXACT Export
// header names, validates each row, and shows a DRY-RUN preview (new vs update-by-id counts + per-row
// errors) before committing. On confirm it calls the gated onCommit(validRows). Round-trips with the
// catalog Export CSV. Generic via `expectedHeaders` + `mapRow` + `existingIds` props.

export interface MapRowResult<T> {
  mapped?: T;
  error?: string;
  isUpdate?: boolean;
}

// Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas/quotes/newlines, CRLF, and a
// leading BOM (the catalog Export writes one). Returns an array of header-keyed records.
function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush the last field/row (no trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip a wholly-empty trailing line.
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, c) => {
      rec[h] = (cells[c] ?? '').trim();
    });
    out.push(rec);
  }
  return out;
}

export function CsvImportModal<T>({
  title,
  expectedHeaders,
  mapRow,
  existingIds,
  open,
  onOpenChange,
  onCommit,
}: {
  title: string;
  expectedHeaders: string[];
  /** Map + validate one parsed record into the commit shape. */
  mapRow: (record: Record<string, string>, knownIds: Set<string>) => MapRowResult<T>;
  existingIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Persist the validated rows (the gated Server Action). */
  onCommit: (rows: T[]) => Promise<{ ok?: boolean; error?: string; created?: number; updated?: number }>;
}) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<{ records: Record<string, string>[]; headers: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setParsed(null);
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const records = parseCsv(String(reader.result || ''));
        if (records.length === 0) {
          setError('No data rows found in the file.');
          return;
        }
        const headers = Object.keys(records[0]);
        setParsed({ records, headers });
      } catch (err) {
        setError('Could not parse file: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsText(f);
  }

  const analysis = useMemo(() => {
    if (!parsed) return null;
    const idSet = new Set(existingIds || []);
    const valid: T[] = [];
    const errors: { line: number; msg: string }[] = [];
    let createCount = 0;
    let updateCount = 0;
    parsed.records.forEach((rec, i) => {
      const res = mapRow(rec, idSet);
      if (res.error) {
        errors.push({ line: i + 2, msg: res.error });
        return;
      }
      if (res.isUpdate) updateCount++;
      else createCount++;
      if (res.mapped !== undefined) valid.push(res.mapped);
    });
    const missingHeaders = (expectedHeaders || []).filter((h) => !parsed.headers.includes(h));
    return { valid, errors, createCount, updateCount, missingHeaders, total: parsed.records.length };
  }, [parsed, existingIds, expectedHeaders, mapRow]);

  function commit() {
    if (!analysis || analysis.valid.length === 0) return;
    startTransition(async () => {
      const res = await onCommit(analysis.valid);
      if (res.error || !res.ok) {
        toast.error(res.error || 'Import failed.');
        return;
      }
      const created = res.created ?? 0;
      const updated = res.updated ?? 0;
      toast.success(`Imported ${created + updated} row(s): ${created} new, ${updated} updated.`);
      onOpenChange(false);
      setParsed(null);
      setFileName('');
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Import from a CSV matching the Export column headers. A row with a known{' '}
            <span className="font-mono">id</span> updates that record; a blank/new id creates one. This is
            a dry run — nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
          aria-label="Choose a CSV file"
        />
        {fileName ? (
          <p className="text-xs text-muted-foreground">
            Selected: <span className="font-mono">{fileName}</span>
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {analysis ? (
          <div className="grid gap-3">
            {analysis.missingHeaders.length > 0 ? (
              <div
                className="rounded-md border px-2.5 py-2 text-xs"
                style={{ color: 'var(--warning)', borderColor: 'var(--warning)', background: 'rgba(245,158,11,.08)' }}
              >
                Missing expected column{analysis.missingHeaders.length === 1 ? '' : 's'}:{' '}
                <span className="font-mono">{analysis.missingHeaders.join(', ')}</span>. Those fields use defaults.
              </div>
            ) : null}
            <div className="grid grid-cols-3 gap-2">
              <Stat value={analysis.createCount} label="New" tone="success" />
              <Stat value={analysis.updateCount} label="Update by id" tone="accent" />
              <Stat value={analysis.errors.length} label="Errors (skipped)" tone={analysis.errors.length ? 'error' : 'muted'} />
            </div>
            {analysis.errors.length > 0 ? (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {analysis.errors.map((er, i) => (
                  <div key={i} className={`px-2.5 py-1.5 text-xs text-muted-foreground ${i ? 'border-t border-border/60' : ''}`}>
                    <span className="font-mono text-destructive">Row {er.line}</span>: {er.msg}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={!analysis || analysis.valid.length === 0 || pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
            Import {analysis ? analysis.valid.length : 0} row{analysis && analysis.valid.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: 'success' | 'accent' | 'error' | 'muted' }) {
  const color =
    tone === 'success' ? 'var(--success)' : tone === 'accent' ? 'var(--primary)' : tone === 'error' ? 'var(--destructive)' : 'var(--muted-foreground)';
  return (
    <div className="rounded-md border border-border bg-card p-2 text-center">
      <div className="font-mono text-lg font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <Eyebrow className="text-[9px]">{label}</Eyebrow>
    </div>
  );
}

export default CsvImportModal;
