// lib/power/connectors.tsx — the power-connector catalog: stylized SVG faces + metadata for the
// equipment INLET picker (IEC 60320 appliance inlets + the fixed US cord) and the event RECEPTACLE
// grid (NEMA / Schuko / French / BS / AS / the other IEC world types A–N + the IEC 60309 venue drop), grouped by region. Pure + client-safe
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

/** A receptacle-grid group: the four venue regions + the country-specific types (CH/IT/DK/IL/IN/ZA/BR/TH). */
export type ReceptacleGroup = Region | 'WORLD';

/** Picker grouping for every connector: the wall-plug regions, then the non-wall families. */
export type ConnectorGroup = ReceptacleGroup | 'INDUSTRIAL' | 'IEC' | 'STAGE' | 'DC' | 'OTHER';

export const CONNECTOR_GROUP_LABEL: Record<ConnectorGroup, string> = {
  NA: 'North America / Japan (NEMA)',
  EU: 'Europe',
  UK: 'United Kingdom',
  AU: 'Australia / NZ / China / Argentina',
  WORLD: 'Other countries',
  INDUSTRIAL: 'Industrial (IEC 60309 / Camlock)',
  IEC: 'IEC appliance couplers',
  STAGE: 'Stage (powerCON / Socapex)',
  DC: 'DC & low voltage',
  OTHER: 'Other',
};

export interface InletDef {
  id: string; // stored in item.plugType
  label: string; // the official inlet name
  takes: string; // the cord/coupler it mates with (what crews call it)
  group: ConnectorGroup;
  svg: ReactNode;
}

export interface ReceptacleDef {
  id: string; // stored in event.powerReceptacles[]
  label: string;
  region: ReceptacleGroup;
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
// NEMA 5-20 (125 V 20 A): the neutral is a sideways T — the vertical slot (5-15 compatible) with a
// horizontal member branching from MID-HEIGHT toward the hot (per the NEMA WD-6 5-20R face; the
// one-sided ⊢ is the whole 5-20-vs-5-15 tell).
const svgNema520 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <path {...F} d="M12.5 11.5 h4.2 v11 h-4.2 Z M12.5 15.25 h7.6 v3.5 h-7.6 Z" />
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

// NEMA 1-15 (Type A, US/Japan): the 5-15 blade pair with NO ground pin.
const svgNema115 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="12.5" y="16.5" width="4.2" height="11" rx="1" />
    <rect {...F} x="27.3" y="16.5" width="3.4" height="11" rx="1" />
  </svg>
);
// NEMA 14-50 (125/250 V range/RV drop): ground on TOP (flipped D), the two hots vertical at the
// sides, the neutral a vertical blade bottom-center.
const svgNema1450 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <path {...F} d="M19 16.5 h6 v-3.6 a3 3 0 0 0 -6 0 Z" />
    <rect {...F} x="9.5" y="17" width="3.6" height="10" rx="1" />
    <rect {...F} x="30.9" y="17" width="3.6" height="10" rx="1" />
    <rect {...F} x="20.2" y="25" width="3.6" height="9" rx="1" />
  </svg>
);
// Europlug CEE 7/16 (Type C): the flat lozenge body, two unearthed round pins, no earth contact.
const svgEuroplug = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M6 22 L13 14 H31 L38 22 L31 30 H13 Z" />
    <circle {...F} cx="16" cy="22" r="2.4" />
    <circle {...F} cx="28" cy="22" r="2.4" />
  </svg>
);
// French CEE 7/5 (Type E): the Schuko recess, but the earth is a PIN sticking out at the top (no clips).
const svgFrench = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="11.5" />
    <circle {...F} cx="13" cy="22" r="2.8" />
    <circle {...F} cx="31" cy="22" r="2.8" />
    <circle {...F} cx="22" cy="14" r="2.4" />
  </svg>
);
// BS 546 (Types D 5 A / M 15 A, India/South Africa): three round pins in a triangle, the FAT earth on top.
const svgBS546 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...F} cx="22" cy="13.5" r="3.4" />
    <circle {...F} cx="14.5" cy="27" r="2.4" />
    <circle {...F} cx="29.5" cy="27" r="2.4" />
  </svg>
);
// SI 32 (Type H, Israel): three pins in an inverted triangle, earth at the bottom.
const svgSI32 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...F} cx="15" cy="16" r="2.3" />
    <circle {...F} cx="29" cy="16" r="2.3" />
    <circle {...F} cx="22" cy="29" r="2.3" />
  </svg>
);
// SEV 1011 (Type J, Switzerland): the HEXAGONAL face, earth pin offset just below the L/N line.
const svgSEV1011 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 22 L15 10 H29 L36 22 L29 34 H15 Z" />
    <circle {...F} cx="14.5" cy="20" r="2.2" />
    <circle {...F} cx="29.5" cy="20" r="2.2" />
    <circle {...F} cx="22" cy="26.5" r="2.2" />
  </svg>
);
// DS 60884-2-D1 (Type K, Denmark): two round pins over a half-round earth (the "smiley face").
const svgDanish = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...F} cx="14.5" cy="18" r="2.4" />
    <circle {...F} cx="29.5" cy="18" r="2.4" />
    {dGround}
  </svg>
);
// CEI 23-50 (Type L, Italy): three round pins IN A LINE, earth in the middle.
const svgCEI2350 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="14" width="32" height="16" rx="8" />
    <circle {...F} cx="13" cy="22" r="2.3" />
    <circle {...F} cx="22" cy="22" r="2.3" />
    <circle {...F} cx="31" cy="22" r="2.3" />
  </svg>
);
// NBR 14136 (Type N, Brazil): round recess, L/N on a line with the earth pin offset below center.
const svgNBR14136 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...S} cx="22" cy="22" r="11.5" />
    <circle {...F} cx="15" cy="20" r="2.4" />
    <circle {...F} cx="29" cy="20" r="2.4" />
    <circle {...F} cx="22" cy="25.5" r="2.4" />
  </svg>
);

