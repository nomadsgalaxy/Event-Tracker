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
// C13/C14 — the universal IT cord. Earth top-center, line/neutral lower (the triangle); contacts are
// LANDSCAPE slots (wider than tall, per the audit). Shell is the symmetric chamfered hex.
const svgC14 = (
  <svg viewBox="0 0 44 44" aria-hidden>{iecShell}
    <rect {...F} x="16" y="13.8" width="12" height="3.4" rx="1" />
    <rect {...F} x="11.5" y="21.5" width="9" height="3.4" rx="1" />
    <rect {...F} x="23.5" y="21.5" width="9" height="3.4" rx="1" />
  </svg>
);
// C15/C16 — the "hot" coupler: C13/C14 contacts + the 120 °C keying NOTCH cut into the bottom shell
// edge (a silhouette void, not a solid bar — that's what makes it read as a key, not a contact).
const iecShellHot = <path {...S} d="M9 15 L13 9 H31 L35 15 V35 H25.5 V31.5 H18.5 V35 H9 Z" />;
const svgC16 = (
  <svg viewBox="0 0 44 44" aria-hidden>{iecShellHot}
    <rect {...F} x="16" y="13.8" width="12" height="3.4" rx="1" />
    <rect {...F} x="11.5" y="21.5" width="9" height="3.4" rx="1" />
    <rect {...F} x="23.5" y="21.5" width="9" height="3.4" rx="1" />
  </svg>
);
// C19/C20 — the 16 A coupler: wide rectangular shell, earth top-center, line/neutral on the bottom
// row (same earth-up family as C13; the landscape shell is what tells it apart).
const svgC20 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="12" width="32" height="22" rx="3" />
    <rect {...F} x="17" y="15.5" width="10" height="3.6" rx="1" />
    <rect {...F} x="10" y="24" width="9.5" height="3.6" rx="1" />
    <rect {...F} x="24.5" y="24" width="9.5" height="3.6" rx="1" />
  </svg>
);
// C5/C6 — the cloverleaf ("Mickey Mouse"): three round lobes that TOUCH into a trefoil (the merged
// outline IS the identity), earth at the bottom apex. Larger contact dots for legibility.
const svgC6 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="15.5" cy="18" r="6.6" />
    <circle {...S} cx="28.5" cy="18" r="6.6" />
    <circle {...S} cx="22" cy="29" r="6.6" />
    <circle {...F} cx="15.5" cy="18" r="3" />
    <circle {...F} cx="28.5" cy="18" r="3" />
    <circle {...F} cx="22" cy="29" r="3" />
  </svg>
);
// C7/C8 — the figure-8 (non-polarized): two equal circles that TOUCH at the waist (a true figure-8,
// not a stadium — the pinch is the give-away).
const svgC8 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="15" cy="22" r="7" />
    <circle {...S} cx="29" cy="22" r="7" />
    <circle {...F} cx="15" cy="22" r="2.2" />
    <circle {...F} cx="29" cy="22" r="2.2" />
  </svg>
);

// NEMA 5-series (125 V): two vertical blades of EQUAL length, aligned tops — the NEUTRAL (left) is
// just WIDER — plus the D-shaped ground pin (plug-face convention: filled blades + filled D-ground).
const svgNema515 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="12.5" y="11.5" width="4.2" height="11" rx="1" />
    <rect {...F} x="27.3" y="11.5" width="3.4" height="11" rx="1" />
    {dGround}
  </svg>
);
// NEMA 5-20 (125 V 20 A): the neutral is a T whose crossbar extends ONE way, toward the hot — that
// one-sided T is the whole 5-20-vs-5-15 tell.
const svgNema520 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <path {...F} d="M12.5 11.5 h4.2 v11 h-4.2 Z M12.5 11.5 h7.6 v3.5 h-7.6 Z" />
    <rect {...F} x="27.3" y="11.5" width="3.4" height="11" rx="1" />
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
// NEMA 6-20 (250 V 20 A): the two hots are PERPENDICULAR — one vertical, one horizontal (vs 6-15's
// two-horizontal). That right-angle pair is the 6-20 signature.
const svgNema620 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="11.8" y="11.5" width="3.6" height="11" rx="1" />
    <rect {...F} x="23" y="14.7" width="11" height="3.6" rx="1" />
    {dGround}
  </svg>
);
// NEMA locking (L-series): three CURVED blades spaced ~120° around the ring (the twist-lock arc), one
// at top, two lower — they hug a concentric inner ring.
const svgLock = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="10" />
    <path fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" d="M16.7 9.57 A 13.5 13.5 0 0 1 27.3 9.57" />
    <path fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" d="M13.9 32.8 A 13.5 13.5 0 0 1 8.6 23.6" />
    <path fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" d="M35.4 23.6 A 13.5 13.5 0 0 1 30.1 32.8" />
  </svg>
);

