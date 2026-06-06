#!/usr/bin/env python3
"""Event Tracker MCP server.

A thin MCP (Model Context Protocol) wrapper over the Event Tracker REST API.
It exposes read tools (and one write tool, ``flag_item``) that an MCP client
such as Claude Desktop or Claude Code can call to query a self-hosted Event
Tracker instance.

This server does NOT reimplement any business logic. Every tool maps to a
single REST endpoint; the token bound to the request carries the user's
role/permissions, so a read-only token can only read.

Configuration (environment variables):
    EIT_BASE_URL   (required)  e.g. https://your-server.example.com
    EIT_API_TOKEN  (required)  e.g. eitk_<id>.<secret>
    EIT_TIMEOUT    (optional)  request timeout in seconds, default 20

Transport: stdio.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Configuration (read once at startup, fail fast if missing)
# ---------------------------------------------------------------------------

USER_AGENT = "eit-mcp/1.0 (+https://github.com/EventTracker)"


def _load_config() -> tuple[str, str, float]:
    """Read and validate config from the environment.

    Returns (base_url, token, timeout). Exits the process with a clear
    message on any error so the MCP client surfaces it immediately.
    """
    base_url = os.environ.get("EIT_BASE_URL", "").strip()
    token = os.environ.get("EIT_API_TOKEN", "").strip()
    timeout_raw = os.environ.get("EIT_TIMEOUT", "20").strip()

    missing = []
    if not base_url:
        missing.append("EIT_BASE_URL")
    if not token:
        missing.append("EIT_API_TOKEN")
    if missing:
        sys.stderr.write(
            "eit-mcp: missing required environment variable(s): "
            + ", ".join(missing)
            + "\n  Set EIT_BASE_URL (e.g. https://your-server.example.com) and "
            "EIT_API_TOKEN (e.g. eitk_<id>.<secret>).\n"
        )
        sys.exit(2)

    # Normalise: strip a single trailing slash so we can join paths cleanly.
    base_url = base_url.rstrip("/")

    try:
        timeout = float(timeout_raw)
        if timeout <= 0:
            raise ValueError
    except ValueError:
        sys.stderr.write(
            f"eit-mcp: EIT_TIMEOUT must be a positive number (got {timeout_raw!r}); "
            "falling back to 20.\n"
        )
        timeout = 20.0

    return base_url, token, timeout


BASE_URL, API_TOKEN, TIMEOUT = _load_config()

mcp = FastMCP("event-tracker")


# ---------------------------------------------------------------------------
# HTTP layer (stdlib urllib; no extra HTTP dependency)
# ---------------------------------------------------------------------------


def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Perform an authenticated request against the Event Tracker API.

    Always sends ``Authorization: Bearer <token>``. Returns the parsed JSON
    body on success. On any error (non-2xx, network failure, bad JSON) returns
    a dict shaped ``{"error": "...", "status": <int|None>}`` so the model gets
    a clean, readable result instead of a raw traceback.
    """
    url = BASE_URL + path
    if params:
        # Drop None/empty values so we don't send q=&limit= noise.
        clean = {k: v for k, v in params.items() if v is not None and v != ""}
        if clean:
            url = url + "?" + urllib.parse.urlencode(clean)

    data = None
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
            return _parse_json(raw, resp.status)
    except urllib.error.HTTPError as exc:
        # Non-2xx: the API returns {"error": "..."} — surface it verbatim.
        body = exc.read() if hasattr(exc, "read") else b""
        parsed = _parse_json(body, exc.code, default_error=exc.reason or "HTTP error")
        if "error" not in parsed:
            parsed["error"] = f"HTTP {exc.code}: {exc.reason}"
        parsed.setdefault("status", exc.code)
        return parsed
    except urllib.error.URLError as exc:
        return {"error": f"Network error contacting {BASE_URL}: {exc.reason}", "status": None}
    except TimeoutError:
        return {"error": f"Request to {url} timed out after {TIMEOUT}s", "status": None}
    except Exception as exc:  # noqa: BLE001 — never leak a raw traceback to the model
        return {"error": f"Unexpected error: {exc}", "status": None}


