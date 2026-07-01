import 'server-only';
import { type Filter } from 'mongodb';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { flightAwareKey } from '@/lib/integrations/integrations';
import { fetchFlight, type FlightLeg } from '@/lib/integrations/flight';
import { createFlightAlert } from '@/lib/views/notifications';
import type { EventDoc, EventPayload, TravelLeg } from '@/lib/types/types';

// lib/integrations/flight-refresh.ts — the background flight auto-refresh sweep.
//
// Runs as the SYSTEM (no user session) on a timer (instrumentation.ts). Each sweep scans live events
// for flight legs (mode=flight, with a number) in the day-before/day-of window, re-queries FlightAware
// on a per-leg cadence, updates the leg's live status/delay, and on a NEW delay/cancellation notifies
// the event lead + the traveler.
//
// SPEND CONTROL: FlightAware AeroAPI bills per query against a monthly credit (the personal tier's
// free allowance is ~$5 ≈ 1000 /flights calls a month). The per-leg cadences below are the real
// limiter (a fully-tracked leg costs ~a dozen calls); a DAILY call cap is the backstop so a bug or a
// roster explosion can never run the credit dry in a day. (The old AeroDataBox unit-budget governor
// is gone with AeroDataBox itself.)
//
// Correctness guards (from the red-team): the leg is written by ARRAY INDEX with an email-at-index
// filter (no $[s] fan-out that would clobber a duplicate-email sibling, and TOCTOU-safe); the
// provider query date is the IMMUTABLE flightDate (a delay across local midnight can't shift it); the
// window is anchored on the offset-clean departUtc (a far-timezone leg isn't dropped early); departAt/
// arriveAt are overwritten only on a real (delay-driven) change so a hand-edited time isn't clobbered;
// lastCheckedAt is advanced even when the data write fails so a stuck write can't re-burn the call.

const WINDOW_AHEAD_H = 36; // start polling ~a day and a half out (covers "the day before")
const WINDOW_BEHIND_H = 6; // keep polling a few hours past departure (catch a late delay) — when departUtc known
const WINDOW_BEHIND_UNKNOWN_H = 18; // wider behind-window until the first lookup stamps departUtc (absorb tz skew)
const DAYOF_H = 12; // within this many hours of departure = "day of" cadence
const FINAL_WINDOW_H = 3; // within this many hours of departure = "final approach" — delays surface here
const RECHECK_DAYBEFORE_H = 12; // day-before: re-poll at most every 12h (≈ twice)
const RECHECK_DAYOF_H = 3; // day-of: re-poll every ~3h
const RECHECK_FINAL_H = 0.4; // final window: re-poll ~every 24min so a late delay is caught before wheels-up
const NOTIFY_MIN = 15; // alert when delayed ≥ this, or the delay GROWS by ≥ this
const MAX_CALLS = 20; // per-sweep backstop
const DAILY_CALL_CAP = 40; // per-UTC-day backstop (~½ the monthly credit even if hit every single day)

const TERMINAL_EVENT_STATES = new Set(['closed', 'complete', 'cancelled', 'canceled']);
// A leg REF is a dotted path under staffer.travel: the primary legs plus any connection legs (the
// multi-leg journeys — 'outboundConnections.0' etc). Used verbatim in the $set write path + the alert
// dedup key, so every leg of a journey tracks independently.
type LegKey = string;

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

// Module-level daily spend counter (persists across sweeps in the server process; a restart resets it,
// which only ever errs on the side of a few extra calls that day).
let _callDayKey = '';
let _callsToday = 0;
function spendDailyCall(now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== _callDayKey) {
    _callDayKey = day;
    _callsToday = 0;
  }
  if (_callsToday >= DAILY_CALL_CAP) return false;
  _callsToday++;
  return true;
}

/** Resolve the event LEAD's email (lead may be stored as an email or a staffer display name). */
function leadEmail(payload: EventPayload): string {
  const lead = String(payload.lead ?? '').trim();
  if (!lead) return '';
  if (lead.includes('@')) return lc(lead);
  for (const s of payload.staff ?? []) {
    if ((s?.name ?? '').trim() === lead || (s?.email ?? '').trim() === lead) return lc(s?.email);
  }
  return '';
}

interface DueLeg {
  eventId: string;
  staffIdx: number;
  staffEmail: string; // lower-cased — notification recipient + dedup
  staffEmailRaw: string; // value as stored — the email-at-index filter match
  payload: EventPayload;
  legKey: LegKey;
  leg: TravelLeg;
  number: string;
  date: string; // YYYY-MM-DD — the IMMUTABLE flightDate (else the leg's current departAt date)
  depMs: number; // best available departure instant (departUtc when known) — for window + urgency sort
}