// ── Faces added with the world + DC expansion (2026-10). These have NOT been through the accuracy
// audit yet — the label is authoritative until they are. ────────────────────────────────────────
// The flipped D-ground on TOP (14-series).
const dGroundTop = <path {...F} d="M19 16.5 h6 v-3.6 a3 3 0 0 0 -6 0 Z" />;
// NEMA 14-30 (125/250 V dryer): the 14-50 layout, but the neutral is L-shaped.
const svgNema1430 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}{dGroundTop}
    <rect {...F} x="9.5" y="17" width="3.6" height="10" rx="1" />
    <rect {...F} x="30.9" y="17" width="3.6" height="10" rx="1" />
    <path {...F} d="M20.2 24 h3.6 v6 h4 v3.6 h-7.6 Z" />
  </svg>
);
// NEMA 10-series (old 125/250 V dryer/range, NO ground): two hots angled into a V over the neutral.
const nema10Hots = (
  <>
    <rect {...F} x="11" y="10" width="3.6" height="11" rx="1" transform="rotate(-25 12.8 15.5)" />
    <rect {...F} x="29.4" y="10" width="3.6" height="11" rx="1" transform="rotate(25 31.2 15.5)" />
  </>
);
const svgNema1030 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}{nema10Hots}
    <path {...F} d="M20.2 23 h3.6 v6 h4 v3.6 h-7.6 Z" />
  </svg>
);
const svgNema1050 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}{nema10Hots}
    <rect {...F} x="20.2" y="23" width="3.6" height="10" rx="1" />
  </svg>
);
// TT-30 (RV 120 V 30 A, not a NEMA number): hot + neutral angled into an inverted V, round ground below.
const svgTT30 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="12" y="11" width="3.6" height="10" rx="1" transform="rotate(30 13.8 16)" />
    <rect {...F} x="28.4" y="11" width="3.6" height="10" rx="1" transform="rotate(-30 30.2 16)" />
    <circle {...F} cx="22" cy="29" r="2.8" />
  </svg>
);
// shortcut: 5-30/5-50/6-30/6-50/14-60 share one generic heavy-blade face; draw each on the next accuracy pass.
const svgNemaHeavy = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <rect {...F} x="10.5" y="11" width="5.5" height="12" rx="1" />
    <rect {...F} x="28" y="11" width="5.5" height="12" rx="1" />
    {dGround}
  </svg>
);
// CEE 7/17 contour plug (unearthed 16 A, fits Schuko + French): the Schuko round body, no earth contacts.
const svgCEE717 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...F} cx="13" cy="22" r="2.8" />
    <circle {...F} cx="31" cy="22" r="2.8" />
  </svg>
);
// BS 4573 UK shaver plug/socket: small rounded body, two round pins.
const svgBS4573 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="9" y="13" width="26" height="18" rx="5" />
    <circle {...F} cx="15.5" cy="22" r="2.1" />
    <circle {...F} cx="28.5" cy="22" r="2.1" />
  </svg>
);
// TIS 166-2549 (Type O, Thailand): round face, two round pins over an earth pin (no recess, unlike N).
const svgTIS166 = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    <circle {...F} cx="15" cy="18.5" r="2.4" />
    <circle {...F} cx="29" cy="18.5" r="2.4" />
    <circle {...F} cx="22" cy="28" r="2.4" />
  </svg>
);
// IEC 60309 yellow (110 V site power, 4h): the blue face with the earth moved to 4 o'clock.
const svg60309Yellow = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke="#eab308" strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20.5" y="31" width="3" height="2.6" rx="1" />
    <circle {...F} cx="27.9" cy="25.4" r="3" />
    <circle {...F} cx="16.1" cy="25.4" r="2.2" />
    <circle {...F} cx="22" cy="15.2" r="2.2" />
  </svg>
);
// Cam-type (Camlock, E1016 series): the single-pole feeder connector — one fat contact + the cam key.
const svgCamlock = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="15" />
    <circle {...F} cx="22" cy="22" r="5" />
    <rect {...F} x="20.5" y="5.5" width="3" height="5" rx="1" />
  </svg>
);
// IEC C1/C2 (tiny 0.2 A 2-pin, shavers/toothbrushes).
const svgC2 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="11" y="16" width="22" height="12" rx="6" />
    <circle {...F} cx="17" cy="22" r="1.8" />
    <circle {...F} cx="27" cy="22" r="1.8" />
  </svg>
);
// C17/C18 — the C13/C14 shell with no earth contact.
const svgC18 = (
  <svg viewBox="0 0 44 44" aria-hidden>{iecShell}
    <rect {...F} x="11.5" y="21.5" width="9" height="3.4" rx="1" />
    <rect {...F} x="23.5" y="21.5" width="9" height="3.4" rx="1" />
  </svg>
);
// C21/C22 — the 16 A hot coupler: the C19/C20 face with the keying notch in the bottom edge.
const svgC22 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M9 12 H35 a3 3 0 0 1 3 3 V31 a3 3 0 0 1 -3 3 H25.5 V30.5 H18.5 V34 H9 a3 3 0 0 1 -3 -3 V15 a3 3 0 0 1 3 -3 Z" />
    <rect {...F} x="17" y="15.5" width="10" height="3.6" rx="1" />
    <rect {...F} x="10" y="22.5" width="9.5" height="3.6" rx="1" />
    <rect {...F} x="24.5" y="22.5" width="9.5" height="3.6" rx="1" />
  </svg>
);
// C23/C24 — the C19/C20 shell with no earth contact.
const svgC24 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="12" width="32" height="22" rx="3" />
    <rect {...F} x="10" y="21" width="9.5" height="3.6" rx="1" />
    <rect {...F} x="24.5" y="21" width="9.5" height="3.6" rx="1" />
  </svg>
);
// Neutrik powerCON: COLOR IS THE STANDARD — blue = power in, grey = power out. Three contacts + the latch.
const powerCon = (ring: string) => (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle fill="none" stroke={ring} strokeWidth={2.6} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="9" />
    <rect {...F} x="20.5" y="9" width="3" height="4.5" rx="1" />
    <rect {...F} x="11" y="26.5" width="5" height="3" rx="1" transform="rotate(-30 13.5 28)" />
    <rect {...F} x="28" y="26.5" width="5" height="3" rx="1" transform="rotate(30 30.5 28)" />
    <rect {...F} x="34" y="20.5" width="4" height="3" rx="1" />
  </svg>
);
const svgPowerconIn = powerCon('#3b82f6');
const svgPowerconOut = powerCon('#9ca3af');
// powerCON TRUE1: the double-ring housing (one connector both ways, hot-pluggable).
const svgTrue1 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="17" />
    <circle {...S} cx="22" cy="22" r="13" />
    <circle {...F} cx="22" cy="15" r="2.2" />
    <circle {...F} cx="16" cy="26" r="2.2" />
    <circle {...F} cx="28" cy="26" r="2.2" />
  </svg>
);
// Socapex 19-pin (6 circuits on one multicore): a centre pin, a ring of 6 and a ring of 12.
const socaPins: [number, number][] = [
  [22, 22],
  ...Array.from({ length: 6 }, (_, i): [number, number] => [22 + 6 * Math.sin((i * Math.PI) / 3), 22 - 6 * Math.cos((i * Math.PI) / 3)]),
  ...Array.from({ length: 12 }, (_, i): [number, number] => [22 + 11.5 * Math.sin((i * Math.PI) / 6), 22 - 11.5 * Math.cos((i * Math.PI) / 6)]),
];
const svgSocapex = (
  <svg viewBox="0 0 44 44" aria-hidden>{round}
    {socaPins.map(([x, y], i) => <circle key={i} {...F} cx={x.toFixed(2)} cy={y.toFixed(2)} r="1.5" />)}
  </svg>
);

