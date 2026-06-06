import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemCode } from '@/lib/integrations/eitm';
import { activeTenantHash36 } from '@/lib/auth/settings-store';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';

export const dynamic = 'force-dynamic';

// GET /api/item/[id]/matrix — the item's AUTO-GENERATED Data Matrix, as { code, svg }. The code is
// `eitm:<tenant>:i:<id>` built deterministically from the item UUID + the active deployment tenant —
// there is no stored/editable matrix. This lets the shared ItemDetailsModal show + print the SAME
// Data Matrix no matter which screen opened it, without every caller threading a server-encoded SVG.
// Signed-in only (the data-plane gate already covers /api/*; the explicit check is belt-and-braces).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const sess = await getSession();
  if (!sess) return Response.json({ error: 'sign in' }, { status: 401 });
  const { id } = await params;
  const itemId = String(id ?? '').trim();
  if (!itemId) return Response.json({ error: 'missing id' }, { status: 400 });

  const tenantHash = await activeTenantHash36();
  const code = itemCode(itemId, tenantHash); // '' when no deployment tenant is configured
  let svg = '';
  if (code) {
    try {
      svg = dataMatrixSvg(code);
    } catch {
      svg = '';
    }
  }
  return Response.json({ code, svg }, { headers: { 'Cache-Control': 'no-store' } });
}
