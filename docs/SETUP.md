# Setup & deployment

How to run Event Tracker for local development and self-host it in production. Everything is
configured with environment variables; there is no config file to edit.

- [Prerequisites](#prerequisites)
- [MongoDB](#mongodb)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Production build](#production-build)
- [Docker](#docker)
- [Google sign-in (OIDC)](#google-sign-in-oidc)
- [First admin](#first-admin)
- [Deployment tenant & Data Matrix](#deployment-tenant--data-matrix)
- [Integration keys](#integration-keys)
- [Demo mode](#demo-mode)
- [Data model & backups](#data-model--backups)
- [Operational notes](#operational-notes)

## Prerequisites

- **Node.js 22+** (the Docker image builds on `node:22-alpine`).
- **MongoDB 7+** reachable from the app.
- **Docker** (optional, for the container build).

## MongoDB

The app talks to MongoDB through the official driver with the official driver's `MONGO_URI`. A plain
standalone `mongod` is enough - **no replica set is required**. Point `MONGO_URI` at it and set
`MONGO_DB` (default `event_tracker`). The connection is lazy, so `next build` does not need a
database; at request time a missing `MONGO_URI` throws and an unreachable database fails fast.

The URI may carry credentials (`mongodb+srv://user:pass@host/...`); it is server-only and never sent
to the browser. Keep it out of git - put real values in `.env.local` (dev) or your container's env
(prod), not in `.env.example`.

## Environment variables

`process.env` is read server-side at runtime unless noted as **build-time** (`NEXT_PUBLIC_*` values
are inlined into the browser bundle at build and need a rebuild to change).

### Core (required)

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGO_URI` | - | MongoDB connection string. Required to serve requests. |
| `MONGO_DB` | `event_tracker` | Database name. Also the fallback deployment-tenant id. |
| `ET_SESSION_SECRET` | - | **≥16 chars, required.** See the warning below. |

> **`ET_SESSION_SECRET` is the single most load-bearing value.** It signs session cookies and derives
> the keys that encrypt integration keys at rest, wrap TOTP secrets, and sign passkey, calendar, and
> OAuth tokens. Generate it with `openssl rand -hex 32`. Every consumer fails loud if it is missing or
> under 16 characters (it never silently falls back to a weak key). **Rotating it logs everyone out,
> invalidates stored TOTP secrets and calendar tokens, and makes any AES-encrypted integration keys
> unrecoverable** - so set it once and keep it safe.

### Public URL (recommended behind a proxy)

| Variable | Default | Notes |
| --- | --- | --- |
| `EIT_PUBLIC_URL` | request origin | Public base URL, e.g. `https://events.example.com`. |

Behind a reverse proxy (nginx, Cloudflare Tunnel, etc.) the request URL resolves to the internal bind
host (like `0.0.0.0:3100`), so set `EIT_PUBLIC_URL` to your real URL. It pins the OAuth `redirect_uri`
(Google sign-in breaks without it), the WebAuthn relying-party id and expected origin for passkeys,
and the absolute calendar-feed URLs.

### Auth & access

| Variable | Default | Notes |
| --- | --- | --- |
| `EIT_ADMIN_EMAILS` | - | Comma/space-separated emails that are always admin (cannot be demoted). |
| `GOOGLE_CLIENT_ID` | - | Enables Google sign-in when set with the secret. |
| `GOOGLE_CLIENT_SECRET` | - | OAuth client secret (server-only). |
| `EIT_OIDC_ALLOWED_DOMAINS` | open | Comma/space-separated email-domain allowlist for SSO. Empty = any verified Google email may sign in, landing read-only. |

### Deployment tenant (Data Matrix)

| Variable | Default | Notes |
| --- | --- | --- |
| `EIT_TENANT_ID` | `MONGO_DB` | Tenant id hashed into every Data Matrix code. See [below](#deployment-tenant--data-matrix). |

### Integration keys (all optional)

Each integration resolves its key in this order: **environment variable wins**, else the in-app
encrypted settings store (Config → Databases & API), else a legacy config doc. So you can set a key in
the UI without a redeploy, and env always overrides.

| Variable | Powers |
| --- | --- |
| `GOOGLE_API_KEY` (or `GOOGLE_PLACES_API_KEY`) | Address autocomplete / Places (server side). |
| `GOOGLE_API_KEY` (or `GOOGLE_WEATHER_API_KEY`) | Venue weather forecast. |
| `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` | **build-time**, optional browser Places key (referrer-restricted). |
| `AERODATABOX_API_KEY` (or `FLIGHT_API_KEY`, `FLIGHT_RAPIDAPI_KEY`, `RAPIDAPI_KEY`) | Flight lookup (AeroDataBox/RapidAPI). |
| `AERODATABOX_API_HOST` | RapidAPI host (default `aerodatabox.p.rapidapi.com`). |
| `EASYPOST_API_KEY` | EasyPost shipment tracking. |
| `AFTERSHIP_API_KEY` | AfterShip / UniShippers tracking. |
| `SEVENTEENTRACK_API_KEY` (or `TRACK17_API_KEY`) | 17TRACK free-tier tracking. |

Without a given key, that feature degrades gracefully (manual entry / hidden), nothing breaks.

### Build / version

| Variable | Default | Notes |
| --- | --- | --- |
| `BUILD_ID` | timestamp | **build-time.** Set to the git SHA for a meaningful version stamp; drives the auto-reload-after-deploy watcher. |

### Demo mode

| Variable | Default | Notes |
| --- | --- | --- |
| `EIT_DEMO_MODE` | off | `1` turns on the public sandbox build (also inlines `NEXT_PUBLIC_DEMO_MODE` at build). |
| `EIT_DEMO_USER` | `demo@example.com` | Synthetic auto-sign-in user. |
| `EIT_DEMO_SEED_DB` | `demo_seed` | Read-only DB each sandbox is cloned from. |

## Local development

```bash
cp .env.example .env.local
# edit .env.local: set MONGO_URI and ET_SESSION_SECRET (openssl rand -hex 32)
npm install
npm run dev          # http://localhost:3100
```

Scripts: `npm run dev` (dev server on port 3100), `npm run build` (production build), `npm start`
(serve the build), `npm run lint`.

> Do **not** run `npm run build` while `npm run dev` is running against the same checkout - it
> corrupts the shared `.next` directory. Stop dev first, or build in a container (isolated).

## Production build

```bash
npm ci
npm run build        # produces a standalone server in .next/standalone
npm start            # or: node .next/standalone/server.js
```

`next.config.mjs` sets `output: 'standalone'`, so the build emits a self-contained server with only
its traced dependencies.

## Docker

```bash
docker build -t event-tracker --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
docker run -p 3100:3100 --env-file .env.production event-tracker
```

The multi-stage `Dockerfile` builds the standalone server and runs it as a non-root user on
`PORT=3100`. Build args: `BUILD_ID` (version stamp) and `EIT_DEMO_MODE` (set to `1` to bake a demo
build, since `NEXT_PUBLIC_DEMO_MODE` is inlined at build time). All other config is runtime env.

A reverse proxy should terminate TLS and forward to `:3100`; set `EIT_PUBLIC_URL` to the public URL.

## Google sign-in (OIDC)

1. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application).
2. Add the authorized redirect URI: `https://your-domain.example/api/auth/google/callback`
   (replace with your `EIT_PUBLIC_URL`).
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `EIT_PUBLIC_URL`.
4. Optionally set `EIT_OIDC_ALLOWED_DOMAINS` to restrict who can sign in.

A verified Google email binds to the directory account with the same email (the email is the identity
key), so a user can have both a password and Google sign-in. A brand-new email that is not an admin or
in the allowlist is provisioned read-only. Password and passkey sign-in keep working whether or not
Google is configured.

## First admin

There is no seeded account. Put your email in `EIT_ADMIN_EMAILS`, then either sign in with Google (if
configured) or register a local password for that email at `/login`. Admin emails in
`EIT_ADMIN_EMAILS` always resolve to the admin role and cannot be demoted by a directory write, so the
first admin is whoever you list there.

## Deployment tenant & Data Matrix

Every Data Matrix label encodes a tenant hash so a code printed by one deployment will not resolve on
another. The tenant string is resolved in this order:

1. an admin override set in Config → Admin,
2. the email domain of the earliest-created user,
3. `EIT_TENANT_ID`, then `MONGO_DB`.

**This must stay stable.** If it changes, labels printed earlier stop scanning ("belongs to another
deployment"). For a fresh install you usually do not need to set anything. If you have already printed
labels and want to pin the value so it cannot drift, set `EIT_TENANT_ID` and confirm a real label
still scans on the `/scan` screen.

## Integration keys

For a from-scratch, click-by-click walkthrough of each provider (creating the Google key + which APIs
to enable, AeroDataBox, the shipment trackers) see **[API_KEYS.md](API_KEYS.md)**. The short version:

Optional keys (Places, weather, flight lookup, shipment tracking) can be set two ways:

- **Environment** (the table above) - wins, good for infrastructure-managed secrets.
- **In-app**, under Config → Databases & API - stored AES-encrypted (the key is derived from
  `ET_SESSION_SECRET`), so an admin can enable a feature without a redeploy.

Because the in-app store is encrypted with a key derived from `ET_SESSION_SECRET`, rotating that
secret makes previously stored integration keys unreadable (re-enter them).

## Demo mode

`EIT_DEMO_MODE=1` (with `ET_SESSION_SECRET` set) runs a public, self-resetting sandbox:

- Each visitor gets an isolated MongoDB database `demo_<sid>`, keyed only by an unguessable
  HMAC-signed cookie, lazily cloned from a read-only seed.
- Admin and config writes are blocked; signed-out visitors are auto-signed-in as `EIT_DEMO_USER`.
- On first boot the seed database (`EIT_DEMO_SEED_DB`, default `demo_seed`) is populated from the
  bundled `demo-seed.json` if empty, and an idle-sandbox garbage-collector sweeps old databases.

A ready-to-run compose file is included:

```bash
ET_SESSION_SECRET=$(openssl rand -hex 32) BUILD_ID=$(git rev-parse --short HEAD) \
  docker compose -f docker-compose.demo.yml up -d --build
```

To give the demo user the (read-only) admin console, also add `EIT_DEMO_USER` to `EIT_ADMIN_EMAILS`.
Reset the demo by dropping the `demo_*` databases and restarting.

## Data model & backups

Domain collections (`events`, `cases`, `inventory`, `warehouses`, `tags`, `users`,
`emergency_contact`) use an envelope document: `{ _id, payload: {…}, createdAt, updatedAt, deletedAt }`.
Deletes are soft (a `deletedAt` tombstone). `auth` and `audit_log` are stored flat. Writes update only
changed fields (`$set` into `payload.*`), never a full-document replace.

Back up with `mongodump` against `MONGO_DB`; restore with `mongorestore`. Because the data is
self-contained envelopes, a dump/restore is a clean migration between hosts.

## Operational notes

- **Version watcher**: set `BUILD_ID` to the git SHA per deploy. Open tabs poll `/api/version` and
  reload onto a new build.
- **Secret rotation**: rotating `ET_SESSION_SECRET` logs everyone out and invalidates TOTP-at-rest,
  calendar tokens, and stored encrypted integration keys. Plan for it.
- **Roles**: admin, manager, lead, authorized, read-only. Travel/lodging PII is gated server-side per
  (event, staffer); non-privileged clients never receive it over the wire.