def _seg(value: Any) -> str:
    """URL-encode a value for use as a single path segment.

    Uses ``safe=""`` so characters like ``/`` are escaped and cannot break out
    of the intended path segment.
    """
    return urllib.parse.quote(str(value), safe="")


def _compact(d: dict[str, Any]) -> dict[str, Any]:
    """Drop keys whose value is None or an empty string.

    Used to build partial-update / create bodies so we only send fields the
    caller actually supplied (empty string = "not provided" for our string
    params). Note: ``0``, ``False`` and empty lists/dicts are intentionally
    KEPT — only ``None`` and ``""`` are dropped.
    """
    return {k: v for k, v in d.items() if v is not None and v != ""}


# Valid event states accepted by the API (used for client-side validation).
_EVENT_STATES = (
    "draft", "upcoming", "packing", "ready", "onsite", "returning",
    "unpacking", "closed", "complete", "cancelled", "flagged",
)


def _parse_json(raw: bytes, status: int, *, default_error: str | None = None) -> dict[str, Any]:
    """Decode a JSON body, tolerating empty/non-JSON responses."""
    text = (raw or b"").decode("utf-8", errors="replace").strip()
    if not text:
        if default_error is not None:
            return {"error": default_error, "status": status}
        return {}
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return {"error": f"Non-JSON response (status {status}): {text[:500]}", "status": status}
    if isinstance(obj, dict):
        return obj
    # API always returns objects, but be defensive.
    return {"data": obj}


# ---------------------------------------------------------------------------
# MCP tools — one per REST endpoint
# ---------------------------------------------------------------------------


@mcp.tool()
def whoami() -> dict[str, Any]:
    """Identify the API token in use.

    Returns the email, role, scope (read/write), and key label/id associated
    with the configured EIT_API_TOKEN. Use this first to confirm which user
    and permission level you are acting as. Maps to GET /api/v1/whoami.
    """
    return _request("GET", "/api/v1/whoami")


@mcp.tool()
def system_status() -> dict[str, Any]:
    """Get high-level counts for the Event Tracker instance.

    Returns counts of events, cases, and inventory items plus a generation
    timestamp. Maps to GET /api/v1/status.
    """
    return _request("GET", "/api/v1/status")


@mcp.tool()
def list_inventory(query: str = "", low_stock: bool = False, limit: int = 100) -> dict[str, Any]:
    """List inventory items, optionally filtered.

    Args:
        query: Free-text search over item name / SKU (the API ``q`` param). Empty = all.
        low_stock: If True, return only items at or below their reorder point.
        limit: Maximum number of items to return (default 100).

    Returns {items, total, limit, offset}. Maps to GET /api/v1/inventory.
    """
    params: dict[str, Any] = {"q": query, "limit": limit}
    if low_stock:
        params["low_stock"] = 1
    return _request("GET", "/api/v1/inventory", params=params)


@mcp.tool()
def get_item(item_id: str) -> dict[str, Any]:
    """Get a single inventory item by id.

    Returns {item: {..., inStorage, stockTotal_resolved}} with resolved stock
    figures. Maps to GET /api/v1/inventory/<id>.
    """
    return _request("GET", f"/api/v1/inventory/{_seg(item_id)}")


@mcp.tool()
def list_cases(query: str = "", limit: int = 100) -> dict[str, Any]:
    """List cases (containers), optionally filtered by free-text search.

    Args:
        query: Free-text search over case name/label (the API ``q`` param). Empty = all.
        limit: Maximum number of cases to return (default 100).

    Returns {cases, total, limit, offset}. Maps to GET /api/v1/cases.
    """
    return _request("GET", "/api/v1/cases", params={"q": query, "limit": limit})