// Schuko CEE 7/3 (Type F) + the CEE 7/7 plug: round recess, two WIDELY-spaced pins (the 19 mm pitch
// that tells it from a narrow Europlug), earth CLIPS straddling the rim top & bottom.
const svgSchuko = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="11.5" />
    <circle {...F} cx="13" cy="22" r="2.8" />
    <circle {...F} cx="31" cy="22" r="2.8" />
    <rect {...F} x="19.5" y="9" width="5" height="3.2" rx="1" />
    <rect {...F} x="19.5" y="31.8" width="5" height="3.2" rx="1" />
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
// AS/NZS 3112 (Type I, AU/NZ): two angled slats (inverted V) + a vertical earth below that is LONGER
// than the active/neutral pair (real earth 20 mm vs 17.35 mm).
const svgAS3112 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="11" y="12.5" width="4" height="10.5" rx="1" transform="rotate(-32 13 17.75)" />
    <rect {...F} x="29" y="12.5" width="4" height="10.5" rx="1" transform="rotate(32 31 17.75)" />
    <rect {...F} x="20" y="23.5" width="4" height="11.5" rx="1" />
  </svg>
);

// IEC 60309 "commando" — the European venue booth drop. COLOR IS THE STANDARD.
// Blue 16/32 A 230 V single-phase, 6h: the FAT earth pin sits at 6 o'clock (bottom) with the keyway,
// line & neutral up at ~10 and ~2 o'clock (equal 120° spacing). Earth-at-bottom is the keying.
const svg60309Blue = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke="#3b82f6" strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20.5" y="31" width="3" height="2.6" rx="1" />
    <circle {...F} cx="22" cy="28.75" r="3" />
    <circle {...F} cx="14.4" cy="17.6" r="2.2" />
    <circle {...F} cx="29.6" cy="17.6" r="2.2" />
  </svg>
);
// Red 32 A 400 V three-phase 3P+N+E (6h): five pins as a regular pentagon, the fat earth at 6 o'clock
// (bottom) with the keyway, the four smaller phase/neutral pins 72° apart clockwise from it.
const svg60309Red = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke="#ef4444" strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20.5" y="31" width="3" height="2.6" rx="1" />
    <circle {...F} cx="22" cy="29.4" r="2.7" />
    <circle {...F} cx="15" cy="24.3" r="2.1" />
    <circle {...F} cx="17.7" cy="16" r="2.1" />
    <circle {...F} cx="26.3" cy="16" r="2.1" />
    <circle {...F} cx="29" cy="24.3" r="2.1" />
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

/** A TRUE mains-voltage mismatch between two cable ends — only a fixed 120 V end against a fixed
 *  230 V end. The IEC '250' couplers (C13/C19/…) are rated UP TO 250 V but carry whatever the source
 *  supplies, so they're voltage-agnostic and never trigger the cross-voltage warning (a US PDU with
 *  C13 outlets is normal, not a transformer). */
export function cableEndsCrossVoltage(a: CableEndDef | undefined, b: CableEndDef | undefined): boolean {
  if (!a || !b) return false;
  return (a.volts === '120' && b.volts === '230') || (a.volts === '230' && b.volts === '120');
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
