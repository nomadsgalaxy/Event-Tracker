import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StarRating } from '@/components/ui/star-rating';
import { getUsers } from '@/lib/db/data';
import { buildEventReport, reportAiPrompt } from '@/lib/views/event-report';
import { availableAiProviders, AI_PROVIDER_LABELS } from '@/lib/integrations/ai-report';
import { requireReportAccess } from './report-access';
import { PrintButton, ExportButtons, AiReportPanel } from './report-client';

// /event/[id]/report — the post-event EVENT REPORT (Server Component).
//
// Aggregates the roster's "How was your stay?" feedback: response rate, average event/venue/hotel
// ratings, per-hotel verdicts, and every staffer's ratings + comments. Lead-of-event / manager+
// only (requireReportAccess). Exports: Print (browser), CSV, JSON, and an AI prompt — plus in-app
// AI generation when an Anthropic/OpenAI/Gemini key is configured.
export const dynamic = 'force-dynamic';

function fmtDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default async function EventReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireReportAccess(id);
  if (!access.ok) {
    if (access.status === 404) notFound();
    // 403 — render the refusal inline (the viewer is signed in; an error page would lose context).
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-4 py-16">
        <h1 className="text-xl font-semibold">Event report</h1>
        <p className="text-sm text-muted-foreground">{access.error}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/event/${encodeURIComponent(id)}`}>
            <ChevronLeft aria-hidden />
            Back to event
          </Link>
        </Button>
      </div>
    );
  }

  const directoryByEmail: Record<string, { name?: string }> = {};
  try {
    for (const u of await getUsers()) {
      const p = (u.payload ?? {}) as { name?: string; preferredName?: string };
      directoryByEmail[u._id.toLowerCase()] = { name: p.preferredName || p.name || '' };
    }
  } catch {
    /* names fall back to roster/email */
  }

  const report = buildEventReport(access.doc, directoryByEmail);
  const providers = await availableAiProviders();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6 print:max-w-none print:p-0">
      {/* PRINT: the app is dark-only, but paper is white — force the report to print black-on-white
          and hide the shell chrome (top bar / mobile nav / footer live outside this subtree). */}
      <style>{`@media print {
        header, footer, nav { display: none !important; }
        html, body { background: #fff !important; }
        body * { color: #111 !important; border-color: #ccc !important; background: transparent !important; }
      }`}</style>
      {/* Header + actions */}
      <div className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground print:hidden">
          <Link href={`/event/${encodeURIComponent(id)}`}>
            <ChevronLeft aria-hidden />
            Back to event
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Event report</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{report.eventName || 'Untitled event'}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {fmtDate(report.startDate)}
              {report.endDate && report.endDate !== report.startDate ? ` – ${fmtDate(report.endDate)}` : ''}
              {report.city ? ` · ${report.city}` : ''}
              {report.venueName ? ` · ${report.venueName}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <PrintButton />
            <ExportButtons eventId={id} />
            <Button asChild variant="ghost" size="sm">
              <Link href="/reports?tab=feedback" title="Cross-event scorecards, averages and the hotel leaderboard">
                All scorecards
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Responses" value={`${report.responses}/${report.rosterSize}`} sub={`${report.responseRate}% of the roster`} />
        <RatingTile label="Event" value={report.avg.event} />
        <RatingTile label="Venue" value={report.avg.venue} />
        <RatingTile label="Hotels" value={report.avg.hotel} />
      </div>

      {/* AI panel */}
      <AiReportPanel eventId={id} providers={providers} providerLabels={AI_PROVIDER_LABELS} prompt={reportAiPrompt(report)} />

      {/* Hotels */}
      {report.hotels.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Hotels</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Hotel</th>
                  <th className="px-3 py-2 font-medium">Rating</th>
                  <th className="px-3 py-2 font-medium">Guests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.hotels.map((h) => (
                  <tr key={h.name}>
                    <td className="px-3 py-2">{h.name}</td>
                    <td className="px-3 py-2">
                      {h.rating != null ? (
                        <span className="inline-flex items-center gap-2">
                          <StarRating value={Math.round(h.rating)} size={13} label={`${h.name} rating`} />
                          <span className="tabular-nums text-muted-foreground">
                            {h.rating} ({h.raters})
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">not rated</span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{h.guests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* What the team said — per-topic notes, grouped so "what happened" reads in one place. */}
      <TopicDigest
        topics={[
          { title: 'The event', rows: report.rows.filter((r) => r.eventNotes).map((r) => ({ name: r.name, rating: r.event, text: r.eventNotes })) },
          { title: 'The venue', rows: report.rows.filter((r) => r.venueNotes).map((r) => ({ name: r.name, rating: r.venue, text: r.venueNotes })) },
          { title: 'The hotel', rows: report.rows.filter((r) => r.hotelNotes).map((r) => ({ name: r.name, rating: r.hotel, text: r.hotelNotes })) },
          { title: 'Anything else', rows: report.rows.filter((r) => r.comments).map((r) => ({ name: r.name, rating: null, text: r.comments })) },
        ]}
      />

      {/* Per-staffer feedback */}
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Team feedback</h2>
        {report.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No staff on this event.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Staffer</th>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Venue</th>
                  <th className="px-3 py-2 font-medium">Hotel</th>
                  <th className="px-3 py-2 font-medium">Comments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.rows.map((r) => (
                  <tr key={r.email || r.name} className={r.submittedAt == null && r.event == null && r.venue == null && r.hotel == null && !r.comments && !r.eventNotes && !r.venueNotes && !r.hotelNotes ? 'text-muted-foreground' : ''}>
                    <td className="px-3 py-2">
                      <span className="font-medium text-foreground">{r.name}</span>
                      {r.role ? <span className="ml-1.5 text-xs text-muted-foreground">{r.role}</span> : null}
                    </td>
                    <RatingCell v={r.event} label={`${r.name} event rating`} />
                    <RatingCell v={r.venue} label={`${r.name} venue rating`} />
                    <RatingCell v={r.hotel} label={`${r.name} hotel rating`} />
                    <td className="max-w-[22rem] px-3 py-2 whitespace-pre-wrap">{r.comments || <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Staff are nudged for feedback in their notification bell for two weeks after the event ends;
          they can also submit any time from the event page.
        </p>
      </section>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function RatingTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {value != null ? (
        <p className="mt-1 flex items-center gap-2">
          <span className="text-xl font-semibold tabular-nums">{value}</span>
          <StarRating value={Math.round(value)} size={14} label={`${label} average`} />
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">no ratings yet</p>
      )}
    </div>
  );
}

function RatingCell({ v, label }: { v: number | null; label: string }) {
  return (
    <td className="px-3 py-2">
      {v != null ? <StarRating value={v} size={13} label={label} /> : <span className="text-muted-foreground">—</span>}
    </td>
  );
}

// "What the team said" — the per-topic detail notes, one subsection per topic, only when someone
// wrote something. This is the narrative half of the report; the table below stays the numbers.
function TopicDigest({
  topics,
}: {
  topics: { title: string; rows: { name: string; rating: number | null; text: string }[] }[];
}) {
  const withNotes = topics.filter((t) => t.rows.length > 0);
  if (withNotes.length === 0) return null;
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">What the team said</h2>
      <div className="grid gap-3">
        {withNotes.map((t) => (
          <div key={t.title} className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">{t.title}</h3>
            <ul className="grid gap-2.5">
              {t.rows.map((row, i) => (
                <li key={`${row.name}-${i}`} className="grid gap-0.5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.rating != null && <StarRating value={row.rating} size={11} label={`${row.name} ${t.title} rating`} />}
                  </div>
                  <p className="text-sm leading-snug whitespace-pre-wrap">{row.text}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
