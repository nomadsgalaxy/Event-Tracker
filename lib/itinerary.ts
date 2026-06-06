import 'server-only';
import { can } from './rbac';
import { dataMatrixSvg } from './data-matrix';
import type { EventDoc, EventPayload, Staffer, TravelLeg, AccommodationsProfile } from './types';

// lib/itinerary.ts — the "Print all my travel" itinerary builder + boarding-pass HTML renderer.
//
// Faithful port of the Python buildItinerarySnapshot + renderItineraryHtml (index.html ~L4883 / 4989):
// a chronological, boarding-pass-styled summary of the traveler's flights, hotels, and event credentials
// across every show they're staffed on. Used by /account/itinerary/print, which the Preferences tab's
// "Print all my travel" opens in a new tab (the source's printItinerary popup).
//
// PII: this is ALWAYS the signed-in user printing their OWN itinerary (viewer === subject), so the
// accommodations notes are gated by canSeeAccommodations(role, {isSelf:true}) — which is true for any
// signed-in user on their own record (the itinerary.print.self / accommodations self-context grant).
// The route never builds another user's itinerary, so there is no cross-user PII path here.

function eqEmail(a: unknown, b: unknown): boolean {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

interface ItineraryLeg {
  mode: string;
  dir: string;
  carrier: string;
  number: string;
  confirmation: string;
  from: string;
  to: string;
  departAt: string;
  arriveAt: string;
  notes: string;
}

interface ItineraryHotel {
  name: string;
  address: string;
  room: string;
  phone: string;
  checkInAt: string;
  checkOutAt: string;
  confirmation: string;
  notes: string;
}

interface ItineraryEvent {
  eventId: string;
  eventName: string;
  dates: { start: string; end: string };
  venue: { name: string; city: string; booth: string };
  role: 'lead' | 'staff';
  legs: ItineraryLeg[];
  hotel: ItineraryHotel | null;
}

export interface ItinerarySnapshot {
  traveler: {
    email: string;
    name: string;
    role: string;
    portOfCall: { airport: string; trainStation: string };
  };
  showAccommodations: boolean;
  accommodations: AccommodationsProfile | null;
  capturedBy: { email: string; name: string; role: string } | null;
  capturedAt: string;
  events: ItineraryEvent[];
}

export interface ItineraryTraveler {
  email: string;
  name: string;
  role: string;
  portOfCall?: { airport?: string; trainStation?: string } | null;
  accommodations?: AccommodationsProfile | null;
}

/**
 * Build the itinerary snapshot for `traveler` across `allEvents`, from the perspective of `viewer`
 * (here always === traveler, the self-print). Faithful to buildItinerarySnapshot: one ordered legs[]
 * (outbound then return), the hotel locator block, the per-event lead/staff role, chronological by
 * start date. Accommodations included only when the viewer passes accommodations.view for self.
 */
export function buildItinerarySnapshot(
  traveler: ItineraryTraveler,
  allEvents: EventDoc[],
  viewerRole: string,
  // SELF by default (the "Print all my travel" path). For a manager+ printing ANOTHER staffer's
  // itinerary (itinerary.print.others), pass isSelf:false so the accommodations gate is judged on the
  // viewer's ROLE alone (manager+ passes; a lead would NOT — accommodations.view has no lead ctx).
  isSelf = true
): ItinerarySnapshot {
  const targetEmail = traveler.email;
  // Accommodations gate: can('accommodations.view', role, {isSelf}). Self ⇒ any signed-in role on
  // their own record; others ⇒ manager+ by role only.
  const showAccommodations = can('accommodations.view', viewerRole, { isSelf });

  const events: ItineraryEvent[] = [];
  for (const ed of allEvents) {
    const ev: EventPayload = ed?.payload;
    if (!ev || !ev.name) continue;
    const staffer: Staffer | undefined = (ev.staff ?? []).find((s) => s && eqEmail(s.email, targetEmail));
    if (!staffer) continue;

    const legs: ItineraryLeg[] = [];
    const t = staffer.travel || null;
    const mode = (t && t.mode) || 'flight';
    const pushLeg = (dir: string, lg: TravelLeg | undefined) => {
      if (!lg) return;
      if (
        !(
          lg.carrier ||
          lg.number ||
          lg.departLocation ||
          lg.arriveLocation ||
          lg.departAt ||
          lg.arriveAt ||
          lg.confirmation
        )
      ) {
        return;
      }
      legs.push({
        mode,
        dir,
        carrier: lg.carrier || '',
        number: lg.number || '',
        confirmation: lg.confirmation || '',
        from: lg.departLocation || '',
        to: lg.arriveLocation || '',
        departAt: lg.departAt || '',
        arriveAt: lg.arriveAt || '',
        notes: (lg.notes as string) || '',
      });
    };
    if (t) {
      pushLeg('Outbound', t.outbound);
      pushLeg('Return', t.return);
    }

    let hotel: ItineraryHotel | null = null;
    const h = staffer.hotel || null;
    if (
      h &&
      (h.name || h.address || h.room || h.phone || h.checkInAt || h.checkOutAt || h.confirmation || h.notes)
    ) {
      hotel = {
        name: h.name || '',
        address: h.address || '',
        room: h.room || '',
        phone: h.phone || '',
        checkInAt: h.checkInAt || '',
        checkOutAt: h.checkOutAt || '',
        confirmation: h.confirmation || '',
        notes: h.notes || '',
      };
    }

    const isLead = !!(
      ev.lead &&
      (eqEmail(ev.lead, targetEmail) || ev.lead === staffer.name || (traveler.name && ev.lead === traveler.name))
    );

    events.push({
      eventId: ev.id || ed._id || '',
      eventName: ev.name || '',
      dates: { start: ev.startDate || '', end: ev.endDate || '' },
      venue: {
        name: (ev.venue && (ev.venue.name as string)) || '',
        city: (ev.venue && (ev.venue.city as string)) || '',
        booth: (ev.venue && (ev.venue.booth as string)) || '',
      },
      role: isLead ? 'lead' : 'staff',
      legs,
      hotel,
    });
  }

  events.sort((a, b) => {
    const as = a.dates.start || '';
    const bs = b.dates.start || '';
    if (as && bs) return as < bs ? -1 : as > bs ? 1 : 0;
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    return 0;
  });

  const poc = traveler.portOfCall || {};
  return {
    traveler: {
      email: traveler.email || '',
      name: traveler.name || traveler.email || '',
      role: traveler.role || '',
      portOfCall: {
        airport: typeof poc.airport === 'string' ? poc.airport : '',
        trainStation: typeof poc.trainStation === 'string' ? poc.trainStation : '',
      },
    },
    showAccommodations,
    accommodations: showAccommodations ? traveler.accommodations || null : null,
    capturedBy: { email: traveler.email, name: traveler.name || traveler.email, role: traveler.role || '' },
    capturedAt: new Date().toISOString(),
    events,
  };
}

// ── HTML renderer (faithful port of renderItineraryHtml's boarding-pass styling) ───────────────
function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A server-built Data Matrix SVG for a scannable code on the printout (boarding-pass stub + event
 *  badge), matching the Python itinerary's embedded codes. Empty string on any encode failure. */
function dmCode(payload: string): string {
  const v = String(payload || '').trim();
  if (!v) return '';
  try {
    return dataMatrixSvg(v);
  } catch {
    return '';
  }
}

function fmtDate(v: string): string {
  if (!v) return '';
  // Event date 'YYYY-MM-DD' → friendly with year; datetime 'YYYY-MM-DDTHH:MM' → month/day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return Number.isNaN(dt.getTime())
      ? v
      : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const s = v.length === 16 ? v + ':00' : v;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? v : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtTime(v: string): string {
  if (!v) return '';
  const s = v.length === 16 ? v + ':00' : v;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime())
    ? ''
    : dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDateTime(v: string): string {
  const dd = fmtDate(v);
  const tt = fmtTime(v);
  return tt ? `${dd} · ${tt}` : dd;
}

function nightsBetween(a: string, b: string): number | '' {
  if (!a || !b) return '';
  const da = new Date(a.length === 16 ? a + ':00' : a);
  const db = new Date(b.length === 16 ? b + ':00' : b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return '';
  const d0 = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const d1 = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  const n = Math.round((d1 - d0) / 86400000);
  return n > 0 ? n : '';
}

function dateRange(s: string, e: string): string {
  if (s && e && s !== e) return `${fmtDate(s)} – ${fmtDate(e)}`;
  return fmtDate(s || e || '');
}

const ITIN_STYLES =
  "*{box-sizing:border-box;}html,body{margin:0;}" +
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:32px 36px 24px;color:#111;background:#f4f5f7;display:flex;flex-direction:column;min-height:100vh;}" +
  ".toolbar{position:sticky;top:0;background:#fff;padding:8px 36px 12px;margin:-32px -36px 18px;border-bottom:1px dashed #ddd;display:flex;gap:8px;z-index:10;}" +
  ".toolbar button{font:600 11px inherit;padding:6px 12px;border:1px solid #888;border-radius:3px;background:#f3f3f3;cursor:pointer;}" +
  ".toolbar button.primary{background:#111;color:#fff;border-color:#111;}" +
  ".head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px;}" +
  ".eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#888;font-weight:700;}" +
  "h1{font-weight:700;font-size:28px;line-height:1.2;margin:6px 0 6px;color:#111;}" +
  ".sub{font-size:12px;color:#555;}.sub .mono{font-family:ui-monospace,Consolas,monospace;}" +
  ".poc{font-size:11px;color:#666;margin-top:4px;}" +
  ".head-stamp{flex-shrink:0;text-align:right;font-size:10px;color:#888;line-height:1.5;}" +
  ".event-block{margin-bottom:26px;}" +
  ".badge{position:relative;display:flex;align-items:center;gap:14px;border:1px solid #1f3a5f;background:linear-gradient(135deg,#15233b 0%,#1f3a5f 100%);color:#fff;border-radius:8px;padding:14px 18px 14px 22px;margin-bottom:12px;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
  ".badge-main{flex:1;min-width:0;}" +
  ".badge::before{content:'';position:absolute;left:0;top:0;bottom:0;width:6px;background:#fd5000;border-radius:8px 0 0 8px;}" +
  ".badge .lanyard{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9fc0ec;font-weight:700;}" +
  ".badge .nm{font-size:19px;font-weight:700;margin-top:2px;line-height:1.2;}" +
  ".badge .meta{font-size:12px;color:#cdddf2;margin-top:4px;}" +
  ".badge .rolepill{display:inline-block;margin-top:8px;font-size:9px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.3);}" +
  ".badge .rolepill.lead{background:#fd5000;border-color:#fd5000;}" +
  ".cards{display:flex;flex-direction:column;gap:10px;}" +
  ".no-travel{font-size:12px;color:#777;font-style:italic;padding:6px 4px;}" +
  ".pass{display:flex;border:1px solid #c9ccd2;background:#fff;border-radius:8px;overflow:hidden;page-break-inside:avoid;box-shadow:0 1px 2px rgba(0,0,0,.06);-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
  ".pass .main{flex:1;min-width:0;padding:14px 16px;}" +
  ".pass .topline{display:flex;justify-content:space-between;align-items:baseline;gap:10px;}" +
  ".pass .airline{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#666;font-weight:700;}" +
  ".pass .flightno{font-size:22px;font-weight:800;color:#111;letter-spacing:.02em;}" +
  ".pass .route{display:flex;align-items:flex-end;gap:14px;margin-top:10px;}" +
  ".pass .port{min-width:0;}" +
  ".pass .port .code{font-size:24px;font-weight:800;color:#15233b;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;}" +
  ".pass .port .lbl{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#999;font-weight:700;margin-top:3px;}" +
  ".pass .port .tm{font-size:11px;color:#555;margin-top:2px;}" +
  ".pass .arrow{flex:1;border-bottom:2px dotted #b5b9c0;position:relative;margin-bottom:18px;min-width:24px;}" +
  ".pass .arrow::after{content:'\\2708';position:absolute;right:-2px;top:-12px;font-size:14px;color:#fd5000;}" +
  ".pass .detailrow{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;padding-top:10px;border-top:1px solid #eee;}" +
  ".pass .dl{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#999;font-weight:700;}" +
  ".pass .dv{font-size:12px;color:#222;font-weight:600;font-family:ui-monospace,Consolas,monospace;}" +
  ".pass .stub{width:118px;flex-shrink:0;border-left:2px dashed #c9ccd2;background:#fafafa;padding:12px 10px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:8px;text-align:center;position:relative;}" +
  ".pass .stub::before,.pass .stub::after{content:'';position:absolute;left:-7px;width:12px;height:12px;border-radius:999px;background:#f4f5f7;border:1px solid #c9ccd2;}" +
  ".pass .stub::before{top:-7px;}.pass .stub::after{bottom:-7px;}" +
  ".pass .stub .dir{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#666;font-weight:700;}" +
  ".pass .stub .stubconf{font-size:10px;font-family:ui-monospace,Consolas,monospace;color:#333;word-break:break-all;line-height:1.25;}" +
  ".trip{border:1px solid #c9ccd2;background:#fff;border-radius:8px;padding:13px 16px;page-break-inside:avoid;}" +
  ".trip .topline{display:flex;justify-content:space-between;align-items:baseline;gap:10px;}" +
  ".trip .mode{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#666;font-weight:700;}" +
  ".trip .dir{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#999;font-weight:700;}" +
  ".trip .route{font-size:16px;font-weight:700;color:#15233b;margin-top:6px;}" +
  ".trip .detailrow{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;}" +
  ".trip .dl{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#999;font-weight:700;}" +
  ".trip .dv{font-size:12px;color:#222;font-weight:600;}" +
  ".keycard{display:flex;border-radius:8px;overflow:hidden;page-break-inside:avoid;border:1px solid #2a2f3a;-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
  ".keycard .face{flex:1;min-width:0;background:linear-gradient(120deg,#2a2f3a 0%,#3d4456 100%);color:#fff;padding:14px 16px;}" +
  ".keycard .kc-eyebrow{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9aa3b5;font-weight:700;}" +
  ".keycard .kc-name{font-size:17px;font-weight:700;margin-top:3px;line-height:1.2;}" +
  ".keycard .kc-addr{font-size:11px;color:#c3c9d6;margin-top:3px;line-height:1.4;}" +
  ".keycard .kc-row{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;}" +
  ".keycard .kl{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#8e96a8;font-weight:700;}" +
  ".keycard .kv{font-size:12px;color:#fff;font-weight:600;margin-top:1px;}" +
  ".keycard .stripe{width:30px;flex-shrink:0;background:repeating-linear-gradient(0deg,#111 0,#111 6px,#333 6px,#333 12px);}" +
  ".notes{margin-top:22px;border:1px solid #c98a00;background:#fff7e6;border-left:5px solid #e08e00;border-radius:6px;padding:12px 16px;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
  ".notes .nt{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#9a6a00;font-weight:700;}" +
  ".notes h3{font-size:14px;font-weight:700;margin:2px 0 8px;color:#111;}" +
  ".notes .nrow{font-size:12px;color:#333;margin-bottom:5px;line-height:1.5;}" +
  ".notes .nrow b{color:#7a4400;}" +
  ".notes .sev{font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.05em;color:#b1370a;}" +
  ".footer{margin-top:auto;padding-top:12px;border-top:1px solid #ccc;font-size:10px;color:#666;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;}" +
  ".empty{font-style:italic;color:#777;font-size:13px;padding:8px 0;}" +
  ".badge .dm{flex-shrink:0;width:62px;height:62px;background:#fff;padding:3px;border-radius:4px;}.badge .dm svg{display:block;width:100%;height:100%;}" +
  ".pass .stub .dm{width:60px;height:60px;background:#fff;padding:2px;border-radius:2px;}.pass .stub .dm svg{display:block;width:100%;height:100%;}" +
  "@media print{body{padding:12mm 10mm;display:block;min-height:auto;background:#fff;}.toolbar{display:none;}.badge,.pass,.keycard,.trip,.notes{page-break-inside:avoid;}-webkit-print-color-adjust:exact;print-color-adjust:exact;}";

/** Render the itinerary snapshot to a full standalone HTML document (boarding-pass styled). Faithful
 *  to renderItineraryHtml, MINUS the embedded Data Matrix codes (no client code-lib in this route).
 *  All values are HTML-escaped (the snapshot carries user free-text). The doc self-prints on load. */
export function renderItineraryHtml(snap: ItinerarySnapshot): string {
  const trav = snap.traveler;
  const cap = snap.capturedBy;
  const events = snap.events;
  const capturedStr = snap.capturedAt
    ? new Date(snap.capturedAt).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
  const docTitle = `${trav.name || 'Traveler'} — travel itinerary`;

  let html =
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    esc(docTitle) +
    '</title><style>' +
    ITIN_STYLES +
    '</style></head><body>';
  html +=
    '<div class="toolbar"><button class="primary" onclick="window.print()">Print</button><button onclick="window.close()">Close</button></div>';

  html += '<div class="head"><div>';
  html += '<div class="eyebrow">Travel itinerary</div>';
  html += '<h1>' + esc(trav.name || 'Traveler') + '</h1>';
  const evN = events.length;
  html +=
    '<div class="sub">' +
    esc(evN) +
    ' event' +
    (evN === 1 ? '' : 's') +
    (trav.email ? ' · <span class="mono">' + esc(trav.email) + '</span>' : '') +
    '</div>';
  const pocBits: string[] = [];
  if (trav.portOfCall.airport) pocBits.push('Home airport ' + esc(trav.portOfCall.airport));
  if (trav.portOfCall.trainStation) pocBits.push('Home station ' + esc(trav.portOfCall.trainStation));
  if (pocBits.length) html += '<div class="poc">' + pocBits.join(' · ') + '</div>';
  html += '</div>';
  html += '<div class="head-stamp">';
  if (capturedStr) html += 'Prepared ' + esc(capturedStr) + '<br>';
  if (cap?.name) html += 'by ' + esc(cap.name);
  html += '</div></div>';

  if (!events.length) {
    html += '<div class="empty">No events or travel recorded for this traveler.</div>';
  }

  for (const ev of events) {
    html += '<div class="event-block">';
    html += '<div class="badge"><div class="badge-main">';
    html += '<div class="lanyard">' + (ev.role === 'lead' ? 'Event credential · Lead' : 'Event credential') + '</div>';
    html += '<div class="nm">' + esc(ev.eventName) + '</div>';
    const bMeta: string[] = [];
    const drange = dateRange(ev.dates.start, ev.dates.end);
    if (drange) bMeta.push(esc(drange));
    if (ev.venue.name) bMeta.push(esc(ev.venue.name));
    if (ev.venue.city) bMeta.push(esc(ev.venue.city));
    if (ev.venue.booth) bMeta.push('Booth ' + esc(ev.venue.booth));
    if (bMeta.length) html += '<div class="meta">' + bMeta.join(' · ') + '</div>';
    html += '<span class="rolepill' + (ev.role === 'lead' ? ' lead' : '') + '">' + esc(ev.role) + '</span>';
    html += '</div>'; // .badge-main
    // Scannable event credential code (eventName + start date), matching the Python badge code.
    const badgeDm = dmCode([ev.eventName, ev.dates.start].filter(Boolean).join(' '));
    if (badgeDm) html += '<div class="dm">' + badgeDm + '</div>';
    html += '</div>'; // .badge

    html += '<div class="cards">';
    const flights = ev.legs.filter((l) => l.mode === 'flight');
    const ground = ev.legs.filter((l) => l.mode !== 'flight');
    if (!ev.legs.length && !ev.hotel) {
      html += '<div class="no-travel">No travel recorded for this event.</div>';
    }

    for (const lg of flights) {
      html += '<div class="pass"><div class="main">';
      html += '<div class="topline"><span class="airline">' + (esc(lg.carrier) || 'Flight') + '</span>';
      html += '<span class="flightno">' + esc((lg.carrier ? lg.carrier + ' ' : '') + (lg.number || '')) + '</span></div>';
      html += '<div class="route">';
      html +=
        '<div class="port"><div class="code">' +
        (esc(lg.from) || '—') +
        '</div><div class="lbl">From</div>' +
        (lg.departAt ? '<div class="tm">' + esc(fmtDateTime(lg.departAt)) + '</div>' : '') +
        '</div>';
      html += '<div class="arrow"></div>';
      html +=
        '<div class="port"><div class="code">' +
        (esc(lg.to) || '—') +
        '</div><div class="lbl">To</div>' +
        (lg.arriveAt ? '<div class="tm">' + esc(fmtDateTime(lg.arriveAt)) + '</div>' : '') +
        '</div>';
      html += '</div>';
      const dets: string[] = [];
      if (lg.departAt) dets.push('<div><div class="dl">Date</div><div class="dv">' + esc(fmtDate(lg.departAt)) + '</div></div>');
      if (lg.confirmation) dets.push('<div><div class="dl">Confirmation / PNR</div><div class="dv">' + esc(lg.confirmation) + '</div></div>');
      if (lg.notes) dets.push('<div><div class="dl">Notes</div><div class="dv" style="font-family:inherit;font-weight:400">' + esc(lg.notes) + '</div></div>');
      if (dets.length) html += '<div class="detailrow">' + dets.join('') + '</div>';
      html += '</div>';
      html += '<div class="stub"><div class="dir">' + esc(lg.dir) + '</div>';
      // Scannable flight confirmation code: the PNR when present, else carrier/number/date so the
      // stub always carries a machine-readable code (the Python boarding-pass embeds the same).
      const flightDm = dmCode(lg.confirmation || [lg.carrier, lg.number, (lg.departAt || '').slice(0, 10)].filter(Boolean).join(' '));
      if (flightDm) html += '<div class="dm">' + flightDm + '</div>';
      html += '<div class="stubconf">' + (esc(lg.confirmation) || esc(lg.number) || '&mdash;') + '</div>';
      html += '</div></div>';
    }

    for (const lg of ground) {
      const modeLabel = lg.mode === 'train' ? 'Train' : lg.mode === 'drive' ? 'Drive' : 'Travel';
      html +=
        '<div class="trip"><div class="topline"><span class="mode">' +
        esc(modeLabel) +
        (lg.carrier || lg.number ? ' · ' + esc([lg.carrier, lg.number].filter(Boolean).join(' ')) : '') +
        '</span><span class="dir">' +
        esc(lg.dir) +
        '</span></div>';
      html += '<div class="route">' + (esc(lg.from) || '?') + ' &rarr; ' + (esc(lg.to) || '?') + '</div>';
      const dets: string[] = [];
      if (lg.departAt) dets.push('<div><div class="dl">Depart</div><div class="dv">' + esc(fmtDateTime(lg.departAt)) + '</div></div>');
      if (lg.arriveAt) dets.push('<div><div class="dl">Arrive</div><div class="dv">' + esc(fmtDateTime(lg.arriveAt)) + '</div></div>');
      if (lg.confirmation) dets.push('<div><div class="dl">Confirmation</div><div class="dv">' + esc(lg.confirmation) + '</div></div>');
      if (lg.notes) dets.push('<div><div class="dl">Notes</div><div class="dv" style="font-weight:400">' + esc(lg.notes) + '</div></div>');
      if (dets.length) html += '<div class="detailrow">' + dets.join('') + '</div>';
      html += '</div>';
    }

    if (ev.hotel) {
      const h = ev.hotel;
      const nts = nightsBetween(h.checkInAt, h.checkOutAt);
      html += '<div class="keycard"><div class="face">';
      html += '<div class="kc-eyebrow">Hotel keycard</div>';
      html += '<div class="kc-name">' + (esc(h.name) || 'Hotel') + '</div>';
      if (h.address) html += '<div class="kc-addr">' + esc(h.address) + '</div>';
      html += '<div class="kc-row">';
      if (h.checkInAt) html += '<div><div class="kl">Check-in</div><div class="kv">' + esc(fmtDateTime(h.checkInAt)) + '</div></div>';
      if (h.checkOutAt)
        html +=
          '<div><div class="kl">Check-out</div><div class="kv">' +
          esc(fmtDateTime(h.checkOutAt)) +
          (nts ? ' (' + esc(nts) + ' night' + (nts === 1 ? '' : 's') + ')' : '') +
          '</div></div>';
      if (h.room) html += '<div><div class="kl">Room</div><div class="kv">' + esc(h.room) + '</div></div>';
      if (h.confirmation) html += '<div><div class="kl">Confirmation</div><div class="kv">' + esc(h.confirmation) + '</div></div>';
      if (h.phone) html += '<div><div class="kl">Phone</div><div class="kv">' + esc(h.phone) + '</div></div>';
      html += '</div>';
      if (h.notes) html += '<div class="kc-addr" style="margin-top:8px">' + esc(h.notes) + '</div>';
      html += '</div><div class="stripe"></div></div>';
    }

    html += '</div></div>'; // .cards, .event-block
  }

  if (snap.showAccommodations && snap.accommodations) {
    const a = snap.accommodations;
    const rows: string[] = [];
    if (Array.isArray(a.dietary) && a.dietary.length) rows.push('<div class="nrow"><b>Dietary:</b> ' + esc(a.dietary.join(', ')) + '</div>');
    if (a.allergies && a.allergies.text)
      rows.push(
        '<div class="nrow"><b>Allergies:</b> ' +
          esc(a.allergies.text) +
          (a.allergies.severity ? ' <span class="sev">[' + esc(a.allergies.severity) + ']</span>' : '') +
          '</div>'
      );
    if (Array.isArray(a.accessibility) && a.accessibility.length)
      rows.push('<div class="nrow"><b>Accessibility:</b> ' + esc(a.accessibility.join(', ')) + '</div>');
    if (a.medical) rows.push('<div class="nrow"><b>Medical:</b> ' + esc(a.medical) + '</div>');
    const contacts = Array.isArray(a.emergencyContacts)
      ? a.emergencyContacts
      : a.emergencyContact
        ? [a.emergencyContact]
        : [];
    const cRows = contacts
      .filter((c) => c && (c.name || c.phone || c.email))
      .map((c) => [c.name, c.relationship, c.phone, c.email].filter(Boolean).map(esc).join(' · '));
    if (cRows.length)
      rows.push('<div class="nrow"><b>Emergency contact' + (cRows.length === 1 ? '' : 's') + ':</b> ' + cRows.join('<br>') + '</div>');
    if (a.notes) rows.push('<div class="nrow"><b>Notes:</b> ' + esc(a.notes) + '</div>');
    if (rows.length) {
      html += '<div class="notes"><div class="nt">Confidential</div><h3>Traveler notes</h3>' + rows.join('') + '</div>';
    }
  }

  html += '<div class="footer"><span>' + esc(trav.name || '') + (trav.email ? ' · ' + esc(trav.email) : '') + '</span>';
  html += '<span>' + (capturedStr ? 'Printed ' + esc(capturedStr) : '') + (cap?.name ? ' by ' + esc(cap.name) : '') + '</span></div>';
  html += '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print();}catch(e){}},300);});</script>';
  html += '</body></html>';
  return html;
}