// DC barrel (coaxial): outer sleeve + centre pin, scaled roughly by OD / pin size.
const barrel = (r: number, pin: number) => (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r={r} />
    <circle {...S} cx="22" cy="22" r={r * 0.6} />
    <circle {...F} cx="22" cy="22" r={pin} />
  </svg>
);
const svgBarrel5521 = barrel(15, 2.6);
const svgBarrel5525 = barrel(15, 3.2);
const svgBarrel4017 = barrel(12, 2.1);
const svgBarrel3513 = barrel(10.5, 1.7);
const svgBarrel2507 = barrel(8, 1.1);
const svgUsbA = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="8" y="14" width="28" height="16" rx="1.5" />
    <rect {...F} x="11" y="17.5" width="22" height="5" rx="0.5" />
  </svg>
);
const svgUsbC = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="7" y="15" width="30" height="14" rx="7" />
    <rect {...F} x="12" y="20.5" width="20" height="3" rx="1.5" />
  </svg>
);
const svgMicroUsb = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 16 H36 L32 28 H12 Z" />
    <rect {...F} x="13" y="18.5" width="18" height="3" rx="0.5" />
  </svg>
);
const svgMiniUsb = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 15 H36 V25 L31 30 H13 L8 25 Z" />
    <rect {...F} x="12" y="18" width="20" height="4" rx="0.5" />
  </svg>
);
const svgLightning = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="17" width="32" height="10" rx="5" />
    <rect {...F} x="13" y="20" width="3" height="4" rx="0.5" />
    <rect {...F} x="18" y="20" width="3" height="4" rx="0.5" />
    <rect {...F} x="23" y="20" width="3" height="4" rx="0.5" />
    <rect {...F} x="28" y="20" width="3" height="4" rx="0.5" />
  </svg>
);
// 12 V auxiliary / cigarette lighter (ISO 4165): round body, centre tip + the side spring contacts.
const svgCig12 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="14" />
    <circle {...F} cx="22" cy="22" r="3.2" />
    <rect {...F} x="5.5" y="19.5" width="4" height="5" rx="1" />
    <rect {...F} x="34.5" y="19.5" width="4" height="5" rx="1" />
  </svg>
);
// SAE 2-pin (solar/battery tenders): hooded body, one exposed pin + one socket (hermaphroditic).
const svgSAE = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="8" y="13" width="28" height="18" rx="9" />
    <circle {...F} cx="16" cy="22" r="2.8" />
    <circle {...S} cx="28" cy="22" r="3" />
  </svg>
);
// Anderson Powerpole (genderless): two housings side by side, contacts offset.
const svgPowerpole = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="7" y="12" width="14" height="20" rx="1" />
    <rect {...S} x="23" y="12" width="14" height="20" rx="1" />
    <rect {...F} x="10" y="15" width="8" height="6" rx="0.5" />
    <rect {...F} x="26" y="23" width="8" height="6" rx="0.5" />
  </svg>
);
// Anderson SB50/SB120 (genderless high-current): one wide housing, two flat contacts.
const svgAndersonSB = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <rect {...S} x="6" y="11" width="32" height="22" rx="2" />
    <rect {...F} x="11" y="16" width="8" height="12" rx="1" />
    <rect {...F} x="25" y="16" width="8" height="12" rx="1" />
  </svg>
);
// XT30/XT60/XT90 (RC / LiPo packs): the one-side-chamfered body, two round pins.
const svgXT = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M8 14 H31 L36 19 V30 H8 Z" />
    <circle {...F} cx="16" cy="22" r="3" />
    <circle {...F} cx="28" cy="22" r="3" />
  </svg>
);
// 4-pin XLR (broadcast / camera DC): round shell, four pins in a square, the key on top.
const svgXlr4 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="15" />
    <rect {...F} x="20.5" y="5" width="3" height="4" rx="1" />
    <circle {...F} cx="16.5" cy="17" r="2" />
    <circle {...F} cx="27.5" cy="17" r="2" />
    <circle {...F} cx="16.5" cy="28" r="2" />
    <circle {...F} cx="27.5" cy="28" r="2" />
  </svg>
);
// D-Tap / P-Tap (V-mount / gold-mount battery taps): one wide + one narrow flat contact.
const svgDTap = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <path {...S} d="M9 14 H35 V30 H13 L9 26 Z" />
    <rect {...F} x="14" y="19" width="10" height="6" rx="1" />
    <rect {...F} x="27" y="19" width="4" height="6" rx="1" />
  </svg>
);
// Hirose HR10 4-pin (small camera DC): the XLR pattern shrunk, key notch on top.
const svgHirose4 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="11" />
    <rect {...F} x="20.8" y="9" width="2.4" height="3.5" rx="0.8" />
    <circle {...F} cx="18.5" cy="19.5" r="1.6" />
    <circle {...F} cx="25.5" cy="19.5" r="1.6" />
    <circle {...F} cx="18.5" cy="26.5" r="1.6" />
    <circle {...F} cx="25.5" cy="26.5" r="1.6" />
  </svg>
);
// LEMO 2-pin (0B/1B push-pull): slim double shell, two pins.
const svgLemo2 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="12" />
    <circle {...S} cx="22" cy="22" r="8" />
    <circle {...F} cx="18.5" cy="22" r="1.8" />
    <circle {...F} cx="25.5" cy="22" r="1.8" />
  </svg>
);
// Kycon KPP-4P (4-pin power DIN — LED panels, laptops): round shell, flat key, four pins.
const svgKycon4 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="13" />
    <rect {...F} x="18" y="8" width="8" height="3" rx="1" />
    <circle {...F} cx="16.5" cy="19" r="1.9" />
    <circle {...F} cx="27.5" cy="19" r="1.9" />
    <circle {...F} cx="16.5" cy="28" r="1.9" />
    <circle {...F} cx="27.5" cy="28" r="1.9" />
  </svg>
);
// GX12/GX16 aviation (threaded, LED fixtures / e-bikes): thread ring, key, pins on an arc.
const svgGX16 = (
  <svg viewBox="0 0 44 44" aria-hidden>
    <circle {...S} cx="22" cy="22" r="15" />
    <circle {...S} cx="22" cy="22" r="10.5" />
    <rect {...F} x="20.8" y="11" width="2.4" height="3" rx="0.8" />
    <circle {...F} cx="16" cy="24" r="1.9" />
    <circle {...F} cx="22" cy="27.5" r="1.9" />
    <circle {...F} cx="28" cy="24" r="1.9" />
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
  { id: 'C14', label: 'IEC C14', takes: 'C13 cord', group: 'IEC', svg: svgC14 },
  { id: 'C20', label: 'IEC C20', takes: 'C19 cord', group: 'IEC', svg: svgC20 },
  { id: 'C16', label: 'IEC C16', takes: 'C15 cord (hot)', group: 'IEC', svg: svgC16 },
  { id: 'C6', label: 'IEC C6', takes: 'C5 cloverleaf', group: 'IEC', svg: svgC6 },
  { id: 'C8', label: 'IEC C8', takes: 'C7 figure-8', group: 'IEC', svg: svgC8 },
  { id: 'C2', label: 'IEC C2', takes: 'C1 cord', group: 'IEC', svg: svgC2 },
  { id: 'C18', label: 'IEC C18', takes: 'C17 cord (no earth)', group: 'IEC', svg: svgC18 },
  { id: 'C22', label: 'IEC C22', takes: 'C21 cord (hot)', group: 'IEC', svg: svgC22 },
  { id: 'C24', label: 'IEC C24', takes: 'C23 cord (no earth)', group: 'IEC', svg: svgC24 },
  { id: 'powerCON blue', label: 'powerCON in', takes: 'blue powerCON cord', group: 'STAGE', svg: svgPowerconIn },
  { id: 'powerCON TRUE1', label: 'powerCON TRUE1', takes: 'TRUE1 cord', group: 'STAGE', svg: svgTrue1 },
  { id: 'DC 5.5x2.1', label: 'DC jack 5.5×2.1', takes: '5.5×2.1 barrel', group: 'DC', svg: svgBarrel5521 },
  { id: 'DC 5.5x2.5', label: 'DC jack 5.5×2.5', takes: '5.5×2.5 barrel', group: 'DC', svg: svgBarrel5525 },
  { id: 'DC 4.0x1.7', label: 'DC jack 4.0×1.7', takes: '4.0×1.7 barrel', group: 'DC', svg: svgBarrel4017 },
  { id: 'DC 3.5x1.35', label: 'DC jack 3.5×1.35', takes: '3.5×1.35 barrel', group: 'DC', svg: svgBarrel3513 },
  { id: 'DC 2.5x0.7', label: 'DC jack 2.5×0.7', takes: '2.5×0.7 barrel', group: 'DC', svg: svgBarrel2507 },
  { id: 'USB-C', label: 'USB-C', takes: 'USB-C cable (PD)', group: 'DC', svg: svgUsbC },
  { id: 'Micro-USB', label: 'Micro-USB', takes: 'Micro-USB cable', group: 'DC', svg: svgMicroUsb },
  { id: 'Mini-USB', label: 'Mini-USB', takes: 'Mini-USB cable', group: 'DC', svg: svgMiniUsb },
  { id: 'Lightning', label: 'Lightning', takes: 'Lightning cable', group: 'DC', svg: svgLightning },
  { id: 'XLR 4-pin', label: '4-pin XLR', takes: '4-pin XLR DC', group: 'DC', svg: svgXlr4 },
  { id: 'Hirose 4-pin', label: 'Hirose 4-pin', takes: 'HR10 DC cable', group: 'DC', svg: svgHirose4 },
  { id: 'LEMO 2-pin', label: 'LEMO 2-pin', takes: 'LEMO DC cable', group: 'DC', svg: svgLemo2 },
  { id: 'Kycon 4-pin', label: 'Kycon 4-pin', takes: '4-pin DIN DC', group: 'DC', svg: svgKycon4 },
  { id: 'GX16', label: 'GX16 aviation', takes: 'GX16 cable', group: 'DC', svg: svgGX16 },
  { id: 'XT60', label: 'XT60', takes: 'XT60 lead', group: 'DC', svg: svgXT },
  { id: 'Anderson Powerpole', label: 'Powerpole', takes: 'Powerpole lead', group: 'DC', svg: svgPowerpole },
  { id: 'Anderson SB50', label: 'Anderson SB50', takes: 'SB50 lead', group: 'DC', svg: svgAndersonSB },
  // A fixed attached cord — the PLUG it ends in is picked separately (item.fixedPlug, any
  // male plug; defaults from the home warehouse's region; per-serial overrides).
  { id: 'FIXED', label: 'Fixed cord', takes: 'attached plug', group: 'OTHER', svg: svgFixed },
  { id: 'Hardwired', label: 'Hardwired', takes: 'direct / other', group: 'OTHER', svg: svgHardwire },
];

