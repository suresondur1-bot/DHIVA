"""
ATHMA Visual QA Agent — RUN bridge.

Triggers an already-published agent_test_case to run through the EXISTING
runner (no AI). Logs in the same way publish.py does, then calls
POST /api/agent-tests/<id>/run.

Usage:
  python agent/run.py --id 1
  python agent/run.py --id 1 --api-base http://10.8.7.176:6001
"""
import os
import argparse
import requests
from publish import login, API_BASE   # reuse the same login flow


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True, help="agent_test_case id to run")
    ap.add_argument("--api-base", default=API_BASE)
    args = ap.parse_args()

    user = os.environ.get("ATHMA_USER") or input("ATHMA username: ")
    import getpass
    password = os.environ.get("ATHMA_PASS") or getpass.getpass("ATHMA password: ")

    token = login(args.api_base, user, password)
    r = requests.post(f"{args.api_base}/api/agent-tests/{args.id}/run",
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code != 200:
        raise SystemExit(f"Run failed {r.status_code}: {r.text[:300]}")
    data = r.json()
    print(f"Run started: run_id={data.get('run_id')}. "
          f"A browser should open and replay the script with NO AI. "
          f"Watch it in your tool's runs list (triggered_by 'agent-test:{args.id}').")


if __name__ == "__main__":
    main()
