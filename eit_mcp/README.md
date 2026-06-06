# Event Tracker MCP server (`eit_mcp`)

A standalone **MCP (Model Context Protocol) server** that lets you query your
self-hosted [Event Tracker](https://github.com/EventTracker) instance from an
MCP client such as **Claude Desktop** or **Claude Code**.

It is a *thin client* over the existing Event Tracker REST API — it does not
reimplement any business logic. Each tool maps to one REST endpoint, and the
API token you provide carries a **scoped subset of your own permissions**, so a
key can never do more than its owner — and only the capabilities you picked when
you created it.

## What it does

Exposes these MCP tools (the model reads their descriptions automatically).
Each call is gated by the key's **effective capabilities** = the capabilities
you selected for the key **intersected with your live role**. Pick a read-only
key and every write tool returns 403; demote the owner and every key they hold
narrows automatically.

### Read tools

| Tool | REST endpoint | What it does |
| ---- | ------------- | ------------ |
| `whoami()` | `GET /whoami` | Who is this token (email, role, scope, key label) |
| `system_status()` | `GET /status` | Counts of events / cases / inventory |
| `list_inventory(query="", low_stock=False, limit=100)` | `GET /inventory` | List/search items, optional low-stock filter |
| `get_item(item_id)` | `GET /inventory/<id>` | One item with resolved stock |
| `list_cases(query="", limit=100)` | `GET /cases` | List/search cases |
| `get_case(case_id)` | `GET /cases/<id>` | One case + packed manifest |
| `list_events(query="", limit=100)` | `GET /events` | List/search events |
| `get_event(event_id)` | `GET /events/<id>` | One event + full manifest |
| `search(query)` | `GET /search` | Cross-entity search |
| `low_stock_report()` | `GET /low-stock` | Items at/below reorder point |
| `double_booking_conflicts()` | `GET /conflicts` | Cases booked to overlapping events |
| `list_records(collection, query="", limit=100)` | `GET /db/<collection>` | List/search any collection |
| `get_record(collection, record_id)` | `GET /db/<collection>/<id>` | One record from any collection |

### Write tools

All writes need a **write-scope token** whose owner role is above **read-only**
(otherwise HTTP 403). Run `whoami()` to check your scope. The ergonomic typed
tools are the headline UX ("add an event", "my flight is AA1234", "hotel for X").

| Tool | REST endpoint | What it does |
| ---- | ------------- | ------------ |
| `create_event(name, start_date="", end_date="", city="", booth="", website="", state="")` | `POST /events` | Create an event |
| `update_event(event_id, name="", state="", start_date="", end_date="", lead="", website="")` | `POST /events/<id>` | Merge fields onto an event |
| `assign_cases(event_id, case_ids)` | `POST /events/<id>` | Set the event's case list |
| `set_shipment(event_id, direction, carrier="", pickup_date="", tracking="", notes="")` | `POST /events/<id>/shipment` | Record an outbound/return shipment |
| `set_flight(event_id, number, carrier="", depart="", arrive="", direction="outbound", staff_email="")` | `POST /events/<id>/travel` | Record a flight (mode=flight) |
| `set_lodging(event_id, hotel_name, confirmation="", check_in="", check_out="", address="", room="", phone="", staff_email="")` | `POST /events/<id>/lodging` | Record a hotel |
| `flag_item(item_id, note, severity="med")` | `POST /inventory/<id>/flag` | Flag an inventory item |
| `create_record(collection, record)` | `POST /db/<collection>` | Create a record in any collection |
| `update_record(collection, record_id, fields)` | `POST /db/<collection>/<id>` | Shallow-merge update |
| `delete_record(collection, record_id)` | `POST /db/<collection>/<id>/delete` | Soft-delete (sets `deletedAt`) |

> **Resolving "event X by name":** the typed write tools take an `event_id`. To
> act on an event the user named, first call `list_events()` / `search()` to
> find the id, then **confirm with the user** before writing.

> **Generic CRUD collections:** `events`, `cases`, `inventory`, `tags`,
> `warehouses`, `users`, `emergency_contact`. `users` writes are role
> assignment only (`{ "role": "lead" }`, admin-gated); `emergency_contact` is a
> single fleet-wide record. `sync_meta` / `metadata` are read-only; `auth` and
> the audit log are never accessible.

The full REST API is documented in [`EIT_API.md`](./EIT_API.md).

## Install

Requires Python 3.10+.

```bash
pip install -r requirements.txt
```

The only dependency is the official MCP Python SDK (`mcp>=1.2.0`). The HTTP
layer uses the Python standard library (`urllib`), so there is no extra HTTP
dependency.

## Mint an API token

In Event Tracker: **Account → Security → API keys**. Give the key a label, tick
the **capabilities** you want it to carry (the list is limited to what your own
role can do — leave everything unticked for a read-only key), then **copy the
token shown once** (you cannot see it again). It looks like `eitk_<id>.<secret>`.

- An empty selection is a **read-only** key — every read tool works, writes 403.
- Tick `pallets.edit` / `scan.pack` for warehouse flows, `event.create` /
  `event.edit` for events, `staff.pii.view` for travel/lodging, and so on.
- A key can never exceed your role: a cap you don't hold can't be put on a key,
  and if you're later demoted the key narrows to match.

## Configuration (environment variables)

| Variable | Required | Default | Example |
| -------- | -------- | ------- | ------- |
| `EIT_BASE_URL` | yes | — | `https://your-server.example.com` |
| `EIT_API_TOKEN` | yes | — | `eitk_abc123.s3cr3t` |
| `EIT_TIMEOUT` | no | `20` | `30` (request timeout, seconds) |

If a required variable is missing the server exits immediately with a clear
message.

## Run it directly (sanity check)

```bash
EIT_BASE_URL=https://your-server.example.com \
EIT_API_TOKEN=eitk_abc123.s3cr3t \
python server.py
```

It starts an MCP server on **stdio** and waits for a client. (On Windows
PowerShell, set the env vars with `$env:EIT_BASE_URL = "..."` first.)

## Connect from Claude Desktop

Add this to your `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`;
Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude
Desktop. Use the **absolute path** to `server.py`.

```json
{
  "mcpServers": {
    "event-tracker": {
      "command": "python",
      "args": [
        "/path/to/Event-Tracker/eit_mcp/server.py"
      ],
      "env": {
        "EIT_BASE_URL": "https://your-server.example.com",
        "EIT_API_TOKEN": "eitk_abc123.s3cr3t"
      }
    }
  }
}
```

## Connect from Claude Code (CLI)

```bash
claude mcp add event-tracker \
  --env EIT_BASE_URL=https://your-server.example.com \
  --env EIT_API_TOKEN=eitk_abc123.s3cr3t \
  -- python "/path/to/Event-Tracker/eit_mcp/server.py"
```

Everything after `--` is the command Claude Code runs to launch the server.

## Permissions model

A request succeeds only when the key was **scoped to** the capability AND the
owner's **live role** currently grants it (effective = scoped ∩ role). So:

- **Reads**: a key with the data-read capability can read `events`, `cases`,
  `inventory`, `tags`, `warehouses` (the friendly read tools). Events are
  PII-stripped to the key's scope.
- **Writes**: need the matching capability on the key (e.g. `event.edit`,
  `pallets.edit`, `scan.pack`, `db.write.app`) — and the owner's role must grant
  it. Missing either gives HTTP 403.
- **PII collections (`users`, `emergency_contact`)**: a **manager or admin**
  role is required; `emergency_contact` also needs the `emergency_contact.read`
  / `.write` capability. The generic `users` mirror returns directory fields
  only (never accommodations), and the only permitted `users` write is a role
  assignment.

`EIT_BASE_URL` stays the main domain; the API lives at `/api/v1`.

## Running behind Cloudflare Access (SSO)

If your Event Tracker instance is protected by **Cloudflare Access** (SSO),
browser visitors get a Cloudflare login page first. The MCP server is **not** a
browser — it authenticates with its own Bearer token — so if Cloudflare
intercepts the API path, the server receives the Cloudflare **login HTML
instead of JSON** and every tool fails.

Fix: add a Cloudflare Access **Bypass** policy for the API paths so non-browser
API calls are not intercepted. The Bearer token is the real authentication.

1. Go to **Cloudflare Zero Trust → Access → Applications → Add an application →
   Self-hosted**.
2. Scope it to the API path, e.g. application domain
   `et.example.com` with path `/api` (so it covers `et.example.com/api/*`).
   Repeat / include `/healthz` and `/readyz` if your instance uses them.
3. Add a policy with **Action: Bypass** and an **Include: Everyone**. Bypass
   means Cloudflare does not enforce SSO on these paths — the Event Tracker
   Bearer token does the authentication.
4. Save. Leave your existing Access app on the root domain (the human-facing
   UI) enforcing SSO as before.

Keep `EIT_BASE_URL` set to the main domain (e.g. `https://et.example.com`); the
API lives under `/api/v1`, which the Bypass policy now exempts.

Alternatives to a Bypass policy: a dedicated **public hostname** for the API,
or a Cloudflare Access **Service Token** sent alongside the Bearer token.

## Self-test (no network needed)

```bash
python selftest.py
```

This monkeypatches the HTTP layer with a fake response and asserts each tool
calls the right URL/method and that the real request layer sends the
`Authorization: Bearer ...` header. It does not contact any server.

## Notes & caveats

- **A write tool a key isn't scoped for returns HTTP 403** — as does any
  capability the owner's role doesn't grant. A read-only key (no caps selected)
  can use every read tool and no write tool.
- **`users` / `emergency_contact` need a manager or admin role** (PII); lower
  roles get 403. See the permissions model above.
- Errors from the API (`401/403/404/429/500`) are returned to the model as
  `{"error": "...", "status": <code>}` rather than raised as exceptions.
- Deletes via `delete_record` are **soft** (set `deletedAt`), not physical.
- To act on an event "by name", resolve its id with `list_events`/`search`
  first, then confirm with the user before writing.
- Rate limit is 600 requests/min per key by default (set `EIT_API_RATE_LIMIT` on
  the server to change it); exceeding it returns `429`.
- The token carries a scoped slice of your permissions — treat it like a password.
