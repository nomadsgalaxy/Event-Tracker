# REST API + MCP server

Event Tracker has a scoped REST API at `/api/v1` and a standalone MCP server (`eit_mcp/`) that talks to
it. You create your own API keys, and a key carries a slice of **your** permissions: it can never do
more than you can, and only the capabilities you tick when you make it.

- [Create a key](#create-a-key)
- [How scope works](#how-scope-works)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
- [The generic collection mirror](#the-generic-collection-mirror)
- [Rate limit and audit](#rate-limit-and-audit)
- [MCP server](#mcp-server)

## Create a key

**Account → Security → API keys.** Give the key a label, tick the capabilities it should carry, and
copy the token shown once (you can't see it again). It looks like `eitk_<id>.<secret>`.

- The capability list is limited to what your own role can do. You can't put a capability on a key that
  you don't hold.
- Leave everything unticked for a **read-only** key. "Match my access" ticks everything your role
  allows.
- Creating a key needs a local password and a fresh step-up re-auth. Pure-SSO accounts set a local
  password first.

## How scope works

A request succeeds only when **both** are true: the key was scoped to the capability, AND your live
role still grants it. In short, `effective = key's caps ∩ your current role`.

That intersection is re-checked on every request against the live database, so:

- A key can never exceed its owner.
- If you're demoted (or an admin narrows a role in the permissions table), every key you hold narrows
  immediately, with no key edit.
- Events come back PII-stripped to the key's scope: a key without `staff.pii.view` never sees staff
  travel, lodging, or post-event feedback (`staff[].feedback` — the "How was your stay?" survey), the
  same gate the UI applies.

The `auth` collection and the audit log are never reachable through the API.

## Authentication

Send the token as a bearer header (or `X-Api-Key`):

```bash
curl -H "Authorization: Bearer eitk_<id>.<secret>" https://your-server.example.com/api/v1/whoami
```

`whoami` is the best first call: it returns your email, live role, and the key's effective capabilities.

## Endpoints

All paths are under `/api/v1`. Reads need the data-read capability; each write needs its matching
capability (shown), re-intersected with your role.

| Method | Path | Capability | Notes |
| ------ | ---- | ---------- | ----- |
| GET | `/whoami` | — | Identify the key (email, role, caps) |
| GET | `/status` | read | Event / case / inventory counts |
| GET | `/events` · `/events/:id` | read | PII-stripped; `:id` includes the manifest |
| POST | `/events` | `event.create` | Create an event |
| POST·PATCH | `/events/:id` | `event.edit` (other fields), `pallets.edit` (`cases`) | Partial update; `brief` is the Event Brief / planning notes (free text — the field AI agents write via the MCP `update_event`) |
| DELETE | `/events/:id` | `event.delete` | Soft-delete |
| POST | `/events/:id/shipment` | `event.edit` | Outbound/return leg |
| POST | `/events/:id/travel` · `/events/:id/lodging` | `staff.pii.view` | Defaults to the key owner |
| GET | `/cases` · `/cases/:id` | read | `:id` includes the packed manifest |
| POST | `/cases` · POST·PATCH `/cases/:id` | `pallets.edit` | Create / edit |
| DELETE | `/cases/:id` | `pallets.edit` | Delete or auto-retire on live FKs |
| GET | `/inventory` · `/inventory/:id` | read | `?q=`, `?low_stock=1`, resolved stock |
| POST | `/inventory` · POST·PATCH `/inventory/:id` | `db.write.app` | Create / edit |
| DELETE | `/inventory/:id` | `db.write.app` | Soft-delete |
| POST | `/inventory/:id/flag` | `db.write.app` | `{ note, severity }` |
| GET | `/search?q=` | read | Cross-entity search |
| GET | `/low-stock` · `/conflicts` | read | Reorder-point + double-booking reports |
| GET·POST | `/webhooks` | admin-owned key (`db.write.app` for POST) | List / register webhook subscriptions |
| DELETE | `/webhooks/:id` · POST `/webhooks/:id/test` | admin-owned key | Remove / test-ping a subscription |

## Webhooks (push and get)

Register endpoints to be notified when things happen — no polling. `POST /api/v1/webhooks` with
`{ "url": "https://…", "events": ["event_state_changed", …], "method": "POST"|"GET", "secret": "…", "description": "…" }`.
Requires a key owned by an admin. Up to 20 subscriptions; `GET /webhooks` lists them (with each
subscription's last delivery status) plus the available event types.

Event types: `item_flagged`, `flight_delay`, `severe_weather`, `ship_kit_signoff`, `low_stock`,
`event_created`, `event_state_changed`, `feedback_submitted`. Payloads never carry staff PII.

Delivery per subscription:

- **POST (push)** — JSON `{ id, event, ts, summary, data }`. With a `secret` set, the request carries
  `X-EIT-Signature: sha256=<hex HMAC-SHA256 of the exact body>` so you can verify authenticity.
- **GET (ping)** — for simple receivers (IFTTT-style, home automation): the URL is called with
  `?event=&ts=&summary=&payload=<compact JSON>` appended, plus `&sig=<hex HMAC of the query string
  without sig>` when a secret is set.

Deliveries are best-effort with a 5s timeout (no retries — poll the REST API for the source of
truth). `POST /webhooks/:id/test` fires a `test` event and reports the receiver's HTTP status. The
single-URL webhook + Slack integration in Config → Admin keeps working independently.

## The generic collection mirror

For anything not covered by a typed route, `/api/v1/db/<collection>` mirrors CRUD over the app
collections (`events`, `cases`, `inventory`, `tags`, `warehouses`, `users`, `emergency_contact`). Every
write routes through the same validation and gates as the UI:

- `GET /db/:collection` (list, `?q=`/`?limit=`/`?offset=`) and `GET /db/:collection/:id`.
- `POST /db/:collection` (create) and `POST /db/:collection/:id` (shallow-merge update), body `{ record }`.
- `POST /db/:collection/:id/delete` (soft-delete).

`users` and `emergency_contact` need a manager/admin role. The `users` mirror returns directory fields
only (never accommodations), and the one permitted `users` write is a role assignment
(`{ "record": { "role": "lead" } }`). `metadata` / `sync_meta` are read-only; `auth` and the audit log
are never accessible.

## Rate limit and audit

Each key is limited to 600 requests/minute by default (set `EIT_API_RATE_LIMIT` on the server to
change it); over the limit returns `429` with `Retry-After`. Every write lands in the same audit log as
a UI write, tagged with the key id.

## MCP server

`eit_mcp/` is a stdio MCP server (Claude Desktop / Claude Code) that wraps this API. Point it at your
instance with a key and it exposes the endpoints above as tools, scoped exactly the same way. See
[`eit_mcp/README.md`](../eit_mcp/README.md) for setup.