@mcp.tool()
def get_case(case_id: str) -> dict[str, Any]:
    """Get a single case plus its packed manifest.

    Returns {case: {...}, items: [{itemId, name, sku, qr, qty, serials, state}]}
    listing everything packed in the case. Maps to GET /api/v1/cases/<id>.
    """
    return _request("GET", f"/api/v1/cases/{_seg(case_id)}")


@mcp.tool()
def list_events(query: str = "", limit: int = 100) -> dict[str, Any]:
    """List events, optionally filtered by free-text search.

    Args:
        query: Free-text search over event name (the API ``q`` param). Empty = all.
        limit: Maximum number of events to return (default 100).

    Returns {events, total, limit, offset}. Maps to GET /api/v1/events.
    """
    return _request("GET", "/api/v1/events", params={"q": query, "limit": limit})


@mcp.tool()
def get_event(event_id: str) -> dict[str, Any]:
    """Get a single event plus its full manifest.

    Returns {event: {...}, manifest: [{caseId, items: [...]}]} — the cases
    assigned to the event and what each contains. Maps to GET /api/v1/events/<id>.
    """
    return _request("GET", f"/api/v1/events/{_seg(event_id)}")


@mcp.tool()
def search(query: str) -> dict[str, Any]:
    """Cross-entity free-text search.

    Searches inventory, cases, and events at once for the given query and
    returns {query, inventory: [...], cases: [...], events: [...]}.
    Maps to GET /api/v1/search.
    """
    return _request("GET", "/api/v1/search", params={"q": query})


@mcp.tool()
def low_stock_report() -> dict[str, Any]:
    """Report inventory items at or below their reorder point.

    Returns {lowStock: [{itemId, name, sku, inStorage, reorderPoint, short}], count}
    where ``short`` is how many units below the reorder point the item is.
    Maps to GET /api/v1/low-stock.
    """
    return _request("GET", "/api/v1/low-stock")


@mcp.tool()
def double_booking_conflicts() -> dict[str, Any]:
    """Find cases double-booked across overlapping events.

    Returns {conflicts: [{caseId, events: [{id, name, start, end, state}, ...]}], count}
    — each entry is a case assigned to two or more time-overlapping events.
    Maps to GET /api/v1/conflicts.
    """
    return _request("GET", "/api/v1/conflicts")


@mcp.tool()
def flag_item(item_id: str, note: str, severity: str = "med") -> dict[str, Any]:
    """Flag an inventory item with a note (WRITE operation).

    Requires a write-scope token bound to a non-read-only user. With a
    read-only token this returns an error (HTTP 403). Use whoami() to check
    your scope first.

    Args:
        item_id: The inventory item id to flag.
        note: Free-text note describing the issue.
        severity: One of 'low', 'med', or 'high' (default 'med').

    Returns {ok, itemId, flag}. Maps to POST /api/v1/inventory/<id>/flag.
    """
    sev = (severity or "med").strip().lower()
    if sev not in ("low", "med", "high"):
        return {
            "error": f"Invalid severity {severity!r}; must be one of 'low', 'med', 'high'.",
            "status": None,
        }
    return _request(
        "POST",
        f"/api/v1/inventory/{_seg(item_id)}/flag",
        json_body={"note": note, "severity": sev},
    )


# ---------------------------------------------------------------------------
# WRITE tools — typed / ergonomic event operations
#
# All of these need a WRITE-scope token whose owner role is above read-only;
# otherwise the API returns HTTP 403. To act on "event X by name", first call
# list_events()/search() to resolve the id, then confirm with the user before
# writing.
# ---------------------------------------------------------------------------


