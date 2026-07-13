import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { getEvent, getEvents } from '@/lib/db/data';
import type { HotelInfo } from '@/lib/types/types';

// GET /api/hotel-suggestions?city=Chicago&event=<eventId> — "we've stayed here before".
//
// Aggregates past staff hotel blocks by hotel name for the given city so the event editor can
// suggest known-good (and warn about known-bad) hotels when planning a new event there. Ratings
// are averaged per event first (a whole team sharing one copied hotel block shouldn't weight one
// stay by headcount), then across events.
//
// Gate: the same check that unlocks the hotel sub-editor — staff.pii.view (manager+), or the lead
// of the event being edited (`event` param). The response is aggregate lodging history (no
// people, no rooms, no confirmations), but it derives from PII fields so it stays behind the gate.
export const dynamic = 'force-dynamic';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

interface Suggestion {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  rating: number | null; // avg of per-event averages, 1 decimal; null = never rated
  ratingCount: number; // individual ratings behind the average
  stays: number; // distinct past events
  lastEvent: string; // name of the most recent event stayed
  lastStay: string; // its startDate (YYYY-MM-DD)
  breakfast: string; // 'included' | 'paid' | 'none' | '' (unknown) — from the most recent stay
  breakfastRating: number | null; // avg breakfast QUALITY, same per-event-first math as rating
  amenities: string[]; // amenity flags (gym/pool/laundry/…) — merged across stays like the display fields
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'sign in required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(req.url);
  const city = norm(url.searchParams.get('city'));
  const eventId = url.searchParams.get('event') || '';
  if (!city) return NextResponse.json({ suggestions: [] }, { headers: { 'Cache-Control': 'no-store' } });

  const current = eventId ? await getEvent(eventId) : null;
  const isLead = !!current?.payload?.lead && norm(current.payload.lead) === norm(user.email);
  if (!can('staff.pii.view', user.role, { isLeadOfEvent: isLead })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const events = await getEvents();
  const agg = new Map<
    string,
    {
      hotel: HotelInfo;
      perEventRatings: Map<string, number[]>;
      perEventBreakfast: Map<string, number[]>;
      stays: Set<string>;
      lastStay: string;
      lastEvent: string;
    }
  >();
  for (const ev of events) {
    const p = ev.payload;
    if (!p || ev._id === eventId) continue; // never suggest the event being planned back at itself
    const evCity = norm(p.city) || norm(p.venue?.city);
    const startDate = String(p.startDate || '');
    for (const st of p.staff || []) {
      const hotel = st?.hotel;
      const key = norm(hotel?.name);
      if (!hotel || !key) continue;
      // Location match: the hotel's own city when set, else the event's. Loose containment so
      // "Las Vegas" matches "las vegas, nv" and typed prefixes still hit.
      const hCity = norm(hotel.city) || evCity;
      if (!hCity || !(hCity.includes(city) || city.includes(hCity))) continue;
      let a = agg.get(key);
      if (!a) {
        a = { hotel: {}, perEventRatings: new Map(), perEventBreakfast: new Map(), stays: new Set(), lastStay: '', lastEvent: '' };
        agg.set(key, a);
      }
      a.stays.add(ev._id);
      const r = Number(hotel.rating);
      if (Number.isFinite(r) && r >= 1 && r <= 5) {
        const list = a.perEventRatings.get(ev._id) || [];
        list.push(r);
        a.perEventRatings.set(ev._id, list);
      }
      const br = Number(hotel.breakfastRating);
      if (Number.isFinite(br) && br >= 1 && br <= 5) {
        const list = a.perEventBreakfast.get(ev._id) || [];
        list.push(br);
        a.perEventBreakfast.set(ev._id, list);
      }
      // The most recent stay wins the display fields (address/phone drift over the years) —
      // merged per-field, non-empty values only, so a colleague's bare-name hotel row on the same
      // stay can't erase the address/phone/breakfast another row carried.
      if (startDate >= a.lastStay) {
        a.lastStay = startDate;
        a.lastEvent = String(p.name || '');
        const merged: HotelInfo = { ...a.hotel };
        for (const [k, v] of Object.entries(hotel)) {
          if (v !== undefined && v !== null && String(v).trim() !== '') merged[k] = v;
        }
        a.hotel = merged;
      }
    }
  }

  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const suggestions: Suggestion[] = [...agg.values()]
    .map((a) => {
      const perEvent = [...a.perEventRatings.values()].map(avg);
      const perEventBf = [...a.perEventBreakfast.values()].map(avg);
      const bf = String(a.hotel.breakfast ?? '');
      return {
        name: String(a.hotel.name || ''),
        address: String(a.hotel.address || ''),
        city: String(a.hotel.city || ''),
        state: String(a.hotel.state || ''),
        zip: String(a.hotel.zip || ''),
        phone: String(a.hotel.phone || ''),
        rating: perEvent.length ? Math.round(avg(perEvent) * 10) / 10 : null,
        ratingCount: [...a.perEventRatings.values()].reduce((s, l) => s + l.length, 0),
        stays: a.stays.size,
        lastEvent: a.lastEvent,
        lastStay: a.lastStay,
        breakfast: ['included', 'paid', 'none'].includes(bf) ? bf : '',
        breakfastRating: perEventBf.length ? Math.round(avg(perEventBf) * 10) / 10 : null,
        amenities: Array.isArray(a.hotel.amenities)
          ? a.hotel.amenities.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 12)
          : [],
      };
    })
    .sort((x, y) => (y.rating ?? 0) - (x.rating ?? 0) || y.lastStay.localeCompare(x.lastStay))
    .slice(0, 6);

  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': 'no-store' } });
}
