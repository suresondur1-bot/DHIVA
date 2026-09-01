"""
ATHMA Visual QA Agent — STUDY SCREEN (auto-tuning for a NEW screen).

This is the self-service version of what we did BY HAND for the stock-indent
screen: log in, open the screen, read every control with perception.perceive(),
and turn that control map into a draft PLAYBOOK so the agent can author on this
screen without a human writing the playbook first.

What it does, non-interactively (the backend spawns it from a UI button):
  1. logs itself in (same selectors as headless_author.py),
  2. navigates to --target-url,
  3. runs perception.perceive() — the SAME digest the agent reasons over,
  4. asks Claude ONCE to convert that control map into a screen playbook
     (order of operations, which controls are dropdowns vs plain inputs vs
     disabled/auto-fill, cascades, submit buttons),
  5. writes playbooks/<slug>.md and adds a _registry.json entry (URL substring
     -> file) so llm_client._load_playbook() picks it up automatically,
  6. prints PLAYBOOK_PATH=<abs> and a short control summary.

After this runs, "Create with agent" on that screen uses real, screen-specific
guidance instead of generic-only rules. A human can still edit the .md after.

NO runner code changed. Reuses perception + the same Claude usage as llm_client.
Use on SQA / dummy data only (it logs in with the given creds).

Usage (backend calls it like this):
  python agent/study_screen.py \
    --target-url https://sqa.narayanahealth.org/phrweb/some-new-screen \
    --login-url  https://sqa.narayanahealth.org/ \
    --user admin --password admin \
    [--label "Some New Screen"] [--match some-new-screen] [--headful]
"""
import os
import re
import sys
import json
import base64
import argparse
import asyncio

import requests
from playwright.async_api import async_playwright

from perception import perceive_full, digest_summary
from config import MODEL

# Same login selectors the headless author uses.
LOGIN_SEL_USER   = "#username"
LOGIN_SEL_PASS   = "#password"
LOGIN_SEL_SIGNIN = 'div > div > form:nth-of-type(1) > div:nth-of-type(3) > button'

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

_PLAYBOOK_DIR = os.path.join(os.path.dirname(__file__), "playbooks")