@mcp.tool()
def create_event(
    name: str,
    start_date: str = "",
    end_date: str = "",
    city: str = "",
    booth: str = "",
    website: str = "",
    state: str = "",
) -> dict[str, Any]:
    """Create a new event (WRITE).

    Needs a write-scope token and a role above read-only (else HTTP 403).

    Args:
        name: Event name (required).
        start_date / end_date: ISO dates (e.g. '2026-09-01').
        city: Venue city (stored under venue.city).
        booth: Booth number/label (stored under venue.booth).
        website: Event website URL.
        state: One of draft|upcoming|packing|ready|onsite|returning|unpacking|
            closed|complete|cancelled|flagged. Empty = server default.

    Returns {event} (HTTP 201). Maps to POST /api/v1/events.
    """
    if not (name or "").strip():
        return {"error": "name is required to create an event.", "status": None}
    st = (state or "").strip().lower()
    if st and st not in _EVENT_STATES:
        return {
            "error": f"Invalid state {state!r}; must be one of {', '.join(_EVENT_STATES)}.",
            "status": None,
        }
    body: dict[str, Any] = _compact(
        {
            "name": name,
            "startDate": start_date,
            "endDate": end_date,
            "website": website,
            "state": st,
        }
    )
    venue = _compact({"city": city, "booth": booth})
    if venue:
        body["venue"] = venue
    return _request("POST", "/api/v1/events", json_body=body)


@mcp.tool()
def update_event(
    event_id: str,
    name: str = "",
    state: str = "",
    start_date: str = "",
    end_date: str = "",
    lead: str = "",
    website: str = "",
) -> dict[str, Any]:
    """Update (merge) fields on an existing event (WRITE).

    Only the fields you pass are changed (partial merge). Needs a write-scope
    token and a role above read-only (else HTTP 403). To resolve an event by
    name, call list_events()/search() first, then confirm with the user.

    Args:
        event_id: The event id to update.
        name, website, lead: Free-text fields (empty = leave unchanged).
        state: One of the valid event states (empty = leave unchanged).
        start_date / end_date: ISO dates (empty = leave unchanged).

    Returns {event}. Maps to POST /api/v1/events/<id>.
    """
    st = (state or "").strip().lower()
    if st and st not in _EVENT_STATES:
        return {
            "error": f"Invalid state {state!r}; must be one of {', '.join(_EVENT_STATES)}.",
            "status": None,
        }
    body = _compact(
        {
            "name": name,
            "state": st,
            "startDate": start_date,
            "endDate": end_date,
            "lead": lead,
            "website": website,
        }
    )
    if not body:
        return {"error": "No fields to update; pass at least one field.", "status": None}
    return _request("POST", f"/api/v1/events/{_seg(event_id)}", json_body=body)


@mcp.tool()
def assign_cases(event_id: str, case_ids: list[str]) -> dict[str, Any]:
    """Assign a set of cases to an event (WRITE).

    Sets the event's case list to the given ids (this is an update_event with
    cases=[...]). Needs a write-scope token and a role above read-only.

    Args:
        event_id: The event id.
        case_ids: List of case ids to assign to the event.

    Returns {event}. Maps to POST /api/v1/events/<id> with body {cases:[...]}.
    """
    if not isinstance(case_ids, list):
        return {"error": "case_ids must be a list of case ids.", "status": None}
    return _request(
        "POST", f"/api/v1/events/{_seg(event_id)}", json_body={"cases": case_ids}
    )