export interface FlightRefreshResult {
  checked: number;
  updated: number;
  alerts: number;
  calls: number;
  reason?: string;
}

export async function runFlightRefresh(opts: { now?: number; maxCalls?: number } = {}): Promise<FlightRefreshResult> {
  const faKey = await flightAwareKey();
  if (!faKey) return { checked: 0, updated: 0, alerts: 0, calls: 0, reason: 'no-key' };

  const now = opts.now ?? Date.now();
  const maxCalls = opts.maxCalls ?? MAX_CALLS;
  const db = await getDb();
  const eventsCol = db.collection<EventDoc>('events');
  const events = await eventsCol.find(NOT_DELETED).toArray();

  // ── 1) Gather the DUE legs ───────────────────────────────────────────────────────────────────────
  const due: DueLeg[] = [];
  for (const ev of events) {
    const payload = ev.payload || ({} as EventPayload);
    if (TERMINAL_EVENT_STATES.has(String(payload.state))) continue;
    const staff = Array.isArray(payload.staff) ? payload.staff : [];
    staff.forEach((s, idx) => {
      const emailRaw = String(s?.email ?? '');
      const email = lc(emailRaw);
      if (!email) return; // need an email to filter the write + notify
      const t = s?.travel;
      if (!t || t.mode !== 'flight') return;
      // Every leg of the journey: the primary outbound/return plus any connection legs, each with its
      // own ref (= the dotted write path under travel.*), so a delayed CONNECTION alerts too.
      const legRefs: { legKey: LegKey; leg: TravelLeg | undefined }[] = [
        { legKey: 'outbound', leg: t.outbound },
        ...(Array.isArray(t.outboundConnections)
          ? t.outboundConnections.map((lg, i) => ({ legKey: `outboundConnections.${i}`, leg: lg }))
          : []),
        { legKey: 'return', leg: t.return },
        ...(Array.isArray(t.returnConnections)
          ? t.returnConnections.map((lg, i) => ({ legKey: `returnConnections.${i}`, leg: lg }))
          : []),
      ];
      for (const { legKey, leg } of legRefs) {
        if (!leg) continue;
        const number = String(leg.number ?? '').trim();
        const departAt = String(leg.departAt ?? '').trim();
        if (!number || !departAt) continue;
        if (leg.status === 'arrived') continue; // landed — done tracking
        const hasUtc = typeof leg.departUtc === 'number' && Number.isFinite(leg.departUtc);
        const depMs = hasUtc ? (leg.departUtc as number) : Date.parse(departAt);
        if (Number.isNaN(depMs)) continue;
        const hToDep = (depMs - now) / 3_600_000;
        const behindH = hasUtc ? WINDOW_BEHIND_H : WINDOW_BEHIND_UNKNOWN_H;
        if (hToDep > WINDOW_AHEAD_H || hToDep < -behindH) continue;
        const last = Number(leg.lastCheckedAt ?? 0);
        // Three cadences: sparse day-before, moderate day-of, tight in the final approach (where a
        // delay actually surfaces).
        const recheckH =
          hToDep <= FINAL_WINDOW_H ? RECHECK_FINAL_H : hToDep <= DAYOF_H ? RECHECK_DAYOF_H : RECHECK_DAYBEFORE_H;
        if (last && now - last < recheckH * 3_600_000) continue;
        due.push({
          eventId: ev._id,
          staffIdx: idx,
          staffEmail: email,
          staffEmailRaw: emailRaw,
          payload,
          legKey,
          leg,
          number,
          date: String(leg.flightDate || departAt.slice(0, 10)),
          depMs,
        });
      }
    });
  }
  if (due.length === 0) return { checked: 0, updated: 0, alerts: 0, calls: 0, reason: 'none-due' };

  // PRIORITIZE the most imminent departures — scarce budget goes to the soonest flights first.
  due.sort((a, b) => a.depMs - b.depMs);

  // ── 2) Refresh, governed by the live quota ───────────────────────────────────────────────────────
  const cache = new Map<string, FlightLeg | null>(); // dedupe identical number+date within a sweep (free reuse)
  let checked = 0;
  let updated = 0;
  let alerts = 0;
  let calls = 0;

  for (const d of due) {
    const ck = `${d.number}|${d.date}`;
    const cached = cache.has(ck);
    if (!cached) {
      if (calls >= maxCalls) break; // per-sweep backstop
      // Daily cap — due is urgency-sorted, so when the cap bites, the soonest flights got the calls.
      if (!spendDailyCall(now)) break;
    }
    checked++;

    let looked: FlightLeg | null;
    if (cached) {
      looked = cache.get(ck) ?? null;
    } else {
      let r;
      try {
        r = await fetchFlight(d.number, d.date);
      } catch {
        r = { available: true as const, leg: null };
      }
      calls++;
      if (!r.available) break; // key vanished mid-sweep
      looked = r.leg ?? null;
      cache.set(ck, looked);
    }

    const path = `payload.staff.${d.staffIdx}.travel.${d.legKey}`;
    const set: Record<string, unknown> = { [`${path}.lastCheckedAt`]: now, updatedAt: now };
    let alertStatus = '';
    let alertDelay = 0;

    if (looked) {
      const prevStatus = String(d.leg?.status ?? '');
      const prevDelay = Number(d.leg?.delayMin ?? 0);
      // Capture the immutable query anchors once / keep departUtc fresh.
      if (!d.leg?.flightDate && looked.scheduledDate) set[`${path}.flightDate`] = looked.scheduledDate;
      if (looked.departUtc != null) set[`${path}.departUtc`] = looked.departUtc;
      // Live-progress anchors (the OpenSky callsign + the best actual/estimated instants).
      if (looked.identIcao) set[`${path}.identIcao`] = looked.identIcao;
      if (looked.departActualUtc != null) set[`${path}.departActualUtc`] = looked.departActualUtc;
      if (looked.arriveEstUtc != null) set[`${path}.arriveEstUtc`] = looked.arriveEstUtc;
      // Fill blanks only — never clobber a present carrier/location.
      if (looked.carrier && !d.leg?.carrier) set[`${path}.carrier`] = looked.carrier;
      if (looked.departLocation && !d.leg?.departLocation) set[`${path}.departLocation`] = looked.departLocation;
      if (looked.arriveLocation && !d.leg?.arriveLocation) set[`${path}.arriveLocation`] = looked.arriveLocation;
      // Overwrite the TIMES only on a real (delay-driven) change, or when blank — never clobber a
      // hand-edited time on an on-time refresh.
      const delayDriven = looked.delayMin > 0 || looked.status === 'cancelled' || looked.status === 'diverted';
      if (looked.departAt && (delayDriven || !d.leg?.departAt)) set[`${path}.departAt`] = looked.departAt;
      if (looked.arriveAt && (delayDriven || !d.leg?.arriveAt)) set[`${path}.arriveAt`] = looked.arriveAt;
      set[`${path}.status`] = looked.status;
      set[`${path}.delayMin`] = looked.delayMin;

      const newlyCancelled = looked.status === 'cancelled' && prevStatus !== 'cancelled';
      const newlyDelayed =
        looked.status === 'delayed' &&
        looked.delayMin >= NOTIFY_MIN &&
        (prevStatus !== 'delayed' || looked.delayMin - prevDelay >= NOTIFY_MIN);
      if (newlyCancelled || newlyDelayed) {
        alertStatus = looked.status;
        alertDelay = looked.delayMin;
      }
    }

    // Write by INDEX, filtered on the email AT that index (targets exactly this staffer's leg, no $[s]
    // fan-out across duplicate emails) AND on the flight number still present AT the leg path — so a
    // concurrent edit that shifted the roster, changed the flight, or REMOVED a connection leg makes
    // the write a clean no-op instead of stamping stale status (or, for a deleted connections array,
    // materializing an object where an array belongs via the dotted index path).
    const filter = {
      _id: d.eventId,
      ...NOT_DELETED,
      [`payload.staff.${d.staffIdx}.email`]: d.staffEmailRaw,
      [`payload.staff.${d.staffIdx}.travel.${d.legKey}.number`]: d.leg.number,
    } as unknown as Filter<EventDoc>;
    try {
      const res = await eventsCol.updateOne(filter, { $set: set });
      if (res.matchedCount === 0) {
        // Roster changed under us — the fresh read next sweep gets the right index; don't loop-burn here.
        console.warn(`[flight-refresh] no leg match: ${d.eventId} staff[${d.staffIdx}] ${d.legKey} — retrying next sweep`);
        continue;
      }
      if (looked) updated++;
    } catch (e) {
      console.warn(`[flight-refresh] write failed: ${d.eventId} ${d.legKey}:`, e instanceof Error ? e.message : e);
      // Best-effort: advance the cadence clock so a persistently-failing data write can't re-burn the call.
      try {
        await eventsCol.updateOne(filter, { $set: { [`${path}.lastCheckedAt`]: now } });
      } catch {
        /* give up — next sweep retries */
      }
      continue;
    }

    if (alertStatus) {
      const recipients = new Set<string>([d.staffEmail, leadEmail(d.payload)].filter(Boolean) as string[]);
      for (const to of recipients) {
        try {
          await createFlightAlert(to, {
            eventId: d.eventId,
            eventName: d.payload.name,
            subjectEmail: d.staffEmail,
            flightNumber: d.number,
            leg: d.legKey,
            status: alertStatus,
            delayMin: alertDelay,
          });
          alerts++;
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return { checked, updated, alerts, calls };
}
