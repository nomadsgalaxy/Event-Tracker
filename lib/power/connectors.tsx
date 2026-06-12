// lib/power/connectors.tsx — the power-connector catalog: stylized SVG faces + metadata for the
// equipment INLET picker (IEC 60320 appliance inlets + the fixed US cord) and the event RECEPTACLE
// grid (NEMA / Schuko / BS / AS + the IEC 60309 venue drop), grouped by region. Pure + client-safe
// (the pickers render these in the item modal + event editor; the detail view uses the metadata for
// the compatibility check).
//
// NAMING: equipment-side cells are the INLET the device presents, subtitled with the CORD it takes
// ("C14 — takes a C13 cord") because crews name the cable, not the inlet. Receptacles use the NEMA
// "R" naming. Voltage families: '120' (NA branch circuits), '230' (EU/UK/AU — the 240-class), and
// devices can be '120' | '240' | 'auto' (universal PSU).
//
// ICON LANGUAGE (refined per the 2026-06 connector case study — no consistently-licensed pack
// exists, so these are original drawings): one face per CONNECTOR PATTERN, shared by the male and
// female of that pattern (a 5-15P and 5-15R look near-identical in real life; the grid headers say
// which gender). The pattern itself is what we draw accurately — 5- vs 6-series, straight vs
// locking, the 20 A T-slot, the round IEC coupler vs the wide 16 A one, Schuko clips, the UK
// triangle, the AU angled slats. The ONLY colored faces are the ones whose COLOR IS THE STANDARD:
// IEC 60309 blue (230 V single-phase) and red (400 V three-phase). 44×44 viewBox, currentColor.

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

// ── SVG faces ────────────────────────────────────────────────────────────────────────────────────
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
const F = { fill: 'currentColor', stroke: 'none' };

// The round faceplate shared by every NEMA / world-plug face.
const round = <circle {...S} cx="22" cy="22" r="17" />;
// The NEMA D-shaped ground (bottom).
const dGround = <path {...F} d="M19 27.5 h6 v3.6 a3 3 0 0 1 -6 0 Z" />;

// IEC 60320 couplers ───────────────────────────────────────────────────────
// The chamfered trapezoid shell (the classic "coffin" outline; chamfer on the earth side).
const iecShell = <path {...S} d="M9 15 L13 9 H31 L35 15 V35 H9 Z" />;
// C13/C14 — the universal IT cord: two outer contacts low, earth centered high.
const svgC14 = (
  <svg viewBox="0 0 44 44" aria-hidden>{iecShell}
    <rect {...F} x="13" y="20" width="3.6" height="9.5" rx="1" />
    <rect {...F} x="20.2" y="14.5" width="3.6" height="9.5" rx="1" />
    <rect {...F} x="27.4" y="20" width="3.6" height="9.5" rx="1" />
  </svg>
);
// C15/C16 — the "hot" kettle coupler: C13/C14 plus the keying ridge under the earth (the 120 °C key).
const svgC16 = (
  <svg viewBox="0 0 44 44" aria-hidden>{iecShell}
    <rect {...F} x="13" y="20" width="3.6" height="9.5" rx="1" />
    <rect {...F} x="20.2" y="14.5" width="3.6" height="9.5" rx="1" />
    <rect {...F} x="27.4" y="20" width="3.6" height="9.5" rx="1" />
    <rect {...F} x="18.5" y="31.5" width="7" height="2.6" rx="1" />
  </svg>
);
// C19/C20 — the 16 A coupler: wide rectangular shell, three HORIZONTAL contacts (two high, earth low).
const svgC20 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="12" width="32" height="22" rx="3" />
    <rect {...F} x="10" y="17.5" width="9.5" height="3.6" rx="1" />
    <rect {...F} x="24.5" y="17.5" width="9.5" height="3.6" rx="1" />
    <rect {...F} x="17.25" y="25" width="9.5" height="3.6" rx="1" />
  </svg>
);
// C5/C6 — the cloverleaf ("Mickey Mouse"): three round lobes, earth at the apex.
const svgC6 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="14" cy="16.5" r="6.5" />
    <circle {...S} cx="30" cy="16.5" r="6.5" />
    <circle {...S} cx="22" cy="28.5" r="6.5" />
    <circle {...F} cx="14" cy="16.5" r="2.1" />
    <circle {...F} cx="30" cy="16.5" r="2.1" />
    <circle {...F} cx="22" cy="28.5" r="2.1" />
  </svg>
);
// C7/C8 — the figure-8 (non-polarized): two equal round lobes.
const svgC8 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M15 15 a8 8 0 0 0 0 16 h14 a8 8 0 0 0 0 -16 Z" />
    <circle {...F} cx="15" cy="23" r="2.1" />
    <circle {...F} cx="29" cy="23" r="2.1" />
  </svg>
);

