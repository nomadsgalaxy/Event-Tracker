import { Eyebrow } from '@/components/ui/eyebrow';
import type { DashKpis } from '@/lib/types-dashboard';

// DashboardHero — the editorial "SEASON AT A GLANCE" headline (DESIGN_ALIGNMENT §4.1, matched 1:1 to
// the Python app's DashHybrid hero, index.html ~L15495-15506).
//
// LINE 1 = the count of THIS-YEAR events (eventsThisYear.length) — NOT the filtered view size. The
// Python hero is a stable "season at a glance" number that does not track the sidebar filter
// (index.html ~L15497). LINE 2 = the cross-join "items in motion" KPI, painted brand orange.
//
// The paragraph is the Python's DYNAMIC, context-aware copy (~L15500-15506): empty-year guidance when
// there are no events this year, else the items-in-motion explanation that names the show count.

export function DashboardHero({
  kpis,
  year,
}: {
  /** The season-at-a-glance KPI numbers (eventsThisYear drives line 1 + the copy). */
  kpis: DashKpis;
  /** The current calendar year (the empty-year copy names it). */
  year: number;
}) {
  const yearCount = kpis.eventsThisYear;
  const shows = `${yearCount} ${yearCount === 1 ? 'SHOW' : 'SHOWS'}.`;
  const motion = `${kpis.itemsInMotion} ${
    kpis.itemsInMotion === 1 ? 'ITEM' : 'ITEMS'
  } IN MOTION.`;

  // Context-aware paragraph — verbatim phrasing from the Python hero.
  const copy =
    yearCount === 0
      ? `No events scheduled in ${year} yet. Click New event to get started.`
      : `Across the ${yearCount} ${year} ${yearCount === 1 ? 'show' : 'shows'}, items in motion counts ` +
        `every printer, peripheral, and consumable currently bound to an active event — packing, on ` +
        `site, or returning. Draft and closed events don't count.`;

  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>Season at a glance</Eyebrow>
      {/* One <h2> (the page's <h1> is the ScreenHeader eyebrow/title row above). */}
      <h2 className="text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
        <span className="tabular-nums">{shows}</span>
        <br />
        <span className="text-primary tabular-nums">{motion}</span>
      </h2>
      <p className="max-w-xl text-sm text-muted-foreground">{copy}</p>
    </div>
  );
}

export default DashboardHero;
