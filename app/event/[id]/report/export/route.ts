import { NextResponse, type NextRequest } from 'next/server';
import { requireReportAccess } from '../report-access';
import { buildEventReport, reportToCsv, reportAiPrompt } from '@/lib/views/event-report';
import { getUsers } from '@/lib/db/data';

// GET /event/[id]/report/export?format=csv|json|prompt — the Event Report data, downloadable.
//
// csv    — one row per roster member (Excel-ready), for "gather data from all users".
// json   — the full aggregate (stats + hotels + rows), the machine-readable bundle.
// prompt — the AI-ready markdown+JSON prompt (same text as the copy button), for piping into
//          any model by hand.
// Gate: requireReportAccess (lead-of-event / staff.pii.view) — same as the page.
export const dynamic = 'force-dynamic';

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireReportAccess(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status, headers: { 'Cache-Control': 'no-store' } });
  }

  // Directory names for friendlier rows (best-effort).
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
  const base = `event-report-${slug(report.eventName)}`;
  const format = new URL(req.url).searchParams.get('format') || 'json';
  const headers = (name: string, type: string) => ({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });

  if (format === 'csv') {
    return new NextResponse(reportToCsv(report), { headers: headers(`${base}.csv`, 'text/csv; charset=utf-8') });
  }
  if (format === 'prompt') {
    return new NextResponse(reportAiPrompt(report), { headers: headers(`${base}-prompt.md`, 'text/markdown; charset=utf-8') });
  }
  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: headers(`${base}.json`, 'application/json; charset=utf-8'),
  });
}