// NEMA 5-series (125 V): two vertical blades — the NEUTRAL (left) is the wider one — plus D-ground.
const svgNema515 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="12.5" y="11.5" width="4.2" height="11.5" rx="1" />
    <rect {...F} x="27.6" y="13.5" width="3.4" height="9.5" rx="1" />
    {dGround}
  </svg>
);
// NEMA 5-20 (125 V 20 A): the neutral is a T-slot.
const svgNema520 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <path {...F} d="M12.5 11.5 h4.2 v11.5 h-4.2 Z M10.4 11.5 h8.4 v4 h-8.4 Z" />
    <rect {...F} x="27.6" y="13.5" width="3.4" height="9.5" rx="1" />
    {dGround}
  </svg>
);
// NEMA 6-series (250 V): BOTH blades horizontal (the give-away that it's a 240 V outlet).
const svgNema615 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="8.5" y="16.2" width="10.5" height="4" rx="1" />
    <rect {...F} x="25" y="16.2" width="10.5" height="4" rx="1" />
    {dGround}
  </svg>
);
// NEMA 6-20 (250 V 20 A): one blade horizontal, the other a horizontal-T.
const svgNema620 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <path {...F} d="M8.5 16.2 h10.5 v4 h-10.5 Z M11.8 12.7 h4 v11 h-4 Z" />
    <rect {...F} x="25" y="16.2" width="10.5" height="4" rx="1" />
    {dGround}
  </svg>
);
// NEMA locking (L-series): three curved blades around a center post — the twist-lock ring.
const svgLock = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="10.5" />
    <path {...F} d="M20 9 h4 v6.2 a2 2 0 0 1 -4 0 Z" />
    <path {...F} d="M11.4 25.5 a13 13 0 0 0 4.6 6 l2.1 -3.4 a9 9 0 0 1 -3.2 -4.2 Z" />
    <path {...F} d="M32.6 25.5 a13 13 0 0 1 -4.6 6 l-2.1 -3.4 a9 9 0 0 0 3.2 -4.2 Z" />
  </svg>
);

// Schuko CEE 7/3 (Type F) + the CEE 7/7 plug: round recess, two pins, earth CLIPS top & bottom.
const svgSchuko = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="11.5" />
    <circle {...F} cx="15.5" cy="22" r="2.8" />
    <circle {...F} cx="28.5" cy="22" r="2.8" />
    <rect {...F} x="19.5" y="9.2" width="5" height="3.4" rx="1" />
    <rect {...F} x="19.5" y="31.4" width="5" height="3.4" rx="1" />
  </svg>
);
// BS 1363 (Type G, UK): square face, vertical earth slot top-center, two horizontal slots below.
const svgBS1363 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="7" y="7" width="30" height="30" rx="4.5" />
    <rect {...F} x="20" y="10.5" width="4" height="9.5" rx="1" />
    <rect {...F} x="10.5" y="25.5" width="9.5" height="4" rx="1" />
    <rect {...F} x="24" y="25.5" width="9.5" height="4" rx="1" />
  </svg>
);
// AS/NZS 3112 (Type I, AU/NZ): two angled slats (inverted V) + a vertical earth below.
const svgAS3112 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="10.5" y="13" width="3.6" height="10.5" rx="1" transform="rotate(-32 12.3 18)" />
    <rect {...F} x="29.9" y="13" width="3.6" height="10.5" rx="1" transform="rotate(32 31.7 18)" />
    <rect {...F} x="20.2" y="24.5" width="3.6" height="9" rx="1" />
  </svg>
);

