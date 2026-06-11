// instrumentation.ts — Next.js server bootstrap (runs once per server process via register()).
//
// Node runtime only (Mongo isn't reachable from the Edge). Two background jobs, by mode:
//   • DEMO MODE: seed the read-only demo_seed DB (once) + a periodic GC of idle per-visitor sandbox
//     databases (lib/demo.gcDemoSandboxes) so visitor churn can't grow Mongo unbounded.
//   • PROD: the flight auto-refresh sweep (lib/integrations/flight-refresh) — re-polls AeroDataBox for
//     flights departing within the day-before/day-of window and tracks delays. It no-ops until an
//     AeroDataBox key is configured; kill switch: EIT_FLIGHT_REFRESH=0.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // ── DEMO: seed + sandbox GC ────────────────────────────────────────────────────────────────────
  if (process.env.EIT_DEMO_MODE === '1') {
    const { mongoClient } = await import('@/lib/db/mongo');
    const { gcDemoSandboxes, DEMO_SEED_DB } = await import('@/lib/db/demo');

    // Populate the read-only demo_seed DB on first boot (if empty) from the bundled seed, so every
    // per-visitor sandbox has content to clone. Idempotent: skips when demo_seed already has events.
    const seedIfEmpty = async () => {
      try {
        const client = await mongoClient();
        const seedDb = client.db(DEMO_SEED_DB);
        if ((await seedDb.collection('events').countDocuments({}, { limit: 1 })) > 0) return;
        const dump = (await import('@/demo-seed.json')).default as { collections?: Record<string, Record<string, unknown>[]> };
        let total = 0;
        for (const [name, docs] of Object.entries(dump.collections || {})) {
          if (Array.isArray(docs) && docs.length) { await seedDb.collection(name).insertMany(docs, { ordered: false }); total += docs.length; }
        }
        console.log(`[demo-seed] populated ${DEMO_SEED_DB} with ${total} docs`);
      } catch (e) {
        console.warn('[demo-seed] seed failed:', e instanceof Error ? e.message : e);
      }
    };
    await seedIfEmpty();

    const runGc = async () => {
      try {
        const client = await mongoClient();
        const dropped = await gcDemoSandboxes(client);
        if (dropped) console.log(`[demo-gc] dropped ${dropped} idle sandbox database(s)`);
      } catch (e) {
        console.warn('[demo-gc] sweep failed:', e instanceof Error ? e.message : e);
      }
    };
    setTimeout(() => void runGc(), 60_000); // first sweep a minute after boot
    setInterval(() => void runGc(), 10 * 60_000); // then every 10 minutes
    return;
  }

  // ── PROD: flight auto-refresh ────────────────────────────────────────────────────────────────────
  if (process.env.EIT_FLIGHT_REFRESH === '0') return; // explicit kill switch
  const { runFlightRefresh } = await import('@/lib/integrations/flight-refresh');
  const sweep = async () => {
    try {
      const r = await runFlightRefresh();
      if (r.calls > 0 || r.alerts > 0) {
        console.log(`[flight-refresh] checked ${r.checked} · updated ${r.updated} · alerts ${r.alerts} · calls ${r.calls}`);
      }
    } catch (e) {
      console.warn('[flight-refresh] sweep failed:', e instanceof Error ? e.message : e);
    }
  };
  // First sweep ~2 min after boot (let the app settle), then every 20 min. The per-leg cadence inside
  // the sweep (day-before ~12h / day-of ~3h / final-approach ~24min) does the real throttling, so a
  // frequent tick is cheap — it just lets a near-departure flight be re-polled often enough to catch a
  // last-hour delay; the budget governor still caps non-imminent spend.
  setTimeout(() => void sweep(), 2 * 60_000);
  setInterval(() => void sweep(), 20 * 60_000);
}
