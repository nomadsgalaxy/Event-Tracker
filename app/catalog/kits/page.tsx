import { redirect } from 'next/navigation';

// Road Kits now live as a VIEW of the catalog (so the catalog sidebar is retained). This route is a
// permanent deep-link shim → the catalog with the kits view selected.
export const dynamic = 'force-dynamic';

export default function RoadKitsRedirect() {
  redirect('/catalog?view=kits');
}
