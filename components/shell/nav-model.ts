import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Calendar,
  ClipboardList,
  ScanLine,
  CheckSquare,
  Boxes,
  BarChart3,
  Settings,
} from 'lucide-react';

// nav-model.ts — the SINGLE SOURCE OF TRUTH for the Event Tracker app-shell navigation.
//
// This mirrors SCREEN_ORDER / SCREENS in the canonical single-file app (../../index.html) and the
// IA in DESIGN_ALIGNMENT.md §2.1. Both the desktop TopNav (center segmented nav + ⋯ overflow) and
// the MobileTabBar read from here so the order can never drift between the two surfaces.
//
// CRITICAL organizational facts encoded here:
//   • Catalog is ONE nav item (it splits into Roadcases + Inventory INSIDE the screen, with
//     Warehouse as a filter). Cases / Tags / Warehouses are detail/drill-in, NEVER nav tabs.
//   • Account (/account) and Activity (/activity) are reachable ONLY from the user menu — they are
//     deliberately NOT in this PRIMARY_NAV array (mirrors NAV_EXCLUDED = {account, activity}).
//   • Config is admin-only; gate its visibility with the `adminOnly` flag (the real boundary is the
//     server-side requireRole('admin') on the /config layout — hiding the link is UX, not security).

export interface NavItem {
  /** Stable screen id (mirrors the source SCREENS id). */
  id: string;
  /** Route base. */
  href: string;
  /** Nav label (Title Case as shown in the bar). */
  label: string;
  /** Lucide icon — used by the mobile tab bar and the ⋯ overflow menu. */
  icon: LucideIcon;
  /** Exact-match the active route (true only for the dashboard root '/'). */
  exact?: boolean;
  /** Visible signed-out (public read-only floor). DESIGN_ALIGNMENT §1.5. */
  public?: boolean;
  /** Only render for admins (Config). */
  adminOnly?: boolean;
  /** Surface in the mobile bottom tab bar (the high-traffic "floor"). */
  mobile?: boolean;
}

/**
 * PRIMARY_NAV — the 8 workflow screens in their canonical order:
 *   Dashboard · Calendar · Manifest · Scan-Pack · Sign-Off · Catalog · Reports · Config
 * The active item renders as a solid ORANGE PILL in the center nav. Trailing items that don't fit
 * collapse into a ⋯ overflow DropdownMenu (TopNav owns that responsive logic).
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: 'dashboard', href: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true, public: true, mobile: true },
  { id: 'calendar', href: '/calendar', label: 'Calendar', icon: Calendar, public: true, mobile: true },
  { id: 'manifest', href: '/manifest', label: 'Manifest', icon: ClipboardList, public: true, mobile: true },
  { id: 'scan', href: '/scan', label: 'Scan-Pack', icon: ScanLine, mobile: true },
  { id: 'signoff', href: '/signoff', label: 'Sign-Off', icon: CheckSquare, mobile: true },
  { id: 'catalog', href: '/catalog', label: 'Catalog', icon: Boxes, mobile: true },
  { id: 'reports', href: '/reports', label: 'Reports', icon: BarChart3 },
  { id: 'config', href: '/config', label: 'Config', icon: Settings, adminOnly: true },
] as const;

/**
 * USER_MENU_NAV — the destinations reachable ONLY from the avatar dropdown, never the primary nav
 * (Account & Preferences, Activity log). Log Off is rendered separately (it calls a Server Action,
 * not a link). Kept here so the "menu-only" set is declared in one place alongside PRIMARY_NAV.
 */
export const USER_MENU_NAV = [
  { id: 'account', href: '/account', label: 'Account & Preferences' },
  { id: 'activity', href: '/activity', label: 'Activity log' },
] as const;

/**
 * isNavActive — shared active-route test for the desktop nav, the ⋯ overflow, and the mobile bar.
 * Dashboard ('/') matches only exactly; every other item matches itself or any deeper path
 * (e.g. /catalog/cases keeps Catalog lit). This is the same prefix rule config-nav.tsx uses.
 */
export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + '/');
}

/**
 * visibleNav — filter PRIMARY_NAV for the current viewer. Admin-only items (Config) drop for
 * non-admins. (Public-vs-privileged hiding for signed-out users is applied by the caller, which
 * knows the live auth state; this keeps the model pure.)
 */
export function visibleNav(opts: { isAdmin: boolean }): NavItem[] {
  return PRIMARY_NAV.filter((n) => (n.adminOnly ? opts.isAdmin : true));
}

/** The mobile-floor subset, in order, respecting admin visibility. */
export function mobileNav(opts: { isAdmin: boolean }): NavItem[] {
  return visibleNav(opts).filter((n) => n.mobile);
}
