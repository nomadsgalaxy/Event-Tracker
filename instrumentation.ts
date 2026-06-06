// instrumentation.ts — Next.js server bootstrap (runs once per server process via register()).
//
// In DEMO MODE this is where the per-visitor sandbox GARBAGE COLLECTOR runs: a periodic sweep that
// drops idle demo_<sid> databases (see lib/demo.gcDemoSandboxes), so a visitor churn / a cookie-delete
// loop can't grow Mongo unbounded. Node runtime only (Mongo isn't reachable from the Edge), and only
// when EIT_DEMO_MODE=1 — otherwise this is a no-op for prod/main.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.EIT_DEMO_MODE !== '1') return;

  const { mongoClient } = await import('@/lib/mongo');
  const { gcDemoSandboxes, DEMO_SEED_DB } = await import('@/lib/demo');

  // Populate the read-only demo_seed DB on first boot (if empty) from the bundled seed, so every
  // per-visitor sandbox has content to clone. Idempotent: skips when demo_seed already has events.
  // Awaited before the GC schedule so the seed exists before any visitor's ensureSandbox runs.
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

  // First sweep a minute after boot (let the app settle), then every 10 minutes.
  setTimeout(() => void runGc(), 60_000);
  setInterval(() => void runGc(), 10 * 60_000);
}
