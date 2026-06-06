'use client';

import { createContext, useContext } from 'react';
import type { DashTag } from '@/lib/types/types-dashboard';

// app/event/[id]/edit/editor-context.tsx — the NON-form data the editor's panels need (the
// directory, the case catalog + per-case availability, the visible tag library, and the keyed-
// integration availability flags). This is reference data, NOT form state — it never changes as the
// user types, so it rides a React context rather than react-hook-form (keeping the form value lean +
// avoiding needless re-renders). Computed server-side on the edit page and handed in once.

export interface DirectoryUser {
  email: string;
  name: string;
  picture: string;
}

export interface EditorCase {
  id: string;
  slug: string; // shown when distinct from id (else '')
  label: string;
  /** True iff a DIFFERENT in-flight event currently holds this case (the availability lock). */
  unavailable: boolean;
  /** The "Packing for X" / "At X" status phrase when unavailable (else ''). */
  statusLabel: string;
  /** True iff retired (excluded from the grid unless already assigned to THIS event). */
  retired: boolean;
}

export interface EditorContextValue {
  /** The directory users (for the "add staffer" picker + avatar/name resolution). */
  directory: DirectoryUser[];
  /** The case catalog with per-case availability (for the assigned-cases grid + pallet labels). */
  cases: EditorCase[];
  /** Case id → display label, for pallet chips + the loose list. */
  caseLabelById: Record<string, string>;
  /** The visible tag library (for the tags field picker + applied chips). */
  tags: DashTag[];
  /** Google Places autocomplete wired? When false the address fields degrade + flag the key. */
  placesAvailable: boolean;
  /** Flight lookup wired? When false the leg editors hide the Look-up button + flag the key. */
  flightLookupAvailable: boolean;
  /** The viewer's IANA timezone (for the "Use mine" button). Resolved client-side, mount-gated. */
  viewerTimezone: string;
  /** Whether the viewer may add/remove tags (tags.apply). */
  canApplyTags: boolean;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({
  value,
  children,
}: {
  value: EditorContextValue;
  children: React.ReactNode;
}) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditorContext must be used within EditorProvider');
  return ctx;
}
