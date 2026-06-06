# Event Tracker — Next.js rewrite

A full-stack **Next.js 15 (App Router) + TypeScript** rewrite of Event Tracker, built to compare
head-to-head against the Python + single-HTML-file version (at the repo root / on `main`).

## Why this exists

The owner's call: move off the 31k-line `index.html` (in-browser babel, no modules, no types,
`window.*` everything) to a real dynamic web app, and off the **localStorage-first → push-to-Mongo**
data model that caused the desync bugs. This branch is the **Next.js version** of the comparison.

## Architecture (this version)

- **Live-DB only.** No localStorage source of truth, no offline cache. Every read/write is a real
  DB call. Server Components / Route Handlers query **Mongo directly** (official `mongodb` driver).
  A missing/unreachable DB is a hard error, not a silent stale read.
- **Same data, same Mongo** as the Python version — identical `{_id, payload, …}` envelopes
  (`lib/types.ts`) — so the comparison measures the *stack*, not the data.
- **Server-authoritative auth/RBAC** (auth phase, in progress): the security model from the Python
  `eit_auth`/`eit_perms`/`handle_db`/PII-strip gets ported to a single server-side gate every data
  op calls — never client-trusted. (Until then this scaffold is read-only and unauthenticated.)

## Run it

```bash
cd nextjs
cp .env.example .env.local      # set MONGO_URI to the same Mongo (or a dev copy) the Python app uses
npm install
npm run dev                      # http://localhost:3100
```

## Status

- [x] Foundation: Next.js 15 + TS, live Mongo data layer, design tokens, app shell.
- [x] Dashboard — live event list from Mongo (Server Component).
- [ ] Auth + RBAC port (server-side gate) — the security-critical phase.
- [ ] Event editor (the tabbed form where #90/#93 lived — the real test).
- [ ] Scan-pack, manifests, travel/PII, shipping, sign-off, warehouses, calendar, notifications.

See `../NEXTJS_MIGRATION_BRIEF.md` and the architecture team's `NEXTJS_ARCHITECTURE.md` for the
full plan + phased roadmap.
