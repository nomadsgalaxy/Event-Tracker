import 'server-only';
import { type Filter } from 'mongodb';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { flightApiKey } from '@/lib/integrations/integrations';
import { fetchFlight, getFlightQuota, type FlightLeg } from '@/lib/integrations/flight';
import { createFlightAlert } from '@/lib/views/notifications';
import type { EventDoc, EventPayload, TravelLeg } from '@/lib/types/types';

// lib/integrations/flight-refresh.ts — the background flight auto-refresh sweep.
//
// Runs as the SYSTEM (no user session) on a timer (instrumentation.ts). Each sweep scans live events
// for flight legs (mode=flight, with a number) in the day-before/day-of window, re-queries AeroDataBox
// on a per-leg cadence, updates the leg's live status/delay, and on a NEW delay/cancellation notifies
// the event lead + the traveler.
//
// QUOTA GOVERNOR: AeroDataBox's free tier is api-units-capped (e.g. 600 units / ~month). fetchFlight
// records the live `x-ratelimit-api-units-remaining/-limit/-reset` headers; this sweep reads that state
// and PACES calls to a sustainable rate (remaining ÷ time-to-reset), keeping a reserve and stopping
// entirely when the budget is spent — and PRIORITIZES the most imminent departures when the budget is
// tight. Ample quota → calls flow at the full cadence; low quota → only the soonest flights, spaced out.
//
// Correctness guards (from the red-team): the leg is written by ARRAY INDEX with an email-at-index
// filter (no $[s] fan-out that would clobber a duplicate-email sibling, and TOCTOU-safe); the
// AeroDataBox query date is the IMMUTABLE flightDate (a delay across local midnight can't shift it); the
// window is anchored on the offset-clean departUtc (a far-timezone leg isn't dropped early); departAt/
// arriveAt are overwritten only on a real (delay-driven) change so a hand-edited time isn't clobbered;
// lastCheckedAt is advanced even when the data write fails so a stuck write can't re-burn the call.

const WINDOW_AHEAD_H = 36; // start polling ~a day and a half out (covers "the day before")
const WINDOW_BEHIND_H = 6; // keep polling a few hours past departure (catch a late delay) — when departUtc known
const WINDOW_BEHIND_UNKNOWN_H = 18; // wider behind-window until the first lookup stamps departUtc (absorb tz skew)
const DAYOF_H = 12; // within this many hours of departure = "day of" cadence
const FINAL_WINDOW_H = 3; // within this many hours of departure = "final approach" — delays surface here
const RECHECK_DAYBEFORE_H = 12; // day-before: re-poll at most every 12h (≈ twice)
const RECHECK_DAYOF_H = 3; // day-of: re-poll every ~3h (when quota allows)
const RECHECK_FINAL_H = 0.4; // final window: re-poll ~every 24min so a late delay is caught before wheels-up
const MAX_IMMINENT_PER_SWEEP = 4; // cap the per-sweep burst on imminent flights (reserve + hard stop still apply)
const NOTIFY_MIN = 15; // alert when delayed ≥ this, or the delay GROWS by ≥ this
const MAX_CALLS = 60; // hard per-sweep backstop (the governor is the real limiter)
const RESERVE_UNITS = 30; // never auto-spend the budget below this (leaves room for manual lookups)
const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000; // pacing before the quota header is known (bootstrap)
const MIN_INTERVAL_FLOOR_MS = 60_000; // never call faster than 1/min even with ample quota

const TERMINAL_EVENT_STATES = new Set(['closed', 'complete', 'cancelled', 'canceled']);
const LEG_KEYS = ['outbound', 'return'] as const;
type LegKey = (typeof LEG_KEYS)[number];

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

// Module-level pacing clock — persists across sweeps in the server process (the governor's rate limiter).
let _lastCallAt = 0;

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

// The minimum interval between NEW AeroDataBox calls so the remaining unit budget lasts until reset.
// Infinity → budget exhausted (stop). Returns a conservative default until the first header is seen.
function minCallIntervalMs(now: number): number {
  const q = getFlightQuota();
  if (!q) return DEFAULT_MIN_INTERVAL_MS;
  const budget = q.remaining - RESERVE_UNITS;
  if (budget <= 0) return Infinity;
  const msToReset = Math.max(q.resetAt - now, 60 * 60_000);
  const affordableCalls = budget / Math.max(1, q.unitsPerCall);
  return Math.max(MIN_INTERVAL_FLOOR_MS, msToReset / affordableCalls);
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
  imminent: boolean; // within FINAL_WINDOW_H of departure — checked aggressively (bypasses the budget pace)
}

export interface FlightRefreshResult {
  checked: number;
  updated: number;
  alerts: number;
  calls: number;
  reason?: string;
}

export async function runFlightRefresh(opts: { now?: number; maxCalls?: number } = {}): Promise<FlightRefreshResult> {
  const key = await flightApiKey();
  if (!key) return { checked: 0, updated: 0, alerts: 0, calls: 0, reason: 'no-key' };

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
      for (const legKey of LEG_KEYS) {
        const leg = t[legKey];
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
        // delay actually surfaces). "imminent" legs are exempt from the slow monthly budget pace below.
        const imminent = hToDep <= FINAL_WINDOW_H;
        const recheckH = imminent ? RECHECK_FINAL_H : hToDep <= DAYOF_H ? RECHECK_DAYOF_H : RECHECK_DAYBEFORE_H;
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
          imminent,
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
  let imminentCalls = 0; // per-sweep burst counter for near-departure flights

  for (const d of due) {
    const ck = `${d.number}|${d.date}`;
    const cached = cache.has(ck);
    if (!cached) {
      if (calls >= maxCalls) break; // hard backstop
      // The reserve floor + monthly exhaustion are HARD stops for everyone (leaves room for manual
      // lookups; never overspends the budget). Imminent flights bypass the SLOW monthly pace below so a
      // last-hour delay is actually caught — capped per sweep, and still inside the reserve floor.
      const q = getFlightQuota();
      if (q && q.remaining - RESERVE_UNITS <= 0) break; // reserve reached → stop spending
      if (d.imminent) {
        if (imminentCalls >= MAX_IMMINENT_PER_SWEEP) continue; // burst cap — skip extra imminent legs this sweep
        imminentCalls++;
      } else {
        const interval = minCallIntervalMs(now);
        if (!Number.isFinite(interval)) break; // budget exhausted → stop until reset
        if (_lastCallAt && now - _lastCallAt < interval) break; // paced; due is urgency-sorted so the rest wait
      }
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
      _lastCallAt = now;
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

    // Write by INDEX, filtered on the email AT that index: targets exactly this staffer's leg (no $[s]
    // fan-out across duplicate emails) and no-ops cleanly if a concurrent roster edit shifted the array.
    const filter = {
      _id: d.eventId,
      ...NOT_DELETED,
      [`payload.staff.${d.staffIdx}.email`]: d.staffEmailRaw,
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
