# Event Tracker REST API (v1)

This is the public read/write API that the `eit_mcp` server wraps. It is also
useful for any non-MCP integrator. All endpoints live under `/api/v1` on your
Event Tracker server (the "base URL", e.g. `https://your-server.example.com`) and
return JSON.

> The API itself is part of the Event Tracker server (`eit_api.py`); this
> document only describes it. The MCP server in this directory does not modify
> or reimplement it.

## Authentication

Send an API token on every request via an HTTP header:

```
Authorization: Bearer eitk_<id>.<secret>
```

A token looks like `eitk_<id>.<secret>`. It is **bound to a user** and carries
that user's role and a scope (read or write). A read-only token can only call
the read endpoints; write endpoints (e.g. flagging an item) return `403`.

Mint a token in the Event Tracker UI: **Account → Security → API keys →
Create**, choose **read** or **write** scope, and copy the token (it is shown
**once**).

## Conventions

- All responses are JSON objects.
- List endpoints accept `limit` and `offset` for paging and return
  `{..., total, limit, offset}`.
- Free-text search uses the `q` query parameter.

## Errors

A non-2xx response returns `{"error": "..."}` with one of these status codes:

| Status | Meaning |
| ------ | ------- |
| 401 | Bad or missing token |
| 403 | Read-only / forbidden for this token's role or scope |
| 404 | Resource not found |
| 429 | Rate limited (240 requests/min) |
| 500 | Server error |

## Endpoints

### `GET /api/v1/whoami`
Identify the caller's token.
Returns `{email, role, scope, keyId, keyLabel}`.

### `GET /api/v1/status`
Instance summary counts.
Returns `{counts: {events, cases, inventory}, generatedAt}`.

### `GET /api/v1/inventory`
List inventory items.
Query: `q` (search), `low_stock=1` (only items at/below reorder point),
`limit`, `offset`.
Returns `{items: [...], total, limit, offset}`.

### `GET /api/v1/inventory/<id>`
A single inventory item with resolved stock figures.
Returns `{item: {..., inStorage, stockTotal_resolved}}`.

### `GET /api/v1/cases`
List cases (containers).
Query: `q`, `limit`, `offset`.
Returns `{cases: [...], total, limit, offset}`.

### `GET /api/v1/cases/<id>`
A single case plus its packed manifest.
Returns `{case: {...}, items: [{itemId, name, sku, qr, qty, serials, state}]}`.

### `GET /api/v1/events`
List events.
Query: `q`, `limit`, `offset`.
Returns `{events: [...], total, limit, offset}`.

### `GET /api/v1/events/<id>`
A single event plus its full manifest (cases assigned and their contents).
Returns `{event: {...}, manifest: [{caseId, caseLabel, items: [...]}], shipping: {outbound, return}}`.
(The `manifest[].caseLabel` and top-level `shipping` fields are part of the
enriched read.)

### `GET /api/v1/search`
Cross-entity free-text search.
Query: `q`.
Returns `{query, inventory: [...], cases: [...], events: [...]}`.

### `GET /api/v1/low-stock`
Items at or below their reorder point.
Returns `{lowStock: [{itemId, name, sku, inStorage, reorderPoint, short}], count}`
where `short` is how many units below the reorder point the item is.

### `GET /api/v1/conflicts`
Cases double-booked across time-overlapping events.
Returns `{conflicts: [{caseId, events: [{id, name, start, end, state}, ...]}], count}`.

### `POST /api/v1/inventory/<id>/flag`
Flag an inventory item (**write** — needs a write-scope, non-read-only token).
Body: `{note, severity}` where `severity` is one of `low`, `med`, `high`.
Returns `{ok, itemId, flag}`.

## Write endpoints

All writes require a **write-scope** token whose owner role is above
**read-only** (otherwise `403`).

### Typed event writes (ergonomic — prefer these)

#### `POST /api/v1/events`
Create an event.
Body (only `name` required):
```
{name, state?, website?, startDate?, endDate?, doorsOpen?, doorsClose?, lead?,
 venue?: {name, address, city, state, zip, booth, boothSize,
          contact?: {name, role, email, phone}},
 cases?: [caseId]}
```
`state` must be one of: `draft`, `upcoming`, `packing`, `ready`, `onsite`,
`returning`, `unpacking`, `closed`, `complete`, `cancelled`, `flagged`.
Returns `{event}` (HTTP 201).

#### `POST /api/v1/events/<id>`
Partial update / merge of an event. Body: same fields as create, all optional.
Returns `{event}`.

#### `POST /api/v1/events/<id>/shipment`
Record a shipment leg.
Body: `{direction: 'outbound'|'return', carrier?, pickupDate?, tracking?, notes?}`.
Returns `{shipment}`.

#### `POST /api/v1/events/<id>/travel`
Record a travel itinerary leg (e.g. a flight).
Body:
```
{staffEmail?  (defaults to the token owner), staffName?,
 mode?: 'flight'|'train'|'drive',
 outbound?: {carrier, number, confirmation, departLocation, departAt,
             arriveLocation, arriveAt, notes},
 return?:   {...same}}
```
e.g. flight AA1234: `carrier='American'`, `number='AA1234'`.
Returns `{travel}`.

#### `POST /api/v1/events/<id>/lodging`
Record a hotel.
Body: `{staffEmail?, staffName?, name, address?, city?, state?, zip?, room?,
phone?, checkInAt?, checkOutAt?, confirmation?, notes?}`.
Returns `{hotel}`.

### Generic record CRUD (full parity)

Works over any app collection: `events`, `cases`, `inventory`, `tags`,
`warehouses`, `users`, `emergency_contact`.

| Method + path | Body | Returns |
| ------------- | ---- | ------- |
| `GET /api/v1/db/<collection>` (`?q=&limit=&offset=`) | — | `{records, total, limit, offset}` |
| `GET /api/v1/db/<collection>/<id>` | — | `{record}` |
| `POST /api/v1/db/<collection>` | `{record: {...}}` | `{record}` (201) |
| `POST /api/v1/db/<collection>/<id>` | `{record: {...}}` or flat fields | `{record}` (shallow merge of top-level keys) |
| `POST /api/v1/db/<collection>/<id>/delete` | — | `{deleted}` (soft-delete, sets `deletedAt`) |

Notes:
- For `users` / `emergency_contact`, a **create** must supply `record.id` or
  `record.email`.
- **`users` and `emergency_contact` hold PII**: both **reads and writes**
  require a **manager or admin** role. Any lower role (read-only / authorized /
  lead) gets `403` with *"holds personal data — a manager or admin role is
  required"*. All other collections keep the normal tiers (any role reads;
  authorized+ writes).
- `sync_meta` and `metadata` are **read-only** via `/db` — writes return `403`.
- The `auth` collection is **never** accessible.

## Example

```bash
curl -H "Authorization: Bearer eitk_abc.def" \
     "https://your-server.example.com/api/v1/low-stock"

# Create an event (write-scope token):
curl -X POST -H "Authorization: Bearer eitk_abc.def" \
     -H "Content-Type: application/json" \
     -d '{"name":"Fall Expo","startDate":"2026-09-01","state":"upcoming"}' \
     "https://your-server.example.com/api/v1/events"
```
