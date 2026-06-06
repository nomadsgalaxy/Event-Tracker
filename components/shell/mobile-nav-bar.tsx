import { getCurrentUser } from '@/lib/auth';
import { rankOf } from '@/lib/rbac';
import { MobileTabBar } from './mobile-tab-bar';

// mobile-nav-bar.tsx — the server wrapper that resolves the live auth state and feeds the client
// MobileTabBar its (admin-aware) item set. Kept separate from TopBar so the bottom bar can compute
// its own mobile-floor subset (mobileNav) without the TopBar re-exporting it. Both read
// getCurrentUser independently — cheap, and each owns its own data (no prop-drilling through the
// shell). Signed-out users still get the public floor (Dashboard/Calendar/Manifest); Config only
// appears for admins.

export async function MobileNavBar() {
  const user = await getCurrentUser();
  const isAdmin = !!user && rankOf(user.role) >= rankOf('admin');
  return <MobileTabBar isAdmin={isAdmin} />;
}

export default MobileNavBar;
