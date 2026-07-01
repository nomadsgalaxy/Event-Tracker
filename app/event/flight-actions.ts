'use server';

import { requireUser } from '@/lib/auth/auth';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { fetchFlight, type FlightFetchResult } from '@/lib/integrations/flight';
import { fetchAircraftState, openskyConfigured } from '@/lib/integrations/opensky';
import { canSeeStaffPii } from '@/lib/views/event-view';
import { activeGrantsFor } from '@/lib/auth/grants';
import type { EventDoc, TravelLeg } from '@/lib/types/types';

// app/event/flight-actions.ts — the editor's "Look up flight" + the Travel tab's live flight-progress
// Server Actions. The provider calls + normalization live in lib/integrations (shared with the
// background auto-refresh); these wrappers add the auth gates. Keys never reach the browser.

// Re-exported so the editor keeps importing the leg type from here (back-compat).
export type { FlightLeg } from '@/lib/integrations/flight';

export async function lookupFlightAction(rawNumber: string, rawDate: string): Promise<FlightFetchResult> {
  try {
    await requireUser(); // signed-in only — don't let anon burn the shared rate limit
  } catch {
    return { available: false, error: 'Sign in to look up flights.' };
  }
  return fetchFlight(rawNumber, rawDate);
}

// ── Live flight progress (OpenSky) ────────────────────────────────────────────────────────────────
export interface FlightProgressState {
  ok: boolean;
  /** OpenSky isn't configured — the widget renders nothing. */
  unavailable?: boolean;
  error?: string;
  phase?: 'pre' | 'enroute' | 'landed';
  /** 0..100 time-based progress (actual departure → estimated arrival), when both anchors known. */
  pct?: number | null;
  /** Live ADS-B state, when the aircraft is currently transmitting. */
  live?: {
    lat: number;
    lng: number;
    altitudeFt: number | null;
    speedKts: number | null;
    onGround: boolean;
    ageS: number;
  } | null;
  /** Why live is null: 'pending-ident' = the ICAO callsign isn't stamped yet (first status refresh
   *  hasn't run); 'coverage' = looked, no transmitting aircraft matched. */
  liveNote?: 'pending-ident' | 'coverage';
  flightNumber?: string;
  checkedAt?: number;
}

const lcs = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/**
 * Live progress for ONE staffer's flight leg. AUTHZ mirrors the travel-PII rule exactly (manager+ /
 * self / lead-of-this-event, judged on the STORED event): the flight number/ident is travel PII, so
 * the viewer must be allowed to see the leg to see its progress. All inputs re-resolved server-side.
 */
export async function flightProgressAction(
  eventId: string,
  staffEmail: string,
  // 'outbound' | 'return' | a connection ref like 'outboundConnections.0' (multi-leg journeys).
  legKey: string
): Promise<FlightProgressState> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: 'Sign in to view flight progress.' };
  }
  const id = String(eventId ?? '').trim();
  const email = lcs(staffEmail);
  const legRef = /^(outbound|return)$/.exec(String(legKey))
    ? { dir: String(legKey) as 'outbound' | 'return', conn: -1 }
    : (() => {
        const m = /^(outbound|return)Connections\.(\d{1,2})$/.exec(String(legKey));
        return m ? { dir: m[1] as 'outbound' | 'return', conn: Number(m[2]) } : null;
      })();
  if (!id || !email || !legRef) return { ok: false, error: 'Bad request.' };

  const db = await getDb();
  const ev = await db.collection<EventDoc>('events').findOne({ _id: id, ...NOT_DELETED });
  if (!ev) return { ok: false, error: 'Event not found.' };
  const payload = ev.payload ?? {};
  const staffer = (payload.staff ?? []).find((s) => lcs(s?.email) === email);
  if (!staffer) return { ok: false, error: 'Staffer not on this event.' };

  // The travel-PII gate — the SAME evaluation that strips legs from the detail payload
  // (canSeeStaffPii: manager+ / self / lead-of-event / an active #167 travel-data grant), so a
  // viewer who can see the leg can always see its progress, and nobody else can.
  const grants = await activeGrantsFor(user.email).catch(() => new Set<string>());
  if (!canSeeStaffPii(staffer, payload, user.email, user.role, grants, id)) {
    return { ok: false, error: 'Not authorized.' };
  }

  const travel = staffer.travel;
  const leg: TravelLeg | undefined =
    travel?.mode === 'flight'
      ? legRef.conn < 0
        ? travel?.[legRef.dir]
        : (Array.isArray(travel?.[`${legRef.dir}Connections`]) ? (travel[`${legRef.dir}Connections`] as TravelLeg[]) : [])[legRef.conn]
      : undefined;
  if (!leg || !leg.number) return { ok: false, error: 'No flight on this leg.' };

  if (!(await openskyConfigured())) return { ok: true, unavailable: true };

  const now = Date.now();
  const depMs = Number(leg.departActualUtc ?? leg.departUtc ?? NaN);
  const arrMs = Number(leg.arriveEstUtc ?? NaN);
  let phase: 'pre' | 'enroute' | 'landed' = 'enroute';
  if (Number.isFinite(depMs) && now < depMs) phase = 'pre';
  else if (leg.status === 'arrived' || (Number.isFinite(arrMs) && now > arrMs + 30 * 60_000)) phase = 'landed';

  // Time-based progress when both anchors are known (independent of ADS-B coverage).
  let pct: number | null = null;
  if (phase === 'enroute' && Number.isFinite(depMs) && Number.isFinite(arrMs) && arrMs > depMs) {
    pct = Math.min(100, Math.max(0, Math.round(((now - depMs) / (arrMs - depMs)) * 100)));
  }

  // Live ADS-B state — only worth the pull while plausibly in the air, and only with the REAL ICAO
  // callsign (the IATA flight number never matches OpenSky's ATC callsigns — AA1691 vs AAL1691 — so
  // without identIcao we skip the pull rather than show a misleading "no coverage").
  let live: FlightProgressState['live'] = null;
  let liveNote: FlightProgressState['liveNote'];
  if (phase === 'enroute') {
    const callsign = String(leg.identIcao || '').toUpperCase().replace(/\s+/g, '');
    if (!callsign) {
      liveNote = 'pending-ident';
    } else {
      const st = await fetchAircraftState(callsign);
      if (st && st.lat != null && st.lng != null) {
        live = {
          lat: st.lat,
          lng: st.lng,
          altitudeFt: st.altitudeM != null ? Math.round(st.altitudeM * 3.28084) : null,
          speedKts: st.velocityMs != null ? Math.round(st.velocityMs * 1.94384) : null,
          onGround: st.onGround,
          ageS: st.lastContactAgeS,
        };
      } else {
        liveNote = 'coverage';
      }
    }
  }

  return { ok: true, phase, pct, live, liveNote, flightNumber: String(leg.number), checkedAt: now };
}