# ── env key (same convention as llm_client / runner) ───────────────────────────
def _load_env_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    here = os.path.dirname(__file__)
    for path in (".env", os.path.join(here, ".env"),
                 os.path.join(here, "..", ".env"),
                 os.path.join(here, "..", "..", ".env"),
                 os.path.join(here, "..", "..", "backend", ".env")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("ANTHROPIC_API_KEY="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
        except FileNotFoundError:
            continue
    return ""


async def _login_and_navigate(page, login_url, user, password, target_url):
    print(f"[study] navigating to login: {login_url}", flush=True)
    await page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_selector(LOGIN_SEL_USER, timeout=15000)
    await page.fill(LOGIN_SEL_USER, user)
    await page.fill(LOGIN_SEL_PASS, password)
    await page.click(LOGIN_SEL_SIGNIN)
    await page.wait_for_timeout(3000)
    print(f"[study] navigating to target: {target_url}", flush=True)
    await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_timeout(3500)


# ── derive a registry "match" substring + file slug from the URL ───────────────
def _derive_match_and_slug(url: str, override_match: str = "") -> tuple:
    """
    match: a URL substring used to recognise this screen later (e.g. 'stock-indent').
    slug : the playbook filename stem (e.g. 'stock_indent').
    """
    if override_match:
        match = override_match.strip()
    else:
        # last meaningful path segment, minus trailing -new / -create / ids
        path = re.sub(r"https?://[^/]+", "", url).strip("/")
        seg = ""
        for part in reversed(path.split("/")):
            part = part.split("?")[0].strip()
            if part and not part.isdigit():
                seg = part
                break
        seg = re.sub(r"-(new|create|add|edit|list)$", "", seg)
        match = seg or "screen"
    slug = re.sub(r"[^a-z0-9]+", "_", match.lower()).strip("_") or "screen"
    return match, slug


# ── the one Claude call: control map -> draft playbook markdown ────────────────
def _draft_playbook(label: str, url: str, digest: dict, timeout: int = 90) -> str:
    key = _load_env_key()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY not set (env or .env)")

    # Compact the digest the same way the agent sees it (type/name/flags), so the
    # model writes the playbook from the SAME control map the agent will use.
    els = []
    for e in digest.get("elements", []):
        item = {"ref": e["ref"], "type": e["type"], "name": e.get("name", ""),
                "selector": e.get("selector", "")}
        if e.get("required"): item["required"] = True
        if e.get("disabled"): item["disabled"] = True
        if e.get("value"):    item["value"] = e["value"]
        if e.get("text"):     item["text"] = e["text"]
        els.append(item)
    tables = [{"ref": t["ref"], "headers": t.get("headers"), "row_count": t.get("row_count")}
              for t in digest.get("tables", [])]
    control_map = {"url": url, "title": digest.get("title"),
                   "elements": els, "tables": tables,
                   "errors": digest.get("errors", [])}

    system = (
        "You are a senior QA automation engineer. You are given the CONTROL MAP of "
        "ONE screen of a hospital web app (Angular + ng-select). Write a concise "
        "PLAYBOOK in Markdown that teaches an autonomous agent how to fill and submit "
        "this screen. The agent already knows generic rules; the playbook captures "
        "what is SPECIFIC to THIS screen.\n\n"
        "Base every statement on the control map provided — do NOT invent fields or "
        "selectors that are not present. Use the exact selectors from the map.\n\n"
        "Cover, in this order:\n"
        "1. A one-line description and the URL substring.\n"
        "2. ORDER OF OPERATIONS: the sequence to fill controls. Group into stages if "
        "the screen clearly has them (e.g. a Next button between groups).\n"
        "3. For each important control, say which ACTION to use based on its type:\n"
        "   - type=combobox  -> search_select (type-to-filter dropdown; pick the suggestion)\n"
        "   - type=textbox    -> type (note if it is actually a type-to-search autocomplete)\n"
        "   - type=select     -> select\n"
        "   - type=checkbox/radio -> check/uncheck\n"
        "   - type=dateinput  -> type in the field's date format\n"
        "   - type=button/link -> click\n"
        "4. Flag any DISABLED control as 'do not touch — auto-fills from <prerequisite>'.\n"
        "5. Note likely CASCADES (a field that auto-fills others; a dropdown that depends "
        "on a prior field).\n"
        "6. SUBMIT: identify the Save / Submit / Send-for-Approval style buttons by their "
        "visible text, and say not to click them until required fields are filled and there "
        "are no validation errors.\n"
        "7. A short NOTES section for gotchas you can infer (autocompletes needing an explicit "
        "pick; treating a chosen field as done; disambiguation by code if names repeat).\n\n"
        "Keep it tight and practical, like a runbook. Output ONLY the Markdown playbook, "
        "no preamble, no backticks."
    )
    user = (
        f"SCREEN LABEL: {label}\n"
        f"URL: {url}\n\n"
        f"CONTROL MAP (JSON):\n{json.dumps(control_map, indent=2)}\n\n"
        "Write the playbook now."
    )

    body = {
        "model": MODEL,
        "max_tokens": 2000,
        "system": system,
        "messages": [{"role": "user", "content": [{"type": "text", "text": user}]}],
    }
    resp = requests.post(
        ANTHROPIC_URL,
        headers={"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION,
                 "Content-Type": "application/json"},
        json=body, timeout=timeout,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Claude API {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    text = "".join(b.get("text", "") for b in data.get("content", [])
                   if b.get("type") == "text").strip()
    # strip stray fences if the model added them
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("markdown"):
            text = text[len("markdown"):]
        elif text.lower().startswith("md"):
            text = text[2:]
    return text.strip()


# ── register the new playbook (idempotent; most-specific first) ────────────────
def _register(match: str, slug: str, label: str) -> str:
    os.makedirs(_PLAYBOOK_DIR, exist_ok=True)
    reg_path = os.path.join(_PLAYBOOK_DIR, "_registry.json")
    try:
        with open(reg_path, "r", encoding="utf-8") as f:
            registry = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        registry = {"playbooks": []}
    registry.setdefault("playbooks", [])
    fname = f"{slug}.md"
    # update existing entry for this match if present, else insert at the FRONT
    # (more specific, freshly-studied screens should win over older generic ones)
    existing = next((e for e in registry["playbooks"] if e.get("match") == match), None)
    if existing:
        existing["file"] = fname
        existing["label"] = label
    else:
        registry["playbooks"].insert(0, {"match": match, "file": fname, "label": label})
    with open(reg_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2)
    return reg_path


async def main_async(args):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=not args.headful)
        page = await browser.new_page()
        try:
            await _login_and_navigate(page, args.login_url, args.user,
                                      args.password, args.target_url)
            digest, shot = await perceive_full(page)
            url = digest.get("url", args.target_url)

            # Print the control summary so the user can eyeball it (same as the
            # manual capture step), and so the backend can surface it.
            print("\n" + digest_summary(digest), flush=True)

            n_controls = len(digest.get("elements", []))
            if n_controls == 0:
                print("STUDY_ERROR=No interactable controls found. Is the page fully "
                      "loaded / are you on the right URL?", flush=True)
                return

            label = args.label or (digest.get("title") or "Screen").strip()
            match, slug = _derive_match_and_slug(url, args.match)

            playbook_md = _draft_playbook(label, url, digest)
            # Prepend a header line we can rely on, then the model's body.
            header = (f"# Playbook: {label}\n\n"
                      f"URL contains: {match}\n\n"
                      f"_Auto-drafted by Study Screen from the live control map. "
                      f"Review and refine as needed._\n\n")
            # Avoid double H1 if the model already started with one.
            body = playbook_md
            if body.lstrip().lower().startswith("# playbook"):
                header = ""
            full_md = header + body + "\n"

            out_path = os.path.join(_PLAYBOOK_DIR, f"{slug}.md")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(full_md)
            reg_path = _register(match, slug, label)

            # Save the raw control map next to it for reference/debugging.
            map_path = os.path.join(_PLAYBOOK_DIR, f"{slug}_controls.json")
            with open(map_path, "w", encoding="utf-8") as f:
                json.dump(digest, f, indent=2)

            print(f"\n[study] controls={n_controls} match='{match}' slug='{slug}'", flush=True)
            print(f"[study] registered in {reg_path}", flush=True)
            print(f"PLAYBOOK_PATH={out_path}", flush=True)
        finally:
            await page.wait_for_timeout(1200)
            await browser.close()


def main():
    ap = argparse.ArgumentParser(description="Study a new screen and draft its playbook")
    ap.add_argument("--target-url", required=True)
    ap.add_argument("--login-url", default="https://sqa.narayanahealth.org/")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--label", default="", help="human label for the screen")
    ap.add_argument("--match", default="", help="URL substring to match (auto-derived if omitted)")
    ap.add_argument("--headful", action="store_true", help="show the browser (default headless)")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