/** Legacy stored inlet values that MEAN "fixed cord" (the pre-FIXED catalog had 'NEMA 5-15P'). */
export function isFixedCordInlet(plugType: string | undefined): boolean {
  const v = String(plugType ?? '').trim();
  return v === 'FIXED' || v === 'NEMA 5-15P';
}

/** A DC inlet — the device runs off a separate PSU/battery, so its AC voltage class doesn't apply. */
export function isDcInlet(plugType: string | undefined): boolean {
  return inletById(String(plugType ?? '').trim())?.group === 'DC';
}

// ── Cable ends (the 'cable' item kind: power strips / extensions / adapters / PSUs) ──────────────
// MALE = the source side (goes into the wall/drop or an upstream device); FEMALE = the outlet side.
// volts/amps describe the END's rating so an adapter self-describes ("NEMA L6-30P 230V 30A →
// NEMA 5-15R 120V 15A" is representable — electricians do crazy things). One face per PATTERN is
// shared by both genders (the grid header says which); the label is authoritative. DC ends carry
// volts 'DC' (+ an optional nominal `dc` text) — an AC male → DC female end pair is a PSU, not a fault.
export interface CableEndDef {
  id: string;
  label: string;
  group: ConnectorGroup;
  volts: VoltFamily | '250' | 'DC';
  amps: number;
  dc?: string;
  /** Industrial ends only: the venue region whose receptacle grid lists this drop. */
  venue?: Region;
  svg: ReactNode;
}