// IEC 60309 "commando" — the European venue booth drop. COLOR IS THE STANDARD.
// Blue 16/32 A 230 V single-phase: shrouded round face, 6 o'clock keyway, the fat earth pin.
const svg60309Blue = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke="#3b82f6" strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20" y="30.2" width="4" height="3.8" rx="1" />
    <circle {...F} cx="22" cy="15.5" r="3" />
    <circle {...F} cx="15.6" cy="24.5" r="2.2" />
    <circle {...F} cx="28.4" cy="24.5" r="2.2" />
  </svg>
);
// Red 32 A 400 V three-phase (4–5 pins in a star).
const svg60309Red = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke="#ef4444" strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20" y="30.2" width="4" height="3.8" rx="1" />
    <circle {...F} cx="22" cy="14.6" r="2.7" />
    <circle {...F} cx="15" cy="20" r="2.1" />
    <circle {...F} cx="29" cy="20" r="2.1" />
    <circle {...F} cx="17.6" cy="27.2" r="2.1" />
    <circle {...F} cx="26.4" cy="27.2" r="2.1" />
  </svg>
);

// A fixed attached cord ends in a wall plug — the generic male-plug face for the FIXED inlet cell.
const svgFixed = svgNema515;
const svgHardwire = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 30 C14 30 14 14 22 14 C30 14 30 30 36 30" />
    <circle {...F} cx="8" cy="30" r="2.4" />
    <circle {...F} cx="36" cy="30" r="2.4" />
  </svg>
);

// ── The catalogs ─────────────────────────────────────────────────────────────────────────────────
export const INLETS: InletDef[] = [
  { id: 'C14', label: 'IEC C14', takes: 'C13 cord', svg: svgC14 },
  { id: 'C20', label: 'IEC C20', takes: 'C19 cord', svg: svgC20 },
  { id: 'C16', label: 'IEC C16', takes: 'C15 cord (hot)', svg: svgC16 },
  { id: 'C6', label: 'IEC C6', takes: 'C5 cloverleaf', svg: svgC6 },
  { id: 'C8', label: 'IEC C8', takes: 'C7 figure-8', svg: svgC8 },
  // A fixed attached cord — the PLUG it ends in is picked separately (item.fixedPlug, any
  // international male AC plug; defaults from the home warehouse's region; per-serial overrides).
  { id: 'FIXED', label: 'Fixed cord', takes: 'attached plug', svg: svgFixed },
  { id: 'Hardwired', label: 'Hardwired', takes: 'direct / other', svg: svgHardwire },
];

/** Legacy stored inlet values that MEAN "fixed cord" (the pre-FIXED catalog had 'NEMA 5-15P'). */
export function isFixedCordInlet(plugType: string | undefined): boolean {
  const v = String(plugType ?? '').trim();
  return v === 'FIXED' || v === 'NEMA 5-15P';
}

export const RECEPTACLES: ReceptacleDef[] = [
  { id: 'NEMA 5-15R', label: 'NEMA 5-15R', region: 'NA', volts: '120', amps: 15, svg: svgNema515 },
  { id: 'NEMA 5-20R', label: 'NEMA 5-20R', region: 'NA', volts: '120', amps: 20, svg: svgNema520 },
  { id: 'NEMA L5-30R', label: 'NEMA L5-30R', region: 'NA', volts: '120', amps: 30, svg: svgLock },
  { id: 'NEMA 6-15R', label: 'NEMA 6-15R', region: 'NA', volts: '230', amps: 15, svg: svgNema615 },
  { id: 'NEMA 6-20R', label: 'NEMA 6-20R', region: 'NA', volts: '230', amps: 20, svg: svgNema620 },
  { id: 'NEMA L6-30R', label: 'NEMA L6-30R', region: 'NA', volts: '230', amps: 30, svg: svgLock },
  { id: 'Schuko CEE 7/3', label: 'Schuko CEE 7/3', region: 'EU', volts: '230', amps: 16, svg: svgSchuko },
  // The IEC 60309 "commando" — the standard European exhibition-hall booth drop.
  { id: 'IEC 60309 blue 16A', label: 'CEE 16A (blue)', region: 'EU', volts: '230', amps: 16, svg: svg60309Blue },
  { id: 'IEC 60309 blue 32A', label: 'CEE 32A (blue)', region: 'EU', volts: '230', amps: 32, svg: svg60309Blue },
  { id: 'IEC 60309 red 32A', label: 'CEE 32A 3-phase (red)', region: 'EU', volts: '230', amps: 32, svg: svg60309Red },
  { id: 'BS 1363', label: 'BS 1363 (UK)', region: 'UK', volts: '230', amps: 13, svg: svgBS1363 },
  { id: 'AS/NZS 3112', label: 'AS/NZS 3112', region: 'AU', volts: '230', amps: 10, svg: svgAS3112 },
];

