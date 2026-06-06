import { type NextRequest } from 'next/server';
import { getSession, verifyStepupToken } from '@/lib/auth/session';
import { resolveLiveRole } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import { getBranding, saveBranding } from '@/lib/auth/settings-store';
import { writeAudit } from '@/lib/db/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/branding — the company branding store (Config > Admin). Non-secret, but admin-gated and
// step-up-protected on WRITE (a branding flip is a deployment-wide change). Mirrors the Python
// Company-branding card's companyDefault + domain→company map.
//
// GET  — ADMIN: the current companyDefault + companyMap (non-secret).
// POST — ADMIN + STEP-UP: persist them. Role re-resolved live; step-up bound to the session email.

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');
  const branding = await getBranding({ fresh: true });
  return jsonOk({ ...branding });
}

interface BrandingBody {
  stepupToken?: string;
  companyDefault?: string;
  companyMap?: Record<string, string>;
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');

  const body = (await readJson(req)) as BrandingBody;
  if (!verifyStepupToken(body.stepupToken, sess.sub)) return jsonErr(403, 'step-up required');

  const companyMap: Record<string, string> = {};
  if (body.companyMap && typeof body.companyMap === 'object') {
    for (const [k, v] of Object.entries(body.companyMap)) {
      if (typeof k === 'string' && typeof v === 'string') companyMap[k] = v;
    }
  }
  const res = await saveBranding(
    { companyDefault: String(body.companyDefault ?? ''), companyMap },
    sess.sub
  );
  if (!res.ok) return jsonErr(503, res.error || 'failed to save branding');
  await writeAudit({ actor: sess.sub, action: 'config.branding', detail: { domains: Object.keys(companyMap).length } });
  return jsonOk({ ok: true, ...(await getBranding({ fresh: true })) });
}