type EndSpec = Omit<CableEndDef, 'group'>;
const grp = (group: ConnectorGroup, ends: EndSpec[]): CableEndDef[] => ends.map((e) => ({ ...e, group }));

// The genderless / same-face DC connectors, listed on both sides.
const DC_COMMON: EndSpec[] = [
  { id: 'DC 5.5x2.1', label: 'Barrel 5.5×2.1', volts: 'DC', amps: 5, svg: svgBarrel5521 },
  { id: 'DC 5.5x2.5', label: 'Barrel 5.5×2.5', volts: 'DC', amps: 5, svg: svgBarrel5525 },
  { id: 'DC 4.0x1.7', label: 'Barrel 4.0×1.7', volts: 'DC', amps: 3, svg: svgBarrel4017 },
  { id: 'DC 3.5x1.35', label: 'Barrel 3.5×1.35', volts: 'DC', amps: 2, svg: svgBarrel3513 },
  { id: 'DC 2.5x0.7', label: 'Barrel 2.5×0.7', volts: 'DC', amps: 1, svg: svgBarrel2507 },
  { id: 'USB-A', label: 'USB-A', volts: 'DC', amps: 3, dc: '5V', svg: svgUsbA },
  { id: 'USB-C', label: 'USB-C (PD)', volts: 'DC', amps: 5, dc: '5–48V', svg: svgUsbC },
  { id: '12V aux', label: '12V aux (cig.)', volts: 'DC', amps: 10, dc: '12V', svg: svgCig12 },
  { id: 'SAE 2-pin', label: 'SAE 2-pin', volts: 'DC', amps: 15, dc: '12V', svg: svgSAE },
  { id: 'Anderson Powerpole', label: 'Powerpole', volts: 'DC', amps: 45, svg: svgPowerpole },
  { id: 'Anderson SB50', label: 'Anderson SB50', volts: 'DC', amps: 50, svg: svgAndersonSB },
  { id: 'XT30', label: 'XT30', volts: 'DC', amps: 30, svg: svgXT },
  { id: 'XT60', label: 'XT60', volts: 'DC', amps: 60, svg: svgXT },
  { id: 'XT90', label: 'XT90', volts: 'DC', amps: 90, svg: svgXT },
  { id: 'XLR 4-pin', label: '4-pin XLR', volts: 'DC', amps: 5, dc: '12–14.4V', svg: svgXlr4 },
  { id: 'D-Tap', label: 'D-Tap', volts: 'DC', amps: 5, dc: '14.4V', svg: svgDTap },
  { id: 'Hirose 4-pin', label: 'Hirose 4-pin', volts: 'DC', amps: 2, svg: svgHirose4 },
  { id: 'LEMO 2-pin', label: 'LEMO 2-pin', volts: 'DC', amps: 10, svg: svgLemo2 },
  { id: 'Kycon 4-pin', label: 'Kycon 4-pin', volts: 'DC', amps: 7, svg: svgKycon4 },
  { id: 'GX16', label: 'GX16 aviation', volts: 'DC', amps: 5, svg: svgGX16 },
];

