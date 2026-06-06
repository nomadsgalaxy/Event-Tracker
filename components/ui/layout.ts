// Barrel for the shared LAYOUT primitives that encode the existing app's organization
// (DESIGN_ALIGNMENT.md §5 / §7 step 8). Import from '@/components/ui/layout' OR from the individual
// files — both work. These compose shadcn primitives, are tokens-only, and forward className.
//
// RSC note: Eyebrow / ScreenHeader / SidebarRail / KpiStrip / ProgressBar / DetailRow are Server-
// Component-safe (no hooks). TabStrip is a Client Component ('use client' in its own file); the
// client boundary is preserved through this barrel. SidebarItem renders a <Link> or <button> but
// stays RSC-safe — the active flag is passed in by a small client island (usePathname), mirroring
// app/config/config-nav.tsx.

export { Eyebrow } from '@/components/ui/eyebrow';
export type { EyebrowProps } from '@/components/ui/eyebrow';

export { ScreenHeader } from '@/components/ui/screen-header';
export type { ScreenHeaderProps } from '@/components/ui/screen-header';

export { SidebarRail, SidebarSection, SidebarItem } from '@/components/ui/sidebar-rail';
export type {
  SidebarRailProps,
  SidebarSectionProps,
  SidebarItemProps,
} from '@/components/ui/sidebar-rail';

export { TabStrip } from '@/components/ui/tab-strip';
export type { TabStripProps, TabStripItem } from '@/components/ui/tab-strip';

export { KpiStrip, KpiCard } from '@/components/ui/kpi-strip';
export type { KpiCardProps } from '@/components/ui/kpi-strip';

export { ProgressBar } from '@/components/ui/progress-bar';
export type { ProgressBarProps } from '@/components/ui/progress-bar';

export { DetailRow } from '@/components/ui/detail-row';
export type { DetailRowProps } from '@/components/ui/detail-row';
