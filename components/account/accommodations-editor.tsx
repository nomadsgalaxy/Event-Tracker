'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ACCOMMODATION_DIETARY,
  ACCOMMODATION_ACCESSIBILITY,
  ACCOMMODATION_SEVERITY,
  toAccommodationsDraft,
  fromAccommodationsDraft,
  type AccommodationsDraft,
} from '@/lib/accommodations';
import type { AccommodationsProfile } from '@/lib/types';

// AccommodationsEditor — sensitive-PII profile editor (dietary / allergies / accessibility / medical
// context / emergency contacts / notes). Faithful port of the Python AccommodationsEditor in EMBEDDED
// mode (index.html ~L10191): the parent (the Account Profile tab) owns the Save/commit; this surfaces
// the live draft up via onChange on every edit. No internal Save footer in embedded mode.
//
// Self-write on the Account screen: the signed-in user edits their OWN profile. The data is stored on
// the directory `users` record + only crosses the wire to a viewer who passes accommodations.view
// (manager+/self) — the server gate, not this editor, enforces that.

// A pill toggle (the source's PillToggle variant 'pill'): a small bordered chip, orange when on.
function Pill({
  on,
  label,
  onClick,
  disabled,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-60',
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}

export interface AccommodationsEditorProps {
  /** The stored profile (or null). */
  value: AccommodationsProfile | null | undefined;
  /** Called with the live draft (serialized to the stored shape) on every edit — the parent captures
   *  it for its own Save flow (embedded mode). */
  onChange: (next: AccommodationsProfile) => void;
  /** Read-only (no edits) — defaults false. */
  readOnly?: boolean;
}

export function AccommodationsEditor({ value, onChange, readOnly = false }: AccommodationsEditorProps) {
  const [draft, setDraft] = React.useState<AccommodationsDraft>(() => toAccommodationsDraft(value));

  // Re-sync when the value prop changes externally (e.g. a fresh load). Keyed on a stable signature
  // so we don't loop on our own onChange-driven re-renders.
  const valueSig = React.useMemo(() => JSON.stringify(value || {}), [value]);
  React.useEffect(() => {
    setDraft(toAccommodationsDraft(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSig]);

  // Surface the live draft to the parent on every edit (the embedded onChange contract).
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const draftSig = React.useMemo(() => JSON.stringify(draft), [draft]);
  React.useEffect(() => {
    onChangeRef.current(fromAccommodationsDraft(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSig]);

  const toggle = (key: 'dietary' | 'accessibility', val: string) =>
    setDraft((d) => {
      const set = new Set(d[key] || []);
      if (set.has(val)) set.delete(val);
      else set.add(val);
      return { ...d, [key]: Array.from(set) };
    });
  const setMedical = (val: string) => setDraft((d) => ({ ...d, medical: val }));
  const setNotes = (val: string) => setDraft((d) => ({ ...d, notes: val }));
  const setAllergies = (patch: Partial<{ text: string; severity: string }>) =>
    setDraft((d) => ({ ...d, allergies: { ...d.allergies, ...patch } }));
  const addContact = () =>
    setDraft((d) => ({
      ...d,
      emergencyContacts: [
        ...(d.emergencyContacts || []),
        { name: '', relationship: '', phone: '', email: '' },
      ],
    }));
  const updateContact = (idx: number, key: 'name' | 'relationship' | 'phone' | 'email', val: string) =>
    setDraft((d) => ({
      ...d,
      emergencyContacts: d.emergencyContacts.map((c, i) => (i === idx ? { ...c, [key]: val } : c)),
    }));
  const removeContact = (idx: number) =>
    setDraft((d) => ({
      ...d,
      emergencyContacts: d.emergencyContacts.filter((_, i) => i !== idx),
    }));

  return (
    <div className="flex flex-col gap-4">
      {/* Dietary */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Dietary</Label>
        <div className="flex flex-wrap gap-1.5">
          {ACCOMMODATION_DIETARY.map((opt) => (
            <Pill
              key={opt}
              on={draft.dietary.indexOf(opt) >= 0}
              label={opt}
              disabled={readOnly}
              onClick={() => toggle('dietary', opt)}
            />
          ))}
        </div>
      </div>

      {/* Allergies */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Allergies</Label>
        <div className="grid grid-cols-[2fr_1fr] gap-2">
          <Input
            placeholder="e.g. peanuts, tree nuts, latex"
            value={draft.allergies.text}
            disabled={readOnly}
            onChange={(e) => setAllergies({ text: e.target.value })}
          />
          <Select
            value={draft.allergies.severity}
            onValueChange={(v) => setAllergies({ severity: v })}
            disabled={readOnly}
          >
            <SelectTrigger aria-label="Allergy severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOMMODATION_SEVERITY.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {draft.allergies.severity === 'epipen' && (
          <p className="text-xs" style={{ color: 'var(--warning)' }}>
            EpiPen carrier — leads should know location of medication on-site.
          </p>
        )}
      </div>

      {/* Accessibility */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Accessibility</Label>
        <div className="flex flex-wrap gap-1.5">
          {ACCOMMODATION_ACCESSIBILITY.map((opt) => (
            <Pill
              key={opt}
              on={draft.accessibility.indexOf(opt) >= 0}
              label={opt}
              disabled={readOnly}
              onClick={() => toggle('accessibility', opt)}
            />
          ))}
        </div>
      </div>

      {/* Medical context */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Medical context</Label>
        <Textarea
          rows={2}
          placeholder="Medications, conditions worth knowing for emergencies. Optional."
          value={draft.medical}
          disabled={readOnly}
          onChange={(e) => setMedical(e.target.value)}
        />
      </div>

      {/* Emergency contacts */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
        <div className="flex items-center justify-between">
          <Eyebrow asChild>
            <span>Emergency contacts</span>
          </Eyebrow>
          {!readOnly && (
            <Button type="button" variant="outline" size="sm" onClick={addContact}>
              <Plus size={14} aria-hidden />
              Add contact
            </Button>
          )}
        </div>
        {draft.emergencyContacts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No emergency contacts yet.
            {!readOnly ? ' Add one or more people leads can reach in an on-site emergency.' : ''}
          </p>
        ) : (
          <>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--warning)' }}>
              Shared with event leads in case of an on-site emergency. Stored with your team&rsquo;s
              directory.
            </p>
            <div className="flex flex-col gap-2">
              {draft.emergencyContacts.map((c, idx) => (
                <div
                  key={idx}
                  className="relative rounded-md border border-border bg-card p-2 pr-7"
                >
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => removeContact(idx)}
                      aria-label={`Remove contact ${idx + 1}`}
                      className="absolute top-1 right-1 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      placeholder="Name"
                      value={c.name ?? ''}
                      disabled={readOnly}
                      onChange={(e) => updateContact(idx, 'name', e.target.value)}
                    />
                    <Input
                      placeholder="Relationship (e.g. spouse, parent)"
                      value={c.relationship ?? ''}
                      disabled={readOnly}
                      onChange={(e) => updateContact(idx, 'relationship', e.target.value)}
                    />
                    <Input
                      type="tel"
                      placeholder="Phone"
                      value={c.phone ?? ''}
                      disabled={readOnly}
                      onChange={(e) => updateContact(idx, 'phone', e.target.value)}
                    />
                    <Input
                      type="email"
                      placeholder="Email (optional)"
                      value={c.email ?? ''}
                      disabled={readOnly}
                      onChange={(e) => updateContact(idx, 'email', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Other notes */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Other notes</Label>
        <Textarea
          rows={2}
          placeholder="Time-zone sensitivity, sleep schedule, anything else."
          value={draft.notes}
          disabled={readOnly}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
    </div>
  );
}

export default AccommodationsEditor;