// 60309 ids are shared by both genders (the pre-expansion convention); `venue` puts them on the
// event receptacle grid.
const IEC60309: EndSpec[] = [
  { id: 'IEC 60309 blue 16A', label: 'CEE 16A (blue)', volts: '230', amps: 16, venue: 'EU', svg: svg60309Blue },
  { id: 'IEC 60309 blue 32A', label: 'CEE 32A (blue)', volts: '230', amps: 32, venue: 'EU', svg: svg60309Blue },
  { id: 'IEC 60309 blue 63A', label: 'CEE 63A (blue)', volts: '230', amps: 63, venue: 'EU', svg: svg60309Blue },
  { id: 'IEC 60309 blue 125A', label: 'CEE 125A (blue)', volts: '230', amps: 125, venue: 'EU', svg: svg60309Blue },
  { id: 'IEC 60309 red 16A', label: 'CEE 16A 3-phase (red)', volts: '230', amps: 16, venue: 'EU', svg: svg60309Red },
  { id: 'IEC 60309 red 32A', label: 'CEE 32A 3-phase (red)', volts: '230', amps: 32, venue: 'EU', svg: svg60309Red },
  { id: 'IEC 60309 red 63A', label: 'CEE 63A 3-phase (red)', volts: '230', amps: 63, venue: 'EU', svg: svg60309Red },
  { id: 'IEC 60309 red 125A', label: 'CEE 125A 3-phase (red)', volts: '230', amps: 125, venue: 'EU', svg: svg60309Red },
  { id: 'IEC 60309 yellow 16A', label: 'CEE 16A 110V (yellow)', volts: '120', amps: 16, venue: 'UK', svg: svg60309Yellow },
  { id: 'IEC 60309 yellow 32A', label: 'CEE 32A 110V (yellow)', volts: '120', amps: 32, venue: 'UK', svg: svg60309Yellow },
  { id: 'Camlock', label: 'Camlock (16 series)', volts: '230', amps: 400, venue: 'NA', svg: svgCamlock },
];

// The NEMA family, P/R suffix applied per side. 10-/14-/L14 carry 120 V legs too, but the 240 V pair
// defines them; L15/L21 are 208/250 V three-phase.
const NEMA: [string, VoltFamily, number, ReactNode][] = [
  ['1-15', '120', 15, svgNema115],
  ['5-15', '120', 15, svgNema515],
  ['5-20', '120', 20, svgNema520],
  ['5-30', '120', 30, svgNemaHeavy],
  ['5-50', '120', 50, svgNemaHeavy],
  ['6-15', '230', 15, svgNema615],
  ['6-20', '230', 20, svgNema620],
  ['6-30', '230', 30, svgNemaHeavy],
  ['6-50', '230', 50, svgNemaHeavy],
  ['10-30', '230', 30, svgNema1030],
  ['10-50', '230', 50, svgNema1050],
  ['14-30', '230', 30, svgNema1430],
  ['14-50', '230', 50, svgNema1450],
  ['14-60', '230', 60, svgNemaHeavy],
  ['L5-15', '120', 15, svgLock],
  ['L5-20', '120', 20, svgLock],
  ['L5-30', '120', 30, svgLock],
  ['L6-15', '230', 15, svgLock],
  ['L6-20', '230', 20, svgLock],
  ['L6-30', '230', 30, svgLock],
  ['L14-20', '230', 20, svgLock],
  ['L14-30', '230', 30, svgLock],
  ['L15-20', '230', 20, svgLock],
  ['L15-30', '230', 30, svgLock],
  ['L21-20', '230', 20, svgLock],
  ['L21-30', '230', 30, svgLock],
];
const nemaEnds = (suffix: 'P' | 'R'): EndSpec[] => [
  ...NEMA.map(([n, volts, amps, svg]) => {
    const id = `NEMA ${n}${suffix}`;
    const note = n === '1-15' ? ' (2-prong)' : n.startsWith('L15') || n.startsWith('L21') ? ' (3-phase)' : '';
    return { id, label: `${id}${note}`, volts, amps, svg };
  }),
  { id: `TT-30${suffix}`, label: `TT-30${suffix} (RV)`, volts: '120', amps: 30, svg: svgTT30 },
];

