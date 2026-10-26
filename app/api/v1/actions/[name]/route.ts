import { withKey, apiOk, apiErr, readBody, requireCap, auditKeyWrite } from '@/lib/api/api-v1';
import { runAsKeyOwner } from '@/lib/auth/session';
import { resolveAction, decodeArg, controlFlow } from '@/lib/api/api-v1-actions';

export const dynamic = 'force-dynamic';

// /api/v1/actions/:name — run one of the app's own server actions as the key's owner (api.fullaccess).
//
// The action runs exactly as it does from the UI: getSession() resolves to the key owner (see
// runAsKeyOwner), so every action's own live-role checks still apply and a key never does more than
// its owner could in the browser. Names are "<module>.<action>", e.g. "cases.retireOrDeleteCaseAction".
//
// POST — body { args: [...] }. An arg shaped { $formData: {k: v | v[]} } is turned into a FormData,
//        for the actions that take one (catalog.saveItemAction, scan.packItemAction, …).

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  return withKey(req, async (vk) => {
    requireCap(vk, 'api.fullaccess');
    const { name } = await ctx.params;
    const fn = resolveAction(name);
    if (!fn) return apiErr(404, `unknown or blocked action '${name}' (GET /api/v1/actions lists them)`);
    const body = await readBody(req);
    const args = Array.isArray(body.args) ? body.args.map(decodeArg) : [];

    let result: unknown;
    try {
      result = await runAsKeyOwner({ email: vk.ownerEmail, role: vk.role, keyId: vk.keyId }, () => fn(...args));
    } catch (e) {
      const cf = controlFlow(e);
      if (!cf) throw e;
      result = cf;
    }
    await auditKeyWrite(vk, req, `api.action.${name}`, null);
    return apiOk({ result: result ?? null });
  });
}