@mcp.tool()
def set_shipment(
    event_id: str,
    direction: str,
    carrier: str = "",
    pickup_date: str = "",
    tracking: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Record a shipment leg for an event (WRITE).

    Needs a write-scope token and a role above read-only. To find the event id
    for "event X", call list_events()/search() first, then confirm.

    Args:
        event_id: The event id.
        direction: 'outbound' or 'return'.
        carrier: Shipping carrier (e.g. 'FedEx').
        pickup_date: ISO date of pickup.
        tracking: Tracking number.
        notes: Free-text notes.

    Returns {shipment}. Maps to POST /api/v1/events/<id>/shipment.
    """
    dirn = (direction or "").strip().lower()
    if dirn not in ("outbound", "return"):
        return {
            "error": f"direction must be 'outbound' or 'return' (got {direction!r}).",
            "status": None,
        }
    body = _compact(
        {
            "direction": dirn,
            "carrier": carrier,
            "pickupDate": pickup_date,
            "tracking": tracking,
            "notes": notes,
        }
    )
    return _request(
        "POST", f"/api/v1/events/{_seg(event_id)}/shipment", json_body=body
    )


@mcp.tool()
def set_flight(
    event_id: str,
    number: str,
    carrier: str = "",
    depart: str = "",
    arrive: str = "",
    direction: str = "outbound",
    staff_email: str = "",
) -> dict[str, Any]:
    """Record a flight for an event's travel itinerary (WRITE).

    This is the "my flight to X is AA1234" tool. It maps to the travel endpoint
    with mode='flight'; ``direction`` selects which leg (outbound or return) the
    flight is stored under. If staff_email is omitted, the API defaults to the
    token owner. Needs a write-scope token and a role above read-only.

    Args:
        event_id: The event id.
        number: Flight number, e.g. 'AA1234'.
        carrier: Airline, e.g. 'American'.
        depart: Departure datetime/airport (ISO datetime or location string).
        arrive: Arrival datetime/airport.
        direction: 'outbound' (default) or 'return' — which leg this flight is.
        staff_email: Whose itinerary; defaults to the token owner if empty.

    Returns {travel}. Maps to POST /api/v1/events/<id>/travel with mode='flight'.
    """
    leg = (direction or "outbound").strip().lower()
    if leg not in ("outbound", "return"):
        return {
            "error": f"direction must be 'outbound' or 'return' (got {direction!r}).",
            "status": None,
        }
    flight = _compact(
        {
            "carrier": carrier,
            "number": number,
            "departLocation": depart,
            "arriveLocation": arrive,
        }
    )
    body: dict[str, Any] = {"mode": "flight", leg: flight}
    if (staff_email or "").strip():
        body["staffEmail"] = staff_email
    return _request("POST", f"/api/v1/events/{_seg(event_id)}/travel", json_body=body)


@mcp.tool()
def set_lodging(
    event_id: str,
    hotel_name: str,
    confirmation: str = "",
    check_in: str = "",
    check_out: str = "",
    address: str = "",
    room: str = "",
    phone: str = "",
    staff_email: str = "",
) -> dict[str, Any]:
    """Record lodging (a hotel) for an event (WRITE).

    This is the "here's my hotel for X" tool. If staff_email is omitted the API
    defaults to the token owner. Needs a write-scope token and a role above
    read-only.

    Args:
        event_id: The event id.
        hotel_name: Hotel name (required).
        confirmation: Booking confirmation number.
        check_in / check_out: ISO datetimes.
        address: Hotel street address.
        room: Room number/type.
        phone: Hotel phone number.
        staff_email: Whose lodging; defaults to the token owner if empty.

    Returns {hotel}. Maps to POST /api/v1/events/<id>/lodging.
    """
    if not (hotel_name or "").strip():
        return {"error": "hotel_name is required.", "status": None}
    body = _compact(
        {
            "name": hotel_name,
            "confirmation": confirmation,
            "checkInAt": check_in,
            "checkOutAt": check_out,
            "address": address,
            "room": room,
            "phone": phone,
            "staffEmail": staff_email,
        }
    )
    return _request("POST", f"/api/v1/events/{_seg(event_id)}/lodging", json_body=body)


# ---------------------------------------------------------------------------
# Generic record CRUD — full parity over any app collection
#
# Collections include: events, cases, inventory, tags, warehouses, users,
# emergency_contact. Reads work with any token's role; writes need a
# write-scope token + role above read-only.
#
# PII EXCEPTION: 'users' and 'emergency_contact' hold personal data and require
# a MANAGER or ADMIN role for BOTH reads and writes — lower roles get 403
# ("holds personal data — a manager or admin role is required").
#
# sync_meta/metadata are read-only via /db (writes -> 403); 'auth' is never
# accessible.
# ---------------------------------------------------------------------------


@mcp.tool()
def list_records(collection: str, query: str = "", limit: int = 100) -> dict[str, Any]:
    """List/search records in any app collection (generic READ).

    Args:
        collection: e.g. 'events', 'cases', 'inventory', 'tags', 'warehouses',
            'users', 'emergency_contact'.
        query: Free-text search (the API ``q`` param). Empty = all.
        limit: Maximum number of records (default 100).

    Reads of most collections work for any role. The PII collections 'users'
    and 'emergency_contact' require a manager or admin role even to read
    (lower roles get HTTP 403).

    Returns {records, total, limit, offset}. Maps to GET /api/v1/db/<collection>.
    """
    return _request(
        "GET", f"/api/v1/db/{_seg(collection)}", params={"q": query, "limit": limit}
    )


@mcp.tool()
def get_record(collection: str, record_id: str) -> dict[str, Any]:
    """Get one record from any app collection by id (generic READ).

    Args:
        collection: The collection name (see list_records).
        record_id: The record id.

    Most collections are readable by any role. The PII collections 'users' and
    'emergency_contact' require a manager or admin role to read (else HTTP 403).

    Returns {record}. Maps to GET /api/v1/db/<collection>/<id>.
    """
    return _request("GET", f"/api/v1/db/{_seg(collection)}/{_seg(record_id)}")


@mcp.tool()
def create_record(collection: str, record: dict[str, Any]) -> dict[str, Any]:
    """Create a record in any app collection (generic WRITE).

    Needs a write-scope token and a role above read-only. For the 'users' and
    'emergency_contact' collections you MUST supply record['id'] or
    record['email'], AND those PII collections require a manager or admin role
    (lower roles get HTTP 403). sync_meta/metadata are read-only (writes return
    403); 'auth' is never accessible.

    Args:
        collection: The collection name.
        record: The full record object to create.

    Returns {record} (HTTP 201). Maps to POST /api/v1/db/<collection>.
    """
    if not isinstance(record, dict):
        return {"error": "record must be an object (dict).", "status": None}
    return _request(
        "POST", f"/api/v1/db/{_seg(collection)}", json_body={"record": record}
    )


@mcp.tool()
def update_record(
    collection: str, record_id: str, fields: dict[str, Any]
) -> dict[str, Any]:
    """Update a record via shallow-merge of top-level keys (generic WRITE).

    Only the top-level keys in ``fields`` are merged into the existing record.
    Needs a write-scope token and a role above read-only. The PII collections
    'users' and 'emergency_contact' additionally require a manager or admin
    role (lower roles get HTTP 403).

    Args:
        collection: The collection name.
        record_id: The record id to update.
        fields: Top-level keys to merge into the record.

    Returns {record}. Maps to POST /api/v1/db/<collection>/<id>.
    """
    if not isinstance(fields, dict) or not fields:
        return {"error": "fields must be a non-empty object (dict).", "status": None}
    return _request(
        "POST",
        f"/api/v1/db/{_seg(collection)}/{_seg(record_id)}",
        json_body={"record": fields},
    )


@mcp.tool()
def delete_record(collection: str, record_id: str) -> dict[str, Any]:
    """Soft-delete a record (sets deletedAt) (generic WRITE).

    Needs a write-scope token and a role above read-only. This is a soft delete:
    the record is marked deletedAt, not physically removed. The PII collections
    'users' and 'emergency_contact' additionally require a manager or admin role
    (lower roles get HTTP 403).

    Args:
        collection: The collection name.
        record_id: The record id to delete.

    Returns {deleted}. Maps to POST /api/v1/db/<collection>/<id>/delete.
    """
    return _request(
        "POST", f"/api/v1/db/{_seg(collection)}/{_seg(record_id)}/delete"
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Run the MCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