// The country-specific wall types — ids take a P/R suffix per side.
const WORLD_TYPES: [string, string, number, ReactNode][] = [
  ['SEV 1011', 'SEV 1011 (Swiss)', 10, svgSEV1011],
  ['CEI 23-50', 'CEI 23-50 (Italy)', 16, svgCEI2350],
  ['DS 60884-2-D1', 'Danish (Type K)', 13, svgDanish],
  ['SI 32', 'SI 32 (Israel)', 16, svgSI32],
  ['BS 546 5A', 'BS 546 5A (India)', 5, svgBS546],
  ['BS 546 15A', 'BS 546 15A (S. Africa)', 15, svgBS546],
  ['NBR 14136', 'NBR 14136 (Brazil / S. Africa)', 10, svgNBR14136],
  ['TIS 166-2549', 'TIS 166 (Thailand)', 16, svgTIS166],
];
const worldEnds = (suffix: 'P' | 'R'): EndSpec[] =>
  WORLD_TYPES.map(([id, label, amps, svg]) => ({ id: `${id}${suffix}`, label, volts: '230', amps, svg }));

export const CABLE_MALE_ENDS: CableEndDef[] = [
  ...grp('NA', nemaEnds('P')),
  ...grp('EU', [
    { id: 'CEE 7/7', label: 'CEE 7/7 (Schuko)', volts: '230', amps: 16, svg: svgSchuko },
    { id: 'CEE 7/16', label: 'Europlug CEE 7/16', volts: '230', amps: 2.5, svg: svgEuroplug },
    { id: 'CEE 7/17', label: 'CEE 7/17 (contour)', volts: '230', amps: 16, svg: svgCEE717 },
  ]),
  ...grp('UK', [
    { id: 'BS 1363P', label: 'BS 1363 (UK)', volts: '230', amps: 13, svg: svgBS1363 },
    { id: 'BS 4573P', label: 'BS 4573 shaver', volts: '230', amps: 0.2, svg: svgBS4573 },
  ]),
  ...grp('AU', [{ id: 'AS/NZS 3112P', label: 'AS/NZS 3112 (Type I)', volts: '230', amps: 10, svg: svgAS3112 }]),
  ...grp('WORLD', worldEnds('P')),
  ...grp('INDUSTRIAL', IEC60309),
  ...grp('IEC', [
    { id: 'C14', label: 'IEC C14 (inline)', volts: '250', amps: 10, svg: svgC14 },
    { id: 'C20', label: 'IEC C20 (inline)', volts: '250', amps: 16, svg: svgC20 },
    { id: 'C16', label: 'IEC C16 (inline)', volts: '250', amps: 10, svg: svgC16 },
    { id: 'C22', label: 'IEC C22 (inline)', volts: '250', amps: 16, svg: svgC22 },
    { id: 'C18', label: 'IEC C18 (inline)', volts: '250', amps: 10, svg: svgC18 },
    { id: 'C24', label: 'IEC C24 (inline)', volts: '250', amps: 16, svg: svgC24 },
    { id: 'C8', label: 'IEC C8 (inline)', volts: '250', amps: 2.5, svg: svgC8 },
    { id: 'C6', label: 'IEC C6 (inline)', volts: '250', amps: 2.5, svg: svgC6 },
    { id: 'C2', label: 'IEC C2 (inline)', volts: '250', amps: 0.2, svg: svgC2 },
  ]),
  ...grp('STAGE', [
    { id: 'powerCON grey', label: 'powerCON out (grey)', volts: '250', amps: 20, svg: svgPowerconOut },
    { id: 'powerCON TRUE1', label: 'powerCON TRUE1', volts: '250', amps: 16, svg: svgTrue1 },
    { id: 'Socapex 19-pin', label: 'Socapex 19-pin', volts: '250', amps: 20, svg: svgSocapex },
  ]),
  ...grp('DC', [
    ...DC_COMMON,
    { id: 'Micro-USB', label: 'Micro-USB', volts: 'DC', amps: 1.8, dc: '5V', svg: svgMicroUsb },
    { id: 'Mini-USB', label: 'Mini-USB', volts: 'DC', amps: 0.5, dc: '5V', svg: svgMiniUsb },
    { id: 'Lightning', label: 'Lightning', volts: 'DC', amps: 2.4, dc: '5V', svg: svgLightning },
  ]),
];