// ── Cable ends (the 'cable' item kind: power strips / extensions / adapters) ────────────────────
// MALE = the source side (goes into the wall/drop or an upstream device); FEMALE = the outlet side.
// volts/amps describe the END's rating so an adapter self-describes ("NEMA L6-30P 230V 30A →
// NEMA 5-15R 120V 15A" is representable — electricians do crazy things). One face per PATTERN is
// shared by both genders (the grid header says which); the label is authoritative.
export interface CableEndDef {
  id: string;
  label: string;
  volts: VoltFamily | '250';
  amps: number;
  svg: ReactNode;
}

export const CABLE_MALE_ENDS: CableEndDef[] = [
  { id: 'NEMA 5-15P', label: 'NEMA 5-15P', volts: '120', amps: 15, svg: svgNema515 },
  { id: 'NEMA 5-20P', label: 'NEMA 5-20P', volts: '120', amps: 20, svg: svgNema520 },
  { id: 'NEMA L5-30P', label: 'NEMA L5-30P', volts: '120', amps: 30, svg: svgLock },
  { id: 'NEMA 6-15P', label: 'NEMA 6-15P', volts: '230', amps: 15, svg: svgNema615 },
  { id: 'NEMA 6-20P', label: 'NEMA 6-20P', volts: '230', amps: 20, svg: svgNema620 },
  { id: 'NEMA L6-30P', label: 'NEMA L6-30P', volts: '230', amps: 30, svg: svgLock },
  { id: 'CEE 7/7', label: 'CEE 7/7 (Schuko)', volts: '230', amps: 16, svg: svgSchuko },
  { id: 'BS 1363P', label: 'BS 1363 (UK)', volts: '230', amps: 13, svg: svgBS1363 },
  { id: 'AS/NZS 3112P', label: 'AS/NZS 3112', volts: '230', amps: 10, svg: svgAS3112 },
  { id: 'IEC 60309 blue 16A', label: 'CEE 16A (blue)', volts: '230', amps: 16, svg: svg60309Blue },
  { id: 'IEC 60309 blue 32A', label: 'CEE 32A (blue)', volts: '230', amps: 32, svg: svg60309Blue },
  { id: 'C14', label: 'IEC C14 (inline)', volts: '250', amps: 10, svg: svgC14 },
  { id: 'C20', label: 'IEC C20 (inline)', volts: '250', amps: 16, svg: svgC20 },
];

export const CABLE_FEMALE_ENDS: CableEndDef[] = [
  { id: 'NEMA 5-15R', label: 'NEMA 5-15R', volts: '120', amps: 15, svg: svgNema515 },
  { id: 'NEMA 5-20R', label: 'NEMA 5-20R', volts: '120', amps: 20, svg: svgNema520 },
  { id: 'NEMA L5-30R', label: 'NEMA L5-30R', volts: '120', amps: 30, svg: svgLock },
  { id: 'NEMA 6-15R', label: 'NEMA 6-15R', volts: '230', amps: 15, svg: svgNema615 },
  { id: 'NEMA 6-20R', label: 'NEMA 6-20R', volts: '230', amps: 20, svg: svgNema620 },
  { id: 'NEMA L6-30R', label: 'NEMA L6-30R', volts: '230', amps: 30, svg: svgLock },
  { id: 'Schuko CEE 7/3', label: 'Schuko CEE 7/3', volts: '230', amps: 16, svg: svgSchuko },
  { id: 'BS 1363R', label: 'BS 1363 (UK)', volts: '230', amps: 13, svg: svgBS1363 },
  { id: 'AS/NZS 3112R', label: 'AS/NZS 3112', volts: '230', amps: 10, svg: svgAS3112 },
  { id: 'C13', label: 'IEC C13', volts: '250', amps: 10, svg: svgC14 },
  { id: 'C15', label: 'IEC C15 (hot)', volts: '250', amps: 10, svg: svgC16 },
  { id: 'C19', label: 'IEC C19', volts: '250', amps: 16, svg: svgC20 },
  { id: 'C5', label: 'IEC C5', volts: '250', amps: 2.5, svg: svgC6 },
  { id: 'C7', label: 'IEC C7', volts: '250', amps: 2.5, svg: svgC8 },
];

