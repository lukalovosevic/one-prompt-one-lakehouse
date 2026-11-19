"""Resize the Flight owner's read/write Duckling via the MotherDuck admin REST API.

Called from the HN lakehouse Dive (Mure Forward #2 demo). Config:
  SIZE   target read_write instance size: pulse | standard | jumbo | mega | giga
The read_scaling block is read first and sent back unchanged (the PUT needs both).
The Dive then polls md_live_duckling_size() until the running Duckling reports SIZE.

Deploy as a Flight named duckling-resize (F4 runner, 120 s timeout) with the
default "MotherDuck Flights" token (GET /v1/users/{user}/instances works with it).
"""
import json
import os
import sys

import duckdb
import requests

API = "https://api.motherduck.com/v1"
SIZES = ("pulse", "standard", "jumbo", "mega", "giga")


def main():
    size = os.environ.get("SIZE", "").strip().lower()
    if size not in SIZES:
        raise SystemExit(f"SIZE must be one of {SIZES}, got {size!r}")

    token = os.environ["MOTHERDUCK_TOKEN"]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Whose Duckling: the owner of the token this Flight runs with.
    user = duckdb.connect("md:").sql("SELECT current_user").fetchone()[0]
    print(f"@flight-run read running", flush=True)
    r = requests.get(f"{API}/users/{user}/instances", headers=headers, timeout=20)
    if r.status_code != 200:
        print(f"GET failed {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise SystemExit(1)
    cfg = r.json()
    before = cfg["read_write"]["instance_size"]
    print(f"user={user} read_write {before} -> {size}; read_scaling kept {json.dumps(cfg['read_scaling'])}")
    print(f"@flight-run read ok", flush=True)

    if before == size:
        print("already at target size; nothing to do")
        return

    print(f"@flight-run resize running", flush=True)
    # Send both blocks back as they were (cooldown_seconds included), changing only the size.
    read_write = {k: v for k, v in cfg["read_write"].items() if v is not None}
    read_write["instance_size"] = size
    read_scaling = {k: v for k, v in cfg["read_scaling"].items() if v is not None}
    body = {"config": {"read_write": read_write, "read_scaling": read_scaling}}
    r = requests.put(f"{API}/users/{user}/instances", headers=headers, json=body, timeout=20)
    if r.status_code not in (200, 201, 204):
        print(f"PUT failed {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise SystemExit(1)
    print(f"PUT {r.status_code}: {r.text[:300]}")
    print(f"@flight-run resize ok", flush=True)


if __name__ == "__main__":
    main()
