# Event Tracker

Self-hosted showcase inventory and event manager. Track inventory, road cases, and events for trade
shows and live-event tours: assign cases to events, print and scan Data Matrix labels, build
manifests, and run the full pack → ship → on-site → return → unpack lifecycle on your own server.

Built with Next.js (App Router), React, TypeScript, Tailwind, and MongoDB. Live-DB only: every read
and write goes straight to your database, so there is no stale local cache to reconcile.

## Features

- **Inventory, road cases, and events** in one catalog, with case→event assignment.
- **Packing manifests** built from shared helpers so per-case and per-event counts never drift, with
  printable manifest sheets.
- **Data Matrix labels** for cases, items, and events: print crisp SVG labels and scan them with the
  camera (ZXing) or Web NFC to pack, check in, and check out.
- **Event lifecycle** states (draft → upcoming → packing → ready → in transit → on-site → returning →
  closed) that drive case availability, calendar, and dashboard filtering.
- **Kits / BOM**, multi-SKU listings, and both serial and bulk item tracking.
- **Warehouses and transfers**: each case has a home (return) warehouse and an optional current
  location, with in-transit derivation.
- **Sign-off flows** for ship-kit and return, with per-case and per-item disposition.
- **Travel and lodging** per event, optional flight lookup and venue weather, and per-staffer travel
  PII gated server-side.
- **Calendar feeds** (.ics subscription, per-user token), **reports** with CSV export, and a
  **notifications** bell.
- **Accounts and roles** (admin, manager, lead, authorized, read-only) with local passwords, optional
  TOTP 2FA, passkeys / WebAuthn, recovery codes, and Google sign-in (OIDC).
- **Server-authoritative auth and RBAC** with a PII gate on every data path, never client-trusted.
- Optional **public demo mode**: each visitor gets an isolated, self-resetting sandbox.

## Tech stack

Next.js 16 (App Router, React Server Components + Server Actions) · React 19 · TypeScript · Tailwind
CSS v4 · MongoDB (official `mongodb` driver) · self-hostable via Docker.

## Quick start

### Local development

Requires Node.js 22+ and a MongoDB you can reach (a standalone `mongod` is fine, no replica set
needed).

```bash
cp .env.example .env.local        # set MONGO_URI + ET_SESSION_SECRET (see below)
npm install
npm run dev                       # http://localhost:3100
```

Minimum to boot: `MONGO_URI` and a `ET_SESSION_SECRET` of at least 16 characters
(`openssl rand -hex 32`). Everything else is optional and enables specific features.

### Docker

```bash
# build the production image
docker build -t event-tracker .

# run it against your MongoDB (set the real values in an env file, not on the command line)
docker run -p 3100:3100 --env-file .env.production event-tracker
```

The image is a standalone Next.js server (it does not need the database to build). See
[docs/SETUP.md](docs/SETUP.md) for a full deployment walk-through and a demo-mode compose file.

## Configuration

All configuration is environment variables. The load-bearing ones:

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGO_URI` | yes | MongoDB connection string. |
| `MONGO_DB` | no | Database name (default `event_tracker`). |
| `ET_SESSION_SECRET` | yes | ≥16-char secret; signs sessions and derives at-rest encryption keys. |
| `EIT_PUBLIC_URL` | behind a proxy | Public base URL; pins OAuth/passkey origin and calendar URLs. |
| `EIT_ADMIN_EMAILS` | first run | Comma-separated emails that are always admin. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for SSO | Enables Google sign-in. |

The complete reference (the deployment tenant for Data Matrix, demo mode, etc.) is in
**[docs/SETUP.md](docs/SETUP.md)**. To enable address autocomplete, weather, flight lookup, or
shipment tracking, follow the step-by-step **[docs/API_KEYS.md](docs/API_KEYS.md)**.

## First sign-in

There is no seeded admin account. Set `EIT_ADMIN_EMAILS` to your address, then sign in with Google
(if configured) or register a local password for that email; admin emails always resolve to the admin
role. See [docs/SETUP.md](docs/SETUP.md#first-admin) for details.

## Demo mode

Set `EIT_DEMO_MODE=1` (and `ET_SESSION_SECRET`) to run a public, self-resetting demo: visitors are
auto-signed-in to an isolated per-browser sandbox cloned from a read-only seed, and admin/config
writes are blocked. See [docs/SETUP.md](docs/SETUP.md#demo-mode).

## License

See [LICENSE](LICENSE) and [NOTICE](NOTICE).