export const CABLE_FEMALE_ENDS: CableEndDef[] = [
  ...grp('NA', nemaEnds('R')),
  ...grp('EU', [
    { id: 'Schuko CEE 7/3', label: 'Schuko CEE 7/3', volts: '230', amps: 16, svg: svgSchuko },
    { id: 'CEE 7/5', label: 'French CEE 7/5', volts: '230', amps: 16, svg: svgFrench },
  ]),
  ...grp('UK', [
    { id: 'BS 1363R', label: 'BS 1363 (UK)', volts: '230', amps: 13, svg: svgBS1363 },
    { id: 'BS 4573R', label: 'BS 4573 shaver', volts: '230', amps: 0.2, svg: svgBS4573 },
  ]),
  ...grp('AU', [{ id: 'AS/NZS 3112R', label: 'AS/NZS 3112 (Type I)', volts: '230', amps: 10, svg: svgAS3112 }]),
  ...grp('WORLD', worldEnds('R')),
  ...grp('INDUSTRIAL', IEC60309),
  ...grp('IEC', [
    { id: 'C13', label: 'IEC C13', volts: '250', amps: 10, svg: svgC14 },
    { id: 'C15', label: 'IEC C15 (hot)', volts: '250', amps: 10, svg: svgC16 },
    { id: 'C19', label: 'IEC C19', volts: '250', amps: 16, svg: svgC20 },
    { id: 'C21', label: 'IEC C21 (hot)', volts: '250', amps: 16, svg: svgC22 },
    { id: 'C17', label: 'IEC C17 (no earth)', volts: '250', amps: 10, svg: svgC18 },
    { id: 'C23', label: 'IEC C23 (no earth)', volts: '250', amps: 16, svg: svgC24 },
    { id: 'C5', label: 'IEC C5', volts: '250', amps: 2.5, svg: svgC6 },
    { id: 'C7', label: 'IEC C7', volts: '250', amps: 2.5, svg: svgC8 },
    { id: 'C1', label: 'IEC C1', volts: '250', amps: 0.2, svg: svgC2 },
  ]),
  ...grp('STAGE', [
    { id: 'powerCON blue', label: 'powerCON in (blue)', volts: '250', amps: 20, svg: svgPowerconIn },
    { id: 'powerCON TRUE1', label: 'powerCON TRUE1', volts: '250', amps: 16, svg: svgTrue1 },
    { id: 'Socapex 19-pin', label: 'Socapex 19-pin', volts: '250', amps: 20, svg: svgSocapex },
  ]),
  ...grp('DC', DC_COMMON),
];

export function cableEndById(id: string, side: 'male' | 'female'): CableEndDef | undefined {
  return (side === 'male' ? CABLE_MALE_ENDS : CABLE_FEMALE_ENDS).find((e) => e.id === id);
}

/** What a FIXED cord can end in: any male end except the inline IEC couplers (a cord doesn't end
 *  in a C14). Named for the original wall-plug-only list. */
export const WALL_PLUGS: CableEndDef[] = CABLE_MALE_ENDS.filter((e) => e.group !== 'IEC');

/** The region's everyday wall plug — the fixed-cord dropdown's default. */
export const REGION_DEFAULT_PLUG: Record<Region, string> = {
  NA: 'NEMA 5-15P',
  EU: 'CEE 7/7',
  UK: 'BS 1363P',
  AU: 'AS/NZS 3112P',
};

/** A cable end's short rating text — '120V 15A' (the cursed-adapter display); DC ends read '5V DC 3A'. */
export function cableEndRating(end: CableEndDef): string {
  if (end.volts === 'DC') return `${end.dc ? `${end.dc} ` : ''}DC ${end.amps}A`;
  const v = end.volts === '120' ? '120V' : end.volts === '230' ? '230/240V' : '≤250V';
  return `${v} ${end.amps}A`;
}

/** A TRUE mains-voltage mismatch between two cable ends — only a fixed 120 V end against a fixed
 *  230 V end. The IEC '250' couplers (C13/C19/…) are rated UP TO 250 V but carry whatever the source
 *  supplies, so they're voltage-agnostic and never trigger the cross-voltage warning (a US PDU with
 *  C13 outlets is normal, not a transformer). AC → DC is a power supply, so 'DC' never flags either. */
export function cableEndsCrossVoltage(a: CableEndDef | undefined, b: CableEndDef | undefined): boolean {
  if (!a || !b) return false;
  return (a.volts === '120' && b.volts === '230') || (a.volts === '230' && b.volts === '120');
}

// ── Venue receptacles (the event power-drop grid) — derived from the female wall + industrial ends.
// BS 1363 / AS/NZS 3112 were stored without the R suffix before cable ends existed; keep those ids.
const LEGACY_RECEPTACLE_ID: Record<string, string> = { 'BS 1363R': 'BS 1363', 'AS/NZS 3112R': 'AS/NZS 3112' };
const VENUE_GROUPS: ConnectorGroup[] = ['NA', 'EU', 'UK', 'AU', 'WORLD'];

export const RECEPTACLES: ReceptacleDef[] = CABLE_FEMALE_ENDS.flatMap((e): ReceptacleDef[] => {
  const region = e.venue ?? (VENUE_GROUPS.includes(e.group) ? (e.group as ReceptacleGroup) : null);
  if (!region || e.id === 'BS 4573R' || (e.volts !== '120' && e.volts !== '230')) return [];
  return [{ id: LEGACY_RECEPTACLE_ID[e.id] ?? e.id, label: e.label, region, volts: e.volts, amps: e.amps, svg: e.svg }];
});

/** The everyday receptacles a crew should expect at a venue in each region (the destination hint). */
const LOCAL_RECEPTACLES: Record<Region, string[]> = {
  NA: ['NEMA 5-15R', 'NEMA 5-20R'],
  EU: ['Schuko CEE 7/3', 'CEE 7/5', 'IEC 60309 blue 16A'],
  UK: ['BS 1363', 'IEC 60309 blue 16A'],
  AU: ['AS/NZS 3112'],
};

export const REGION_LABEL: Record<ReceptacleGroup, string> = {
  NA: 'North America',
  EU: 'Europe (Schuko / French)',
  UK: 'United Kingdom',
  AU: 'Australia / NZ',
  WORLD: 'Other countries',
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
  const volts: VoltFamily = region === 'NA' ? '120' : '230';
  return {
    volts,
    mains: region === 'NA' ? '120 V (240 V available on NEMA 6-x drops)' : '230 V',
    receptacles: LOCAL_RECEPTACLES[region].flatMap((id) => receptacleById(id) ?? []),
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