export function cableEndById(id: string, side: 'male' | 'female'): CableEndDef | undefined {
  return (side === 'male' ? CABLE_MALE_ENDS : CABLE_FEMALE_ENDS).find((e) => e.id === id);
}

/** The international WALL plugs (a fixed cord ends in one of these — the inline IEC males + the
 *  industrial 60309 feeds don't count). */
export const WALL_PLUGS: CableEndDef[] = CABLE_MALE_ENDS.filter(
  (e) => e.id !== 'C14' && e.id !== 'C20' && !e.id.startsWith('IEC 60309')
);

/** The region's everyday wall plug — the fixed-cord dropdown's default. */
export const REGION_DEFAULT_PLUG: Record<Region, string> = {
  NA: 'NEMA 5-15P',
  EU: 'CEE 7/7',
  UK: 'BS 1363P',
  AU: 'AS/NZS 3112P',
};

/** A cable end's short rating text — '120V 15A' (the cursed-adapter display). */
export function cableEndRating(end: CableEndDef): string {
  const v = end.volts === '120' ? '120V' : end.volts === '230' ? '230/240V' : '≤250V';
  return `${v} ${end.amps}A`;
}

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

/** Region from venue COORDINATES (the Google Places autocomplete stores venue.lat/lng — the
 *  authoritative destination signal). Coarse continental boxes; null = outside all (fall back to
 *  the text heuristic). UK is carved out before the EU box. */
export function regionFromLatLng(lat: number, lng: number): Region | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat >= 49.8 && lat <= 61 && lng >= -11 && lng <= 1.7) return 'UK'; // Britain + Ireland (G plugs)
  if (lat >= 34 && lat <= 72 && lng <= -50 && lng >= -170) return 'NA'; // US/Canada
  if (lat >= 14 && lat < 34 && lng <= -86 && lng >= -120) return 'NA'; // Mexico (NEMA/120V family)
  if (lat >= -47 && lat <= -10 && lng >= 112 && lng <= 179) return 'AU'; // Australia + NZ
  if (lat >= 35 && lat <= 71 && lng >= -10 && lng <= 40) return 'EU'; // continental Europe (Schuko)
  return null;
}

export function inferEventRegion(
  venue: { state?: string; city?: string; address?: string; lat?: number; lng?: number } | null | undefined,
  city?: string
): Region {
  // 1) Coordinates win — set by the Places autocomplete (or an ICS import's GEO), no text guessing.
  const byGeo = regionFromLatLng(Number(venue?.lat), Number(venue?.lng));
  if (byGeo) return byGeo;
  // 2) Text heuristics, then the home-turf default.
  const state = String(venue?.state ?? '').trim().toUpperCase();
  if (US_STATES.has(state)) return 'NA';
  const hay = [venue?.address, venue?.city, city].filter(Boolean).join(' ');
  if (UK_HINTS.test(hay)) return 'UK';
  if (AU_HINTS.test(hay)) return 'AU';
  if (EU_HINTS.test(hay)) return 'EU';
  return 'NA';
}

/** The destination's mains family + its standard receptacle(s) — the "what plug will I need there"
 *  answer the UI surfaces proactively from the event's location. */
export function regionPower(region: Region): { volts: VoltFamily; mains: string; receptacles: ReceptacleDef[] } {
  const recs = RECEPTACLES.filter((r) => r.region === region);
  const volts: VoltFamily = region === 'NA' ? '120' : '230';
  return {
    volts,
    mains: region === 'NA' ? '120 V (240 V available on NEMA 6-x drops)' : '230 V',
    receptacles: recs.filter((r) => r.volts === volts || region !== 'NA'),
  };
}

// ── Voltage compatibility (the greying rule) ─────────────────────────────────────────────────────
/** Can a device of this voltage class run from a receptacle of this family? Amps never grey a cell
 *  (a 10/15/30 A drop at the right voltage is still usable); voltage mismatches do. */
export function deviceFitsVolts(device: DeviceVolts | undefined, fam: VoltFamily): boolean {
  if (device === '120') return fam === '120';
  if (device === '240') return fam === '230';
  return true; // 'auto' / unspecified: universal PSU assumption
}
