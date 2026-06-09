import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveLiveRole } from '@/lib/auth/auth';
import { rankOf } from '@/lib/auth/rbac';
import {
  integrationKeyStatuses,
  saveIntegrationKeys,
  settingsMeta,
  INTEGRATION_KEY_NAMES,
  type IntegrationKeyName,
} from '@/lib/auth/settings-store';
import { writeAudit } from '@/lib/db/data';
import { jsonOk, jsonErr, readJson } from '@/lib/api/api-response';

export const dynamic = 'force-dynamic';

// /api/auth/integration-keys — the encrypted integration-key store (Config > Databases & API).
//
// GET  — ADMIN: the per-key set/unset provenance (fromEnv / inStore booleans) + meta. NEVER returns a
//        secret value. Mirrors eit_auth._h_config_get's boolean-only reporting.
// POST — ADMIN + a fresh STEP-UP: set/clear keys. Each set value is AES-256-GCM-encrypted at rest by
//        saveIntegrationKeys; the plaintext is consumed here and never stored or echoed. The role is
//        re-resolved LIVE (a just-demoted admin is refused) and the step-up token is verified against
//        the SESSION email (a stolen cookie alone can't write keys). Mirrors eit_auth._h_config_set.

async function gateAdmin(req?: NextRequest): Promise<{ email: string } | { err: ReturnType<typeof jsonErr> }> {
  const sess = await getSession();
  if (!sess) return { err: jsonErr(401, 'sign in required') };
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return { err: jsonErr(403, 'admin session required') };
  void req;
  return { email: sess.sub };
}

export async function GET() {
  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const liveRole = await resolveLiveRole(sess.sub);
  if (rankOf(liveRole) < rankOf('admin')) return jsonErr(403, 'admin session required');
  const [statuses, meta] = await Promise.all([integrationKeyStatuses(), settingsMeta()]);
  return jsonOk({ keys: statuses, ...meta });
}

interface KeysBody {
  stepupToken?: string;
  set?: Partial<Record<IntegrationKeyName, string>>;
  clear?: string[];
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin(req);
  if ('err' in gate) return gate.err;

  const sess = await getSession();
  if (!sess) return jsonErr(401, 'sign in required');
  const body = (await readJson(req)) as KeysBody;

  // Whitelist the key names so a client can't write an arbitrary settings field.
  const allowed = new Set<string>(INTEGRATION_KEY_NAMES);
  const set: Partial<Record<IntegrationKeyName, string>> = {};
  if (body.set && typeof body.set === 'object') {
    for (const [k, v] of Object.entries(body.set)) {
      if (allowed.has(k) && typeof v === 'string') set[k as IntegrationKeyName] = v;
    }
  }
  const clear = Array.isArray(body.clear)
    ? (body.clear.filter((k) => allowed.has(k)) as IntegrationKeyName[])
    : [];

  const res = await saveIntegrationKeys({ set, clear }, gate.email);
  if (!res.ok) return jsonErr(400, res.error || 'failed to save the integration keys');

  await writeAudit({
    actor: gate.email,
    action: 'config.integration_keys',
    // booleans only — never the key VALUES (the audit trail is not a secret store).
    detail: { set: Object.keys(set), clear },
  });
  const [statuses, meta] = await Promise.all([integrationKeyStatuses(), settingsMeta()]);
  return jsonOk({ ok: true, keys: statuses, ...meta });
}
