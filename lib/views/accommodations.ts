// lib/views/accommodations.ts — the client-safe accommodations constants + a normalizer.
//
// Faithful port of the Python ACCOMMODATION_* option lists + normEmergencyContacts
// (index.html ~L10153 / ~L10178). PURE + isomorphic (no `server-only`, no I/O): the
// AccommodationsEditor (a Client Component) and the self-account Server Action both
// consume these, so the option sets + the emergency-contact migration can never drift.

import type { AccommodationsProfile, EmergencyContact } from '@/lib/types/types';

export const ACCOMMODATION_DIETARY: readonly string[] = [
  'vegetarian',
  'vegan',
  'pescatarian',
  'halal',
  'kosher',
  'gluten-free',
  'lactose-free',
  'nut-free',
  'low-sodium',
  'diabetic',
];

export const ACCOMMODATION_ACCESSIBILITY: readonly string[] = [
  'wheelchair user',
  'ground-floor preference',
  'low-mobility',
  'hearing assistance',
  'vision assistance',
  'asl interpreter',
  'service animal',
];

export const ACCOMMODATION_SEVERITY: readonly ('mild' | 'severe' | 'epipen')[] = [
  'mild',
  'severe',
  'epipen',
];

const BLANK_CONTACT: EmergencyContact = { name: '', relationship: '', phone: '', email: '' };

/**
 * Normalize a profile's emergency contacts to an ARRAY of {name,relationship,phone,email}.
 * Migrates the legacy single `emergencyContact` object into a one-element array; an empty/blank
 * legacy contact yields []. Faithful to the Python normEmergencyContacts.
 */
export function normEmergencyContacts(v: AccommodationsProfile | null | undefined): EmergencyContact[] {
  if (v && Array.isArray(v.emergencyContacts)) {
    return v.emergencyContacts.map((c) => ({ ...BLANK_CONTACT, ...(c || {}) }));
  }
  const single = (v && v.emergencyContact) || null;
  if (single && (single.name || single.phone || single.email || single.relationship)) {
    return [{ ...BLANK_CONTACT, ...single }];
  }
  return [];
}

// The editor's working draft shape — every field present + defaulted (so the controlled inputs
// never flip between controlled/uncontrolled). Mirrors the Python AccommodationsEditor draft.
export interface AccommodationsDraft {
  dietary: string[];
  allergies: { text: string; severity: string };
  accessibility: string[];
  medical: string;
  emergencyContacts: EmergencyContact[];
  notes: string;
  updatedAt: number;
}

/** Build a fully-defaulted draft from a stored profile (or null). */
export function toAccommodationsDraft(v: AccommodationsProfile | null | undefined): AccommodationsDraft {
  const av = v || {};
  return {
    dietary: Array.isArray(av.dietary) ? av.dietary.slice() : [],
    allergies: {
      text: (av.allergies && av.allergies.text) || '',
      severity: (av.allergies && av.allergies.severity) || 'mild',
    },
    accessibility: Array.isArray(av.accessibility) ? av.accessibility.slice() : [],
    medical: av.medical || '',
    emergencyContacts: normEmergencyContacts(av),
    notes: av.notes || '',
    updatedAt: typeof av.updatedAt === 'number' ? av.updatedAt : 0,
  };
}

/**
 * Serialize a draft back to the stored AccommodationsProfile shape, mirroring the first contact onto
 * the legacy `emergencyContact` (withECMirror) so older readers + the external API/MCP still resolve
 * one. Strips fully-blank contacts. Does NOT stamp updatedAt — the caller decides when to stamp.
 */
export function fromAccommodationsDraft(d: AccommodationsDraft): AccommodationsProfile {
  const contacts = (d.emergencyContacts || []).filter(
    (c) => c && (c.name || c.relationship || c.phone || c.email)
  );
  return {
    dietary: d.dietary || [],
    allergies: { text: d.allergies.text || '', severity: d.allergies.severity || 'mild' },
    accessibility: d.accessibility || [],
    medical: d.medical || '',
    emergencyContacts: contacts,
    emergencyContact: contacts[0] || { name: '', relationship: '', phone: '', email: '' },
    notes: d.notes || '',
    updatedAt: d.updatedAt || 0,
  };
}
