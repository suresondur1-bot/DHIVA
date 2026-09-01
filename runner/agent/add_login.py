"""
ATHMA Visual QA Agent — add a self-contained LOGIN PRELUDE to a script.

Replay opens a CLEAN browser with no session, so it lands on the Athma login
page. A standalone replayable script must therefore log in and navigate to the
target page itself. This tool prepends those steps to an existing agent script.

Login selectors (captured from the real login page):
  username -> #username
  password -> #password
  sign in  -> div > div > form:nth-of-type(1) > div:nth-of-type(3) > button

SECURITY NOTE: this bakes the password into the script steps (stored in the DB
in plain text). Fine for SQA/dummy admin/admin. For anything real, use the
runner's {{variable}} support instead of a literal password.

Usage:
  python agent/add_login.py --file agent/output/agent_script_XXXX.json \
      --user admin --password admin \
      --target-url https://sqa.narayanahealth.org/ambweb/patient-registration-new
"""
import os
import json
import argparse

LOGIN_URL   = "https://sqa.narayanahealth.org/"
SEL_USER    = "#username"
SEL_PASS    = "#password"
SEL_SIGNIN  = 'div > div > form:nth-of-type(1) > div:nth-of-type(3) > button'


def login_prelude(user: str, password: str, target_url: str):
    return [
        {"action": "navigate", "value": LOGIN_URL, "_note": "open Athma login page"},
        {"action": "wait_for_selector", "selector": SEL_USER, "_note": "wait for login form"},
        {"action": "type", "selector": SEL_USER, "value": user, "_note": "enter username"},
        {"action": "type", "selector": SEL_PASS, "value": password, "_note": "enter password"},
        {"action": "click", "selector": SEL_SIGNIN, "_note": "click Sign in"},
        {"action": "wait", "value": "3000", "_note": "wait for login to complete"},
        {"action": "navigate", "value": target_url, "_note": "go to the target page"},
        {"action": "wait", "value": "3000", "_note": "wait for the page to load"},
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--target-url",
                    default="https://sqa.narayanahealth.org/ambweb/patient-registration-new")
    ap.add_argument("--out", help="output file (default: <file>_selfcontained.json)")
    args = ap.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        doc = json.load(f)

    steps = doc.get("steps", [])
    prelude = login_prelude(args.user, args.password, args.target_url)
    doc["steps"] = prelude + steps
    meta = doc.setdefault("meta", {})
    meta["self_contained"] = True
    meta["note"] = "Login prelude prepended; replays without manual login."

    out = args.out or args.file.replace(".json", "_selfcontained.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    print(f"Wrote {out} with {len(prelude)} login steps + {len(steps)} original steps "
          f"= {len(doc['steps'])} total.")
    print("Publish this _selfcontained file so replay logs in by itself.")


if __name__ == "__main__":
    main()
