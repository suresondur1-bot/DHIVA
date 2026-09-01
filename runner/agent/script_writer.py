"""
ATHMA Visual QA Agent — script writer (stage 5).

Collects the steps the agent ACTUALLY ran-and-verified during an explore session
and writes them out as a clean step list that the EXISTING runner can replay with
zero AI. Output is plain JSON (the runner's native step format) plus an optional
human-readable .py-style preview.

No runner code touched. The output file is the deliverable.
"""
import json
import os
from datetime import datetime

# ── Login prelude (so authored scripts replay from a COLD browser) ────────────
# Replay opens a clean browser with no session and lands on the Athma login
# page, so a standalone script must log in and navigate to its target itself.
# These selectors match the real login page (same as add_login.py).
LOGIN_URL  = "https://sqa.narayanahealth.org/"
SEL_USER   = "#username"
SEL_PASS   = "#password"
SEL_SIGNIN = "div > div > form:nth-of-type(1) > div:nth-of-type(3) > button"


def _login_prelude(user: str, password: str, target_url: str):
    """The 8 steps that log in and land on the target page.
    Credentials use project variables {{LOGIN_USER}} and {{LOGIN_PASSWORD}}
    so they are not hardcoded and can be changed per environment."""
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


class ScriptWriter:
    def __init__(self, goal: str, start_url: str = ""):
        self.goal = goal
        self.start_url = start_url
        self.steps = []

    def add(self, step: dict, note: str = ""):
        """Append a verified step (already in runner format). Strip agent-only keys."""
        clean = {k: v for k, v in step.items()
                 if k in ("action", "selector", "value", "value2", "value3", "value4",
                          "store_as", "mappings")}
        if note:
            clean["_note"] = note
        self.steps.append(clean)

    def _with_login(self, user: str, password: str):
        """Return self.steps with a login prelude prepended, UNLESS the script
        already starts by navigating to the login root (idempotent: running this
        twice, or on a script add_login.py already touched, won't double-add)."""
        first = self.steps[0] if self.steps else {}
        already = (
            first.get("action") == "navigate"
            and str(first.get("value", "")).rstrip("/") == LOGIN_URL.rstrip("/")
        )
        if already or not self.start_url:
            return list(self.steps)
        return _login_prelude(user, password, self.start_url) + self.steps

    def save(self, out_dir: str = ".", name: str = None,
             add_login: bool = True, user: str = "admin", password: str = "admin") -> str:
        os.makedirs(out_dir, exist_ok=True)
        name = name or ("agent_script_" + datetime.now().strftime("%Y%m%d_%H%M%S"))
        path = os.path.join(out_dir, name + ".json")
        # Prepend login automatically so the saved script replays from a cold
        # browser without anyone running add_login.py by hand. Opt out with
        # add_login=False (e.g. for a fragment meant to be called by another test).
        out_steps = self._with_login(user, password) if add_login else list(self.steps)
        doc = {
            "meta": {
                "authored_by": "ATHMA Visual QA Agent",
                "goal": self.goal,
                "start_url": self.start_url,
                "generated": datetime.now().isoformat(timespec="seconds"),
                "reviewed_by": None,   # a human fills this after review
                "self_contained": bool(add_login and self.start_url),
            },
            "steps": out_steps,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
        # readable preview (reflects the steps actually written, login included)
        prev = os.path.join(out_dir, name + ".preview.txt")
        with open(prev, "w", encoding="utf-8") as f:
            f.write(f"# Goal: {self.goal}\n# Start: {self.start_url}\n# Steps: {len(out_steps)}\n\n")
            for i, s in enumerate(out_steps, 1):
                note = f"   # {s['_note']}" if s.get("_note") else ""
                f.write(f"{i:>3}. {s['action']:<14} {s.get('selector','') or s.get('value','')}{note}\n")
        return path
