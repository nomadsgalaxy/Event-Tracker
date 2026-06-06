#!/usr/bin/env python3
"""Offline self-test for the Event Tracker MCP server.

This does NOT touch the network or require a real server. It monkeypatches the
HTTP layer (``server._request``) with a fake that records the call, and asserts
each MCP tool:
  * hits the right HTTP method + URL path,
  * passes query params / JSON body correctly,
  * (separately) that the real ``_request`` sets the Bearer Authorization header.

Run:  python selftest.py
Exits non-zero on the first failure.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import urllib.request

# Provide config before importing the server (it reads env at import time).
os.environ.setdefault("EIT_BASE_URL", "https://et.example.test")
os.environ.setdefault("EIT_API_TOKEN", "eitk_testid.testsecret")
os.environ.setdefault("EIT_TIMEOUT", "20")

server = importlib.import_module("server")


# ---------------------------------------------------------------------------
# Part 1: each tool calls the right method + path (+ params / body)
# ---------------------------------------------------------------------------

CALLS: list[dict] = []


def fake_request(method, path, *, params=None, json_body=None):
    CALLS.append(
        {"method": method, "path": path, "params": params, "json_body": json_body}
    )
    return {"ok": True, "_echo_path": path}


def last():
    assert CALLS, "expected a recorded call, got none"
    return CALLS[-1]


def expect(cond, msg):
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def run_tool_tests():
    server._request = fake_request  # type: ignore[attr-defined]

    # whoami
    server.whoami()
    c = last()
    expect(c["method"] == "GET" and c["path"] == "/api/v1/whoami", f"whoami -> {c}")

    # system_status
    server.system_status()
    c = last()
    expect(c["method"] == "GET" and c["path"] == "/api/v1/status", f"system_status -> {c}")

    # list_inventory (default)
    server.list_inventory()
    c = last()
    expect(c["path"] == "/api/v1/inventory", f"list_inventory path -> {c}")
    expect(c["params"].get("limit") == 100, f"list_inventory default limit -> {c}")
    expect("low_stock" not in c["params"], f"list_inventory should omit low_stock when False -> {c}")

    # list_inventory (filters)
    server.list_inventory(query="cable", low_stock=True, limit=5)
    c = last()
    expect(c["params"]["q"] == "cable", f"list_inventory q -> {c}")
    expect(c["params"]["low_stock"] == 1, f"list_inventory low_stock=1 -> {c}")
    expect(c["params"]["limit"] == 5, f"list_inventory limit -> {c}")

    # get_item (with id that needs URL-encoding)
    server.get_item("ab/cd 12")
    c = last()
    expect(c["method"] == "GET", f"get_item method -> {c}")
    expect(c["path"] == "/api/v1/inventory/ab%2Fcd%2012", f"get_item url-encodes id -> {c}")

    # list_cases
    server.list_cases(query="road", limit=10)
    c = last()
    expect(c["path"] == "/api/v1/cases", f"list_cases path -> {c}")
    expect(c["params"] == {"q": "road", "limit": 10}, f"list_cases params -> {c}")

    # get_case
    server.get_case("case-1")
    c = last()
    expect(c["path"] == "/api/v1/cases/case-1", f"get_case path -> {c}")

    # list_events
    server.list_events(query="summit", limit=7)
    c = last()
    expect(c["path"] == "/api/v1/events", f"list_events path -> {c}")
    expect(c["params"] == {"q": "summit", "limit": 7}, f"list_events params -> {c}")

    # get_event
    server.get_event("evt-9")
    c = last()
    expect(c["path"] == "/api/v1/events/evt-9", f"get_event path -> {c}")

    # search
    server.search("widget")
    c = last()
    expect(c["path"] == "/api/v1/search", f"search path -> {c}")
    expect(c["params"] == {"q": "widget"}, f"search params -> {c}")

    # low_stock_report
    server.low_stock_report()
    c = last()
    expect(c["path"] == "/api/v1/low-stock", f"low_stock_report path -> {c}")

    # double_booking_conflicts
    server.double_booking_conflicts()
    c = last()
    expect(c["path"] == "/api/v1/conflicts", f"conflicts path -> {c}")

    # flag_item (valid)
    server.flag_item("item-7", "broken latch", severity="HIGH")
    c = last()
    expect(c["method"] == "POST", f"flag_item method -> {c}")
    expect(c["path"] == "/api/v1/inventory/item-7/flag", f"flag_item path -> {c}")
    expect(
        c["json_body"] == {"note": "broken latch", "severity": "high"},
        f"flag_item normalises severity + body -> {c}",
    )

    # flag_item (invalid severity short-circuits BEFORE any HTTP call)
    before = len(CALLS)
    res = server.flag_item("item-7", "note", severity="extreme")
    expect("error" in res, f"flag_item bad severity should return error -> {res}")
    expect(len(CALLS) == before, "flag_item bad severity must not perform a request")

    # ----- typed event WRITE tools -----

    # create_event (only supplied fields sent; venue nested; state normalised)
    server.create_event("Trade Show", start_date="2026-09-01", city="Austin",
                        booth="B12", state="UPCOMING")
    c = last()
    expect(c["method"] == "POST" and c["path"] == "/api/v1/events", f"create_event -> {c}")
    expect(
        c["json_body"] == {
            "name": "Trade Show", "startDate": "2026-09-01", "state": "upcoming",
            "venue": {"city": "Austin", "booth": "B12"},
        },
        f"create_event body (compact + nested venue + lc state) -> {c['json_body']}",
    )

    # create_event with no name short-circuits
    before = len(CALLS)
    res = server.create_event("")
    expect("error" in res and len(CALLS) == before, f"create_event empty name -> {res}")

    # create_event bad state short-circuits
    before = len(CALLS)
    res = server.create_event("X", state="bogus")
    expect("error" in res and len(CALLS) == before, f"create_event bad state -> {res}")

    # update_event (partial merge, only supplied fields)
    server.update_event("evt-1", state="packing", lead="Sam")
    c = last()
    expect(c["path"] == "/api/v1/events/evt-1", f"update_event path -> {c}")
    expect(c["json_body"] == {"state": "packing", "lead": "Sam"},
           f"update_event body -> {c['json_body']}")

    # update_event with nothing to change short-circuits
    before = len(CALLS)
    res = server.update_event("evt-1")
    expect("error" in res and len(CALLS) == before, f"update_event no fields -> {res}")

    # assign_cases
    server.assign_cases("evt-1", ["c1", "c2"])
    c = last()
    expect(c["path"] == "/api/v1/events/evt-1", f"assign_cases path -> {c}")
    expect(c["json_body"] == {"cases": ["c1", "c2"]}, f"assign_cases body -> {c}")

    # set_shipment
    server.set_shipment("evt-1", "OUTBOUND", carrier="FedEx", tracking="Z9")
    c = last()
    expect(c["path"] == "/api/v1/events/evt-1/shipment", f"set_shipment path -> {c}")
    expect(
        c["json_body"] == {"direction": "outbound", "carrier": "FedEx", "tracking": "Z9"},
        f"set_shipment body -> {c['json_body']}",
    )

    # set_shipment bad direction short-circuits
    before = len(CALLS)
    res = server.set_shipment("evt-1", "sideways")
    expect("error" in res and len(CALLS) == before, f"set_shipment bad dir -> {res}")

    # set_flight (mode=flight, leg keyed by direction, staffEmail passthrough)
    server.set_flight("evt-1", "AA1234", carrier="American", depart="DFW",
                     arrive="AUS", direction="outbound", staff_email="me@x.test")
    c = last()
    expect(c["path"] == "/api/v1/events/evt-1/travel", f"set_flight path -> {c}")
    expect(
        c["json_body"] == {
            "mode": "flight",
            "outbound": {"carrier": "American", "number": "AA1234",
                         "departLocation": "DFW", "arriveLocation": "AUS"},
            "staffEmail": "me@x.test",
        },
        f"set_flight body -> {c['json_body']}",
    )

    # set_flight without staff_email omits staffEmail; return leg keyed correctly
    server.set_flight("evt-1", "AA9", direction="return")
    c = last()
    expect("staffEmail" not in c["json_body"], f"set_flight omits empty staffEmail -> {c}")
    expect("return" in c["json_body"] and "outbound" not in c["json_body"],
           f"set_flight return leg -> {c['json_body']}")

    # set_lodging
    server.set_lodging("evt-1", "Hyatt", confirmation="ABC", check_in="2026-09-01")
    c = last()
    expect(c["path"] == "/api/v1/events/evt-1/lodging", f"set_lodging path -> {c}")
    expect(
        c["json_body"] == {"name": "Hyatt", "confirmation": "ABC", "checkInAt": "2026-09-01"},
        f"set_lodging body -> {c['json_body']}",
    )

    # set_lodging without hotel name short-circuits
    before = len(CALLS)
    res = server.set_lodging("evt-1", "")
    expect("error" in res and len(CALLS) == before, f"set_lodging no name -> {res}")

    # ----- generic record CRUD -----

    server.list_records("warehouses", query="east", limit=10)
    c = last()
    expect(c["method"] == "GET" and c["path"] == "/api/v1/db/warehouses",
           f"list_records path -> {c}")
    expect(c["params"] == {"q": "east", "limit": 10}, f"list_records params -> {c}")

    server.get_record("tags", "t-1")
    c = last()
    expect(c["method"] == "GET" and c["path"] == "/api/v1/db/tags/t-1",
           f"get_record -> {c}")

    server.create_record("users", {"email": "x@y.test", "role": "viewer"})
    c = last()
    expect(c["method"] == "POST" and c["path"] == "/api/v1/db/users", f"create_record -> {c}")
    expect(c["json_body"] == {"record": {"email": "x@y.test", "role": "viewer"}},
           f"create_record body wraps in record -> {c['json_body']}")

    server.update_record("inventory", "i-1", {"reorderPoint": 5})
    c = last()
    expect(c["path"] == "/api/v1/db/inventory/i-1", f"update_record path -> {c}")
    expect(c["json_body"] == {"record": {"reorderPoint": 5}}, f"update_record body -> {c}")

    # update_record empty fields short-circuits
    before = len(CALLS)
    res = server.update_record("inventory", "i-1", {})
    expect("error" in res and len(CALLS) == before, f"update_record empty -> {res}")

    server.delete_record("cases", "c-9")
    c = last()
    expect(c["method"] == "POST" and c["path"] == "/api/v1/db/cases/c-9/delete",
           f"delete_record -> {c}")

    print(f"PASS: tool routing ({len(CALLS)} HTTP calls recorded)")


# ---------------------------------------------------------------------------
# Part 2: the real _request sets the Bearer header (and method/url)
# ---------------------------------------------------------------------------


class _FakeResp:
    status = 200

    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run_header_test():
    # Restore the genuine _request (fresh import to undo the monkeypatch).
    importlib.reload(server)

    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        # Header names are normalised to Capitalised form by urllib.
        captured["auth"] = req.get_header("Authorization")
        captured["accept"] = req.get_header("Accept")
        captured["body"] = req.data
        return _FakeResp({"ok": True})

    real_urlopen = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]
    try:
        # A GET with params.
        out = server.list_inventory(query="x y", low_stock=True, limit=3)
        expect(out == {"ok": True}, f"list_inventory should return parsed JSON -> {out}")
        expect(
            captured["auth"] == "Bearer eitk_testid.testsecret",
            f"Authorization header -> {captured.get('auth')!r}",
        )
        expect(captured["accept"] == "application/json", f"Accept header -> {captured}")
        expect(captured["method"] == "GET", f"GET method -> {captured}")
        expect(
            captured["url"].startswith("https://et.example.test/api/v1/inventory?"),
            f"URL base+path -> {captured['url']}",
        )
        expect("q=x+y" in captured["url"] or "q=x%20y" in captured["url"],
               f"query encoded -> {captured['url']}")
        expect("low_stock=1" in captured["url"], f"low_stock in query -> {captured['url']}")

        # A POST sends a JSON body + Bearer header.
        server.flag_item("it-1", "note", severity="low")
        expect(captured["method"] == "POST", f"POST method -> {captured}")
        expect(
            captured["auth"] == "Bearer eitk_testid.testsecret",
            f"POST Authorization header -> {captured.get('auth')!r}",
        )
        body = json.loads(captured["body"].decode("utf-8"))
        expect(
            body == {"note": "note", "severity": "low"},
            f"POST body -> {body}",
        )

        # A new typed WRITE tool also sends the Bearer header + JSON body.
        server.create_event("Demo Event", start_date="2026-09-01")
        expect(captured["method"] == "POST", f"create_event POST method -> {captured}")
        expect(
            captured["url"] == "https://et.example.test/api/v1/events",
            f"create_event URL -> {captured['url']}",
        )
        expect(
            captured["auth"] == "Bearer eitk_testid.testsecret",
            f"create_event Authorization header -> {captured.get('auth')!r}",
        )
        body = json.loads(captured["body"].decode("utf-8"))
        expect(
            body == {"name": "Demo Event", "startDate": "2026-09-01"},
            f"create_event POST body -> {body}",
        )

        # A generic CRUD WRITE wraps the payload in {"record": ...} + Bearer.
        server.create_record("tags", {"name": "vip"})
        expect(
            captured["url"] == "https://et.example.test/api/v1/db/tags",
            f"create_record URL -> {captured['url']}",
        )
        expect(
            captured["auth"] == "Bearer eitk_testid.testsecret",
            f"create_record Authorization header -> {captured.get('auth')!r}",
        )
        body = json.loads(captured["body"].decode("utf-8"))
        expect(body == {"record": {"name": "vip"}}, f"create_record POST body -> {body}")
    finally:
        urllib.request.urlopen = real_urlopen  # type: ignore[assignment]

    print("PASS: real _request sets Bearer header + correct method/url/body")


# ---------------------------------------------------------------------------
# Part 3: error handling (non-2xx -> {error,...}, not an exception)
# ---------------------------------------------------------------------------


def run_error_test():
    import urllib.error

    def fake_urlopen_403(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 403, "Forbidden", {}, _io(b'{"error":"read-only token"}')
        )

    real = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen_403  # type: ignore[assignment]
    try:
        out = server.flag_item("it-1", "note")
        expect(out.get("error") == "read-only token", f"403 error surfaced -> {out}")
        expect(out.get("status") == 403, f"403 status preserved -> {out}")
    finally:
        urllib.request.urlopen = real  # type: ignore[assignment]
    print("PASS: non-2xx response is returned as {error, status}")


def _io(b: bytes):
    import io

    return io.BytesIO(b)


if __name__ == "__main__":
    run_tool_tests()
    run_header_test()
    run_error_test()
    print("\nALL SELFTESTS PASSED")
