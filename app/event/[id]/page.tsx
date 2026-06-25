import { notFound } from 'next/navigation';
import { getEvent, getEvents, getCases, getInventory, getTags, getUsers, getUserWeightUnit, getUserTempUnit, type TagDoc } from '@/lib/db/data';
import { requireUser } from '@/lib/auth/auth';
import { can } from '@/lib/auth/rbac';
import { stripEventPii, viewerLeadsEvent } from '@/lib/views/event-view';
import { activeGrantsFor } from '@/lib/auth/grants';
import { assembleEventDetailView, type ResolvedTag } from '@/lib/views/event-detail-view';
import { eventCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';
import { fetchVenueForecast, buildEventForecastRows, type EventForecastRow } from '@/lib/integrations/weather';
import { fetchSevereAlerts, type SevereAlert } from '@/lib/integrations/weather-alerts';
import type { CasePayload, EventPayload } from '@/lib/types/types';
import { EventDetailClient } from './event-detail-tabs';

// app/event/[id]/page.tsx — the event DETAIL view (Server Component).
//
// LIVE-DB: reads the event + the supporting collections (cases / inventory / tags / directory)
// straight from Mongo on every request (no cache). The PII strip runs HERE, server-side, so a
// non-privileged client literally never receives a staffer's hotel/travel over the wire (mirrors
// the Python /db read strip + _strip_event_entity_pii). lib/event-detail-view then assembles every
// derived view (manifest stats, readiness, case tiles, pallets, loose, tags, CSV rows, the directory
// pictures + the per-staffer accommodations gate) so the client island only renders.
export const dynamic = 'force-dynamic';

// Resolve a tag doc → the client-safe chip shape (flair denormalized on customEmoji + legacy
// flag-us/flag-cz fallback). Mirrors manifest/page.toDashTag.
function toResolvedTag(doc: TagDoc): ResolvedTag {
  const p = doc.payload ?? {};
  let flair = typeof p.customEmoji === 'string' ? p.customEmoji : '';
  if (!flair && p.flair === 'flag-us') flair = '🇺🇸';
  if (!flair && p.flair === 'flag-cz') flair = '🇨🇿';
  return {
    id: doc._id,
    label: typeof p.label === 'string' ? p.label : '',
    flair,
    color: typeof p.color === 'string' && p.color ? p.color : null,
  };
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // requireUser() redirects a signed-out / forged-cookie request to /login before any event data
  // (incl. the PII strip below) is computed.
  const [doc, user, eventDocs, caseDocs, invDocs, tagDocs, userDocs] = await Promise.all([
    getEvent(id),
    requireUser(),
    getEvents(),
    getCases(),
    getInventory(),
    getTags(),
    getUsers(),
  ]);
  if (!doc) notFound();

  const role = user.role;
  const email = user.email;

  // The viewer's ACTIVE #167 travel-data grants ('subjectEmail|eventId' set). Read once, server-side,
  // pinned to the unforgeable session email. fail-closed (empty set) on any store error so a grant
  // read hiccup can never widen visibility. The strip honors a matching grant as an extra,
  // tightly-scoped grant of staff.pii.view for exactly that one staffer on this event.
  const grants = await activeGrantsFor(email);

  // Authoritative read gate: drop hotel/travel for staffers this viewer may not see, BEFORE the data
  // crosses to the client component. A client never decides PII access. An approved grant keeps the
  // granted (subject, event) pair visible — keyed by the AUTHORITATIVE envelope id (`id`), the same id
  // the request/grant was written against.
  const safePayload = stripEventPii(doc.payload, email, role, grants, id);

  // Capabilities computed server-side from the live role + the stored event.
  const isLead = viewerLeadsEvent(doc.payload, email);
  const canEdit = can('event.edit', role, { isLeadOfEvent: isLead });
  const canDelete = can('event.delete', role, { isLeadOfEvent: isLead });
  // Itinerary printing (#86): manager+ may print ANY staffer's itinerary for this event
  // (itinerary.print.others); a staffer may always print their OWN (itinerary.print.self, a
  // self-context cap). The self print is gated client-side by viewerIsStaffed below.
  const canPrintOthersItin = can('itinerary.print.others', role);
  // A lead (or manager+) marks an in-transit event arrived On Site (signoff.commit, lead-of-event ok).
  const canMarkOnsite = can('signoff.commit', role, { isLeadOfEvent: isLead });

  // Supporting maps.
  const inventory = invDocs.map((d) => d.payload);
  const casesById: Record<string, CasePayload> = {};
  for (const c of caseDocs) casesById[c._id] = c.payload;
  const allEvents = eventDocs.map((e) => ({ _id: e._id, payload: e.payload }));

  // Directory: email -> { name, picture, accommodations } for the Team cards + the accommodations gate.
  const directoryByEmail: Record<string, { name?: string; picture?: string; accommodations?: unknown }> = {};
  for (const u of userDocs) {
    const p = (u.payload ?? {}) as { name?: string; preferredName?: string; picture?: string; accommodations?: unknown };
    directoryByEmail[u._id.toLowerCase()] = {
      name: p.preferredName || p.name || '',
      picture: p.picture || '',
      accommodations: p.accommodations,
    };
  }

  // Visible tag directory (hidden tags never render a chip).
  const tagById: Record<string, ResolvedTag> = {};
  for (const d of tagDocs) {
    if (d.payload?.hidden) continue;
    tagById[d._id] = toResolvedTag(d);
  }

  const weightUnit = await getUserWeightUnit(email);

  // Is the viewer staffed on THIS event? (Drives the "Request travel info" CTA visibility.)
  const viewerIsStaffed = (doc.payload.staff ?? []).some(
    (s) => String(s?.email ?? '').trim().toLowerCase() === email.toLowerCase()
  );

  const view = assembleEventDetailView({
    doc,
    safePayload,
    viewerEmail: email,
    viewerRole: role,
    viewerIsStaffed,
    inventory,
    casesById,
    allEvents,
    directoryByEmail,
    tagById,
    weightUnit,
  });

  // The event-level Data Matrix (the whole-event scan code, eitm:…:e:<id>), encoded server-side for
  // the header's "Print Matrix" modal.
  const tenantHash = await activeTenantHash36();
  const eventMatrixCode = eventCode(id, tenantHash);
  let eventMatrixSvg = '';
  if (eventMatrixCode) {
    try {
      eventMatrixSvg = dataMatrixSvg(eventMatrixCode);
    } catch {
      eventMatrixSvg = '';
    }
  }

  // The lead DISPLAY string for the header meta (resolve the stored lead email/name to a name).
  const leadDisplay = resolveLeadDisplay(safePayload, directoryByEmail);

  // ── Weather forecast for the venue across the event window (#67) ───────────────────────────
  // STUB-SAFE: fetchVenueForecast returns null until GOOGLE_WEATHER_API_KEY is set (the current
  // default), so forecastRows is [] and the Overview strip simply doesn't render — exactly as the
  // Python shows no chips without the key. The venue lat/lng anchors the lookup (no geocode fallback
  // in this stack yet — the Python geocodes the address text when coords are missing).
  let forecastRows: EventForecastRow[] = [];
  {
    const v = safePayload.venue;
    const lat = typeof v?.lat === 'number' ? v.lat : NaN;
    const lng = typeof v?.lng === 'number' ? v.lng : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const window = await fetchVenueForecast(lat, lng);
      forecastRows = buildEventForecastRows(safePayload.startDate, safePayload.endDate, window);
    }
  }
  // The viewer's preferred temperature unit (C/F) for the venue forecast chips.
  const tempUnit = await getUserTempUnit(email);

  // ── Severe weather warnings for the venue (NWS official in the US, forecast-derived elsewhere) ──
  // Only for an event that isn't long past — no point calling NWS for last year's show. Never throws;
  // an empty list simply renders no banner.
  let severeWeather: SevereAlert[] = [];
  {
    const v = safePayload.venue;
    const lat = typeof v?.lat === 'number' ? v.lat : NaN;
    const lng = typeof v?.lng === 'number' ? v.lng : NaN;
    const endIso = String(safePayload.endDate || safePayload.startDate || '').trim();
    const notLongPast = !/^\d{4}-\d{2}-\d{2}$/.test(endIso) || Date.parse(`${endIso}T23:59:59`) >= Date.now() - 2 * 86_400_000;
    if (Number.isFinite(lat) && Number.isFinite(lng) && notLongPast) {
      try {
        severeWeather = await fetchSevereAlerts(lat, lng, { startDate: safePayload.startDate, endDate: safePayload.endDate });
      } catch {
        /* best-effort — no banner on a fetch hiccup */
      }
    }
  }

  return (
    <EventDetailClient
      eventId={id}
      name={safePayload.name || ''}
      state={safePayload.state}
      startDate={safePayload.startDate || ''}
      city={(safePayload.venue?.city as string) || safePayload.city || ''}
      leadDisplay={leadDisplay}
      payload={safePayload}
      view={view}
      forecastRows={forecastRows}
      severeWeather={severeWeather}
      tempUnit={tempUnit}
      canEdit={canEdit}
      canDelete={canDelete}
      canPrintOthersItin={canPrintOthersItin}
      canPrintTeam={canPrintOthersItin || isLead}
      canMarkOnsite={canMarkOnsite}
      viewerIsStaffed={viewerIsStaffed}
      eventMatrixCode={eventMatrixCode}
      eventMatrixSvg={eventMatrixSvg}
    />
  );
}

// Resolve the event lead to a display NAME (the lead is stored as an email or a display name).
function resolveLeadDisplay(
  p: EventPayload,
  directoryByEmail: Record<string, { name?: string }>
): string {
  const lead = p.lead;
  if (!lead) return '';
  const ls = String(lead).trim();
  // Lead stored as email → resolve the directory/roster name.
  if (ls.includes('@')) {
    const dir = directoryByEmail[ls.toLowerCase()];
    if (dir?.name) return dir.name;
    const s = (p.staff ?? []).find((x) => (x.email ?? '').toLowerCase() === ls.toLowerCase());
    return s?.name || ls;
  }
  return ls; // already a display name (legacy)
}
