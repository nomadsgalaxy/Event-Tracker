// lib/power/connectors.tsx — the power-connector catalog: stylized SVG faces + metadata for the
// equipment INLET picker (IEC 60320 appliance inlets + the fixed US cord) and the event RECEPTACLE
// grid (NEMA / Schuko / BS / AS, grouped by region). Pure + client-safe (the pickers render these
// in the item modal + event editor; the detail view uses the metadata for the compatibility check).
//
// NAMING: equipment-side cells are the INLET the device presents, subtitled with the CORD it takes
// ("C14 — takes a C13 cord") because crews name the cable, not the inlet. Receptacles use the NEMA
// "R" naming. Voltage families: '120' (NA branch circuits), '230' (EU/UK/AU — the 240-class), and
// devices can be '120' | '240' | 'auto' (universal PSU).

import type { ReactNode } from 'react';

export type Region = 'NA' | 'EU' | 'UK' | 'AU';
export type VoltFamily = '120' | '230';
export type DeviceVolts = '120' | '240' | 'auto';

export interface InletDef {
  id: string; // stored in item.plugType
  label: string; // the official inlet name
  takes: string; // the cord/coupler it mates with (what crews call it)
  svg: ReactNode;
}

export interface ReceptacleDef {
  id: string; // stored in event.powerReceptacles[]
  label: string;
  region: Region;
  volts: VoltFamily;
  amps: number;
  svg: ReactNode;
}

// ── SVG faces (44×44 viewBox, stroke = currentColor, minimal geometric front views) ─────────────
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' as const };
const F = { fill: 'currentColor', stroke: 'none' };

// IEC C14 / C20 share the trapezoid shell; pins differ.
const c14Shell = <path {...S} d="M8 14 L12 8 H32 L36 14 V36 H8 Z" />;
const svgC14 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    {c14Shell}
    <rect {...F} x="14" y="18" width="3" height="10" />
    <rect {...F} x="20.5" y="14" width="3" height="10" />
    <rect {...F} x="27" y="18" width="3" height="10" />
  </svg>
);
const svgC16 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    {c14Shell}
    <rect {...F} x="14" y="17" width="3" height="11" />
    <rect {...F} x="20.5" y="13" width="3" height="11" />
    <rect {...F} x="27" y="17" width="3" height="11" />
    <path {...S} strokeWidth={1.5} d="M12 32 H32" />
  </svg>
);
const svgC20 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="12" width="32" height="22" rx="3" />
    <rect {...F} x="11" y="19" width="8" height="3" />
    <rect {...F} x="25" y="19" width="8" height="3" />
    <rect {...F} x="18" y="26" width="8" height="3" />
  </svg>
);
const svgC6 = (
  // "Mickey Mouse" cloverleaf
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="14" cy="16" r="6.5" />
    <circle {...S} cx="30" cy="16" r="6.5" />
    <circle {...S} cx="22" cy="28" r="6.5" />
    <circle {...F} cx="14" cy="16" r="1.8" />
    <circle {...F} cx="30" cy="16" r="1.8" />
    <circle {...F} cx="22" cy="28" r="1.8" />
  </svg>
);
const svgC8 = (
  // figure-8
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M14 14 a8 8 0 0 1 0 16 h16 a8 8 0 0 1 0-16 Z" transform="translate(0,1)" />
    <circle {...F} cx="14" cy="23" r="1.8" />
    <circle {...F} cx="30" cy="23" r="1.8" />
  </svg>
);
const svgNema515P = (
  // US plug face: two flat blades + round ground
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <rect {...F} x="13" y="13" width="3" height="11" />
    <rect {...F} x="28" y="13" width="3" height="11" />
    <circle {...F} cx="22" cy="30" r="2.6" />
  </svg>
);
const svgHardwire = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 30 C14 30 14 14 22 14 C30 14 30 30 36 30" />
    <circle {...F} cx="8" cy="30" r="2.4" />
    <circle {...F} cx="36" cy="30" r="2.4" />
  </svg>
);

// Receptacle faces.
const svgNema515R = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <rect {...F} x="13.5" y="12" width="3.5" height="11" />
    <rect {...F} x="27" y="13.5" width="3.5" height="9" />
    <path {...F} d="M19 28 h6 v4 a3 3 0 0 1 -6 0 Z" />
  </svg>
);
const svgNema520R = (
  // 5-20R: the neutral is a T-slot
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <path {...F} d="M13 12 h3.5 v11 H13 Z M11.5 12 h8 v3.5 h-8 Z" />
    <rect {...F} x="27" y="13.5" width="3.5" height="9" />
    <path {...F} d="M19 28 h6 v4 a3 3 0 0 1 -6 0 Z" />
  </svg>
);
const svgL530R = (
  // twist-lock: arc slots
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <path {...S} strokeWidth={3} d="M22 8 a14 14 0 0 1 12 7" />
    <path {...S} strokeWidth={3} d="M34 28 a14 14 0 0 1 -12 8" />
    <path {...S} strokeWidth={3} d="M10 28 a14 14 0 0 1 0 -13" />
  </svg>
);
const svgNema615R = (
  // 6-15R: both slots horizontal
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <rect {...F} x="9" y="16" width="11" height="3.5" />
    <rect {...F} x="24" y="16" width="11" height="3.5" />
    <path {...F} d="M19 26 h6 v4 a3 3 0 0 1 -6 0 Z" />
  </svg>
);
const svgNema620R = (
  // 6-20R: one horizontal, one T
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <path {...F} d="M9 16 h11 v3.5 H9 Z M13 12.5 h3.5 v11 H13 Z" />
    <rect {...F} x="24" y="16" width="11" height="3.5" />
    <path {...F} d="M19 26 h6 v4 a3 3 0 0 1 -6 0 Z" />
  </svg>
);
const svgL630R = svgL530R; // same twist-lock face style at this stylization level
const svgSchuko = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <circle {...F} cx="14" cy="22" r="3" />
    <circle {...F} cx="30" cy="22" r="3" />
    <path {...S} strokeWidth={3} d="M19 7 h6 M19 37 h6" />
  </svg>
);
const svgBS1363 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="7" y="7" width="30" height="30" rx="4" />
    <rect {...F} x="20" y="11" width="4" height="9" />
    <rect {...F} x="11" y="26" width="9" height="4" />
    <rect {...F} x="24" y="26" width="9" height="4" />
  </svg>
);
const svgAS3112 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <rect {...F} x="10" y="14" width="3.5" height="10" transform="rotate(-30 11.75 19)" />
    <rect {...F} x="30.5" y="14" width="3.5" height="10" transform="rotate(30 32.25 19)" />
    <rect {...F} x="20.25" y="25" width="3.5" height="9" />
  </svg>
);

