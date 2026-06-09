import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveLiveRole } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import { getProviderConfigs, providerSecretStatus, saveProviderConfigs, type ProviderConfig } from '@/lib/auth/settings-store';
import { writeAudit } from '@/lib/db/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/oidc-providers — admin CRUD for the configurable sign-in providers (Config > Admin >
// Sign-in providers card). ADMIN-gated (live role). No step-up: admins are OAuth-only (no password to
// re-enter); a full admin session + the audit log are the gate. Client secrets are NEVER returned.
async function requireAdmin(): Promise<{ email: string } | null> {
  const sess = await getSession();
  if (!sess) return null;
  const role = await resolveLiveRole(sess.sub);
  if (rankOf(role) < rankOf('admin')) return null;
  return { email: sess.sub };
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return jsonErr(403, 'admin session required');
  // Providers WITHOUT secrets + a per-provider set/unset map (so the card shows "secret set").
  return jsonOk({ providers: await getProviderConfigs({ fresh: true }), secretStatus: await providerSecretStatus() });
}

interface SaveBody {
  providers?: ProviderConfig[];
  secrets?: Record<string, string>; // id -> newly-entered plaintext (blank/absent keeps the stored one)
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return jsonErr(403, 'admin session required');
  const body = (await readJson(req)) as SaveBody;
  if (!Array.isArray(body.providers)) return jsonErr(400, 'providers must be an array');
  if (body.secrets && typeof body.secrets !== 'object') return jsonErr(400, 'secrets must be an object');

  const res = await saveProviderConfigs(body.providers, body.secrets ?? {}, admin.email);
  if (!res.ok) return jsonErr(400, res.error || 'could not save providers');

  await writeAudit({
    actor: admin.email,
    action: 'config.oauth_providers',
    detail: { count: body.providers.length, ids: body.providers.map((p) => p.id) },
  });
  // Echo back the cleaned providers + secret status — NEVER the secrets themselves.
  return jsonOk({ ok: true, providers: await getProviderConfigs({ fresh: true }), secretStatus: await providerSecretStatus() });
}
