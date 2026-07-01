'use client';

import { useEffect, useRef, useState } from 'react';
import { PlaneTakeoff } from 'lucide-react';
import { flightProgressAction, type FlightProgressState } from '@/app/event/flight-actions';
import type { TravelLeg } from '@/lib/types/types';

// flight-progress.tsx — the live in-air progress strip under a flight leg on the Travel tab.
// Renders ONLY while the flight is plausibly enroute (the client window check below keeps idle tab
// opens from spending OpenSky pulls; the server re-gates by phase anyway). Polls every 2 minutes
// while mounted. The viewer already sees the leg (the payload is PII-stripped server-side), and the
// action re-checks the same travel-PII rule.

const POLL_MS = 2 * 60_000;
const PRE_WINDOW_MS = 15 * 60_000; // start watching shortly before wheels-up
const POST_WINDOW_MS = 45 * 60_000; // keep watching a bit past the estimated arrival

function plausiblyEnroute(leg: TravelLeg, now: number): boolean {
  if (leg.status === 'cancelled' || leg.status === 'arrived' || leg.status === 'diverted') return false;
  const dep = Number(leg.departActualUtc ?? leg.departUtc ?? NaN);
  if (!Number.isFinite(dep)) return leg.status === 'departed'; // no anchor — only track an explicit departure
  if (now < dep - PRE_WINDOW_MS) return false;
  const arr = Number(leg.arriveEstUtc ?? NaN);
  if (Number.isFinite(arr) && now > arr + POST_WINDOW_MS) return false;
  // No arrival anchor: stop watching half a day past departure.
  if (!Number.isFinite(arr) && now > dep + 12 * 3_600_000) return false;
  return true;
}

export function FlightProgress({
  eventId,
  staffEmail,
  legKey,
  leg,
}: {
  eventId: string;
  staffEmail: string;
  /** 'outbound' | 'return' | a connection ref like 'outboundConnections.0' (multi-leg journeys). */
  legKey: string;
  leg: TravelLeg;
}) {
  const [state, setState] = useState<FlightProgressState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // `track` is STATE re-evaluated on a 1-min meta-timer (not a render-time const): a tab opened
  // before the pre-departure window must start polling when the window opens without any re-render.
  const [track, setTrack] = useState(() => plausiblyEnroute(leg, Date.now()));
  useEffect(() => {
    const t = setInterval(() => setTrack(plausiblyEnroute(leg, Date.now())), 60_000);
    return () => clearInterval(t);
  }, [leg]);

  useEffect(() => {
    if (!track) return;
    let dead = false;
    const tick = async () => {
      try {
        const res = await flightProgressAction(eventId, staffEmail, legKey);
        if (!dead) setState(res);
        // Landed / unavailable → stop polling.
        if (!dead && (res.unavailable || !res.ok || res.phase === 'landed') && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
      } catch {
        /* leave the last state */
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), POLL_MS);
    return () => {
      dead = true;
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, staffEmail, legKey, track]);

  if (!track || !state || !state.ok || state.unavailable || state.phase !== 'enroute') return null;

  const pct = state.pct;
  const live = state.live;
  return (
    <div className="mt-1 flex flex-col gap-1 rounded bg-muted/50 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <PlaneTakeoff aria-hidden className="size-3 text-primary" />
        Live · {state.flightNumber}
        {pct != null ? <span className="text-foreground">{pct}% enroute</span> : <span>enroute</span>}
      </div>
      {pct != null && (
        <div className="h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="text-[10px] text-muted-foreground">
        {live ? (
          <>
            {live.onGround ? 'On the ground' : `${live.altitudeFt != null ? `${live.altitudeFt.toLocaleString()} ft` : 'altitude n/a'} · ${live.speedKts != null ? `${live.speedKts} kts` : 'speed n/a'}`}
            {' · '}
            <a
              href={`https://www.google.com/maps?q=${live.lat},${live.lng}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              position ↗
            </a>
            {live.ageS > 60 ? ` · seen ${Math.round(live.ageS / 60)}m ago` : ''}
          </>
        ) : state.liveNote === 'pending-ident' ? (
          'In flight — live position available after the next status refresh'
        ) : (
          'In flight — no live position right now (ADS-B coverage)'
        )}
      </div>
    </div>
  );
}

export default FlightProgress;