// ── The catalogs ─────────────────────────────────────────────────────────────────────────────────
export const INLETS: InletDef[] = [
  { id: 'C14', label: 'IEC C14', takes: 'C13 cord', svg: svgC14 },
  { id: 'C20', label: 'IEC C20', takes: 'C19 cord', svg: svgC20 },
  { id: 'C16', label: 'IEC C16', takes: 'C15 cord (hot)', svg: svgC16 },
  { id: 'C6', label: 'IEC C6', takes: 'C5 cloverleaf', svg: svgC6 },
  { id: 'C8', label: 'IEC C8', takes: 'C7 figure-8', svg: svgC8 },
  { id: 'NEMA 5-15P', label: 'NEMA 5-15P', takes: 'fixed US cord', svg: svgNema515P },
  { id: 'Hardwired', label: 'Hardwired', takes: 'direct / other', svg: svgHardwire },
];

export const RECEPTACLES: ReceptacleDef[] = [
  { id: 'NEMA 5-15R', label: 'NEMA 5-15R', region: 'NA', volts: '120', amps: 15, svg: svgNema515R },
  { id: 'NEMA 5-20R', label: 'NEMA 5-20R', region: 'NA', volts: '120', amps: 20, svg: svgNema520R },
  { id: 'NEMA L5-30R', label: 'NEMA L5-30R', region: 'NA', volts: '120', amps: 30, svg: svgL530R },
  { id: 'NEMA 6-15R', label: 'NEMA 6-15R', region: 'NA', volts: '230', amps: 15, svg: svgNema615R },
  { id: 'NEMA 6-20R', label: 'NEMA 6-20R', region: 'NA', volts: '230', amps: 20, svg: svgNema620R },
  { id: 'NEMA L6-30R', label: 'NEMA L6-30R', region: 'NA', volts: '230', amps: 30, svg: svgL630R },
  { id: 'Schuko CEE 7/3', label: 'Schuko CEE 7/3', region: 'EU', volts: '230', amps: 16, svg: svgSchuko },
  { id: 'BS 1363', label: 'BS 1363 (UK)', region: 'UK', volts: '230', amps: 13, svg: svgBS1363 },
  { id: 'AS/NZS 3112', label: 'AS/NZS 3112', region: 'AU', volts: '230', amps: 10, svg: svgAS3112 },
];

export const REGION_LABEL: Record<Region, string> = {
  NA: 'North America',
  EU: 'Europe (Schuko)',
  UK: 'United Kingdom',
  AU: 'Australia / NZ',
};

export function receptacleById(id: string): ReceptacleDef | undefined {
  return RECEPTACLES.find((r) => r.id === id);
}
export function inletById(id: string): InletDef | undefined {
  return INLETS.find((i) => i.id === id);
}

// ── Region inference from the venue (best-effort; the grid always allows every region) ──────────
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const EU_HINTS = /germany|deutschland|frankfurt|berlin|münchen|munich|france|paris|netherlands|amsterdam|spain|madrid|italy|milan|czech|praha|prague|austria|vienna|poland|belgium|portugal|sweden|denmark|finland|norway/i;
const UK_HINTS = /united kingdom|\buk\b|england|london|birmingham|scotland|wales|manchester/i;
const AU_HINTS = /australia|sydney|melbourne|new zealand|auckland/i;

export function inferEventRegion(venue: { state?: string; city?: string; address?: string } | null | undefined, city?: string): Region {
  const state = String(venue?.state ?? '').trim().toUpperCase();
  if (US_STATES.has(state)) return 'NA';
  const hay = [venue?.address, venue?.city, city].filter(Boolean).join(' ');
  if (UK_HINTS.test(hay)) return 'UK';
  if (AU_HINTS.test(hay)) return 'AU';
  if (EU_HINTS.test(hay)) return 'EU';
  return 'NA'; // home turf default
}

// ── Voltage compatibility (the greying rule) ─────────────────────────────────────────────────────
/** Can a device of this voltage class run from a receptacle of this family? Amps never grey a cell
 *  (a 10/15/30 A drop at the right voltage is still usable); voltage mismatches do. */
export function deviceFitsVolts(device: DeviceVolts | undefined, fam: VoltFamily): boolean {
  if (device === '120') return fam === '120';
  if (device === '240') return fam === '230';
  return true; // 'auto' / unspecified: universal PSU assumption
}
