"""
ATHMA Visual QA Agent — PUBLISH bridge.

Takes a script the agent wrote (agent/output/*.json) and publishes it into
ATHMA's new `agent_test_cases` table via the backend, so it shows up in the UI
and can be run through the normal runner. The agent's steps are already in the
runner's exact format, so they go in as-is.

Auth: logs in with credentials you pass at runtime (never stored in the file).

Usage:
  python agent/publish.py --file agent/output/agent_script_XXXX.json \
      --project 1 --name "Register patient (agent)" --base-url https://sqa.narayanahealth.org/

You'll be prompted for username/password (or set ATHMA_USER / ATHMA_PASS env vars).
"""
import os
import sys
import json
import argparse
import getpass
import requests

API_BASE = os.environ.get("ATHMA_API_BASE", "http://localhost:6001")


def login(api_base: str, user: str, password: str) -> str:
    """
    Handle ATHMA's login flow:
      - superadmin (id=1): /api/auth/login returns {token} directly.
      - normal user: /api/auth/login returns {needs_org, user_id, orgs[]},
        then /api/auth/select-org returns the real {token}.
    """
    r = requests.post(f"{api_base}/api/auth/login",
                      json={"username": user, "password": password}, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"Login failed {r.status_code}: {r.text[:200]}")
    data = r.json()

    # One-step (superadmin)
    if data.get("token"):
        return data["token"]

    # Two-step: pick an organisation
    if data.get("needs_org"):
        orgs = data.get("orgs", [])
        user_id = data.get("user_id")
        if not orgs:
            raise SystemExit("Login OK but no organisations assigned to this user.")
        if len(orgs) == 1:
            org = orgs[0]
        else:
            print("Select an organisation:")
            for i, o in enumerate(orgs):
                print(f"  [{i}] {o.get('name')} (id {o.get('id')})")
            idx = int(input("Number: ").strip() or "0")
            org = orgs[idx]
        r2 = requests.post(f"{api_base}/api/auth/select-org",
                           json={"user_id": user_id, "org_id": org["id"]}, timeout=30)
        if r2.status_code != 200:
            raise SystemExit(f"select-org failed {r2.status_code}: {r2.text[:200]}")
        tok = r2.json().get("token")
        if not tok:
            raise SystemExit("select-org OK but no token returned.")
        return tok

    raise SystemExit(f"Unexpected login response: {list(data.keys())}")


def publish(api_base: str, token: str, payload: dict) -> dict:
    r = requests.post(f"{api_base}/api/agent-tests",
                      headers={"Authorization": f"Bearer {token}",
                               "Content-Type": "application/json"},
                      json=payload, timeout=30)
    if r.status_code not in (200, 201):
        raise SystemExit(f"Publish failed {r.status_code}: {r.text[:300]}")
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="agent/output/*.json script file")
    ap.add_argument("--project", type=int, required=True, help="project_id to file it under")
    ap.add_argument("--name", help="test case name (defaults to goal)")
    ap.add_argument("--base-url", default="")
    ap.add_argument("--api-base", default=API_BASE)
    args = ap.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        doc = json.load(f)
    meta = doc.get("meta", {})
    steps = doc.get("steps", [])
    # drop agent-only annotation keys the runner doesn't need
    clean_steps = [{k: v for k, v in s.items() if not k.startswith("_")} for s in steps]

    name = args.name or (meta.get("goal", "Agent test")[:120])
    base_url = args.base_url or meta.get("start_url", "")

    user = os.environ.get("ATHMA_USER") or input("ATHMA username: ")
    password = os.environ.get("ATHMA_PASS") or getpass.getpass("ATHMA password: ")

    token = login(args.api_base, user, password)
    payload = {
        "project_id": args.project,
        "name": name,
        "goal": meta.get("goal", ""),
        "base_url": base_url,
        "type": "ui",
        "browser": "chrome",
        "steps": clean_steps,
    }
    result = publish(args.api_base, token, payload)
    print(f"Published as agent_test_case id={result.get('id')} — '{name}' "
          f"({len(clean_steps)} steps). It will now appear in the ATHMA UI under Agent Tests.")


if __name__ == "__main__":
    main()
