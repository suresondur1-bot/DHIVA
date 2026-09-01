"""
ATHMA Visual QA Agent — LLM client (stage 3).

ONE job: given (goal, perception digest, screenshot, short memory of prior
actions), ask Claude for the SINGLE next action, returned as strict JSON that
maps onto actions.py.

Matches the runner's existing Claude usage exactly: plain requests.post to
https://api.anthropic.com/v1/messages with x-api-key + anthropic-version, and
vision via a base64 image block. No new SDK dependency. Reads ANTHROPIC_API_KEY
from the environment / .env, same as the runner.

NO runner code changed. NO action executed here — this only returns a decision.
"""
import os
import json
import base64
import requests

from config import MODEL, MAX_TOKENS

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

_PLAYBOOK_DIR = os.path.join(os.path.dirname(__file__), "playbooks")
_PLAYBOOK_CACHE = {}  # cleared on each agent run start via clear_playbook_cache()


def clear_playbook_cache():
    """Call at the start of each agent run so updated playbooks are always loaded fresh."""
    _PLAYBOOK_CACHE.clear()


def _load_playbook(url: str) -> str:
    """Return the screen-specific playbook text for this URL, or '' if none.

    Reads playbooks/_registry.json (URL substring -> file). First match wins.
    Unknown screens get '' — the generic global rules still apply. This is what
    lets the agent generalise: registration rules load only on the registration
    URL, indent rules only on the indent URL, etc., instead of one giant prompt.
    """
    if not url:
        return ""
    try:
        reg_path = os.path.join(_PLAYBOOK_DIR, "_registry.json")
        with open(reg_path, "r", encoding="utf-8") as f:
            registry = json.load(f)
        for entry in registry.get("playbooks", []):
            if entry.get("match", "") and entry["match"] in url:
                fname = entry["file"]
                if fname in _PLAYBOOK_CACHE:
                    return _PLAYBOOK_CACHE[fname]
                fpath = os.path.join(_PLAYBOOK_DIR, fname)
                with open(fpath, "r", encoding="utf-8") as pf:
                    text = pf.read().strip()
                _PLAYBOOK_CACHE[fname] = text
                return text
    except Exception:
        # A missing/broken playbook must never crash authoring — fall back to generic.
        return ""
    return ""


def _load_env_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = (
        os.path.join(here, ".env"),
        os.path.join(here, "..", ".env"),
        os.path.join(here, "..", "..", ".env"),
        os.path.join(here, "..", "..", "backend", ".env"),
        r"C:\Users\337799\Automation\backend\.env",  # absolute fallback
    )
    for path in candidates:
        absp = os.path.abspath(path)
        if not os.path.exists(absp):
            continue
        try:
            with open(absp, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line[0] == "#":
                        continue
                    if "=" in line and line.split("=", 1)[0].strip() == "ANTHROPIC_API_KEY":
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
        except Exception:
            continue
    return ""


# The agent's allowed action vocabulary (must match actions.py ACTION_MAP keys).
ALLOWED_ACTIONS = [
    "navigate", "click", "double_click", "type", "clear", "select",
    "search_select", "pick_first", "check", "uncheck", "set_date", "press", "hover",
    "scroll", "wait_for", "assert_visible", "assert_text", "assert_value",
    "assert_url", "assert_count", "assert_checked", "store", "store_text",
    "date_today", "execute_script", "finish",
]

# ── Widget pattern library ─────────────────────────────────────────────────────
# Teaches the agent HOW to interact with specific Angular widget types.
# Encoded once here — applies to every screen, every run, automatically.
# Add new patterns here whenever a new widget type is encountered.
WIDGET_PATTERNS = """
=== WIDGET INTERACTION RULES (read from digest attributes) ===

The digest now includes extra attributes on each element that tell you exactly
how to interact with it. Always check these before deciding an action:

## FIELD DISAMBIGUATION — Service Purchase Requisition
When on service-purchase-requisition screen:
- #itemInput = Service code/Description search (FIRST column) — search the SERVICE CODE here
- #longDescriptionInput = Long Description (THIRD column) — search the DESCRIPTION TEXT here
- NEVER search a service code (e.g. S-D-AE02-...) into #longDescriptionInput
- NEVER search a description text into #itemInput
- After selecting #itemInput, wait 1500ms — #longDescriptionInput auto-fills, do NOT touch it

## readonly=true + widget=ngbdatepicker + has_picker_button=true
This is a readonly calendar date picker. NEVER type into it.
Correct steps:
  1. date_today action → store as today_aria with value2="%A, %B %#d, %Y"
     (produces e.g. "Wednesday, July 1, 2026")
  2. click the adjacent calendar button (the button element in the same cell)
  3. wait 500ms
  4. click [aria-label='{{today_aria}}'] to select today
For a specific date: use the same aria-label format.

## readonly=true (without ngbdatepicker)
Field is read-only — auto-populated by the app. Do NOT interact with it.
Move on to the next required field.

## type=combobox (ng-select)
Always use search_select. Never use type or click.

## has_picker_button=true (without readonly)
Field accepts typing but also has a picker. Prefer typing directly if not readonly.

## After selecting an item/code (search_select on service/product fields)
Many fields auto-populate. Wait 1500ms, then re-read the digest.
Fields that become readonly after auto-fill — skip them.

## Document number after Save (.td-pr)
After Save/Submit, the document number is in <td class="td-pr">.
Use store_text with selector .td-pr.

=== END WIDGET RULES ===
"""
SYSTEM_PROMPT = WIDGET_PATTERNS + """
You are a senior QA engineer testing a hospital web application.

RULES:
- Return ONE action only, as strict JSON. No prose, no markdown, no backticks.
- VALIDATION ERRORS FIRST: the digest includes an "errors" list of messages the
  form is currently showing (e.g. "Date of Birth is required", "City is mandatory").
  If "errors" is non-empty, your next action MUST address one of them — find the
  field named in the error and fill/fix it. Work through the errors before trying
  to submit again. The form's own messages are the source of truth for what's
  required, more than the required=true flags.
- UNIQUENESS: to avoid duplicate-record errors, when a field needs a value that
  must be unique (e.g. a new record's name/code), you MAY append the token
  {{random}} to make it unique, e.g. value "Test{{random}}". The system replaces
  {{random}} with a real number at run time. If the form shows a 'duplicate' /
  'already exists' error after submitting, re-enter the value WITH a {{random}}
  suffix and submit again.
- Always target an element by its "ref" from the digest (e.g. "e21"). Never guess
  coordinates. Only reference refs that exist in the digest you were given.
- CRITICAL: Each element in the digest includes its "selector" field — this is the
  REAL live selector captured from the page. When you emit an action, set the
  selector to exactly the value in the digest for that ref. NEVER invent or guess
  a selector — always copy it from the digest. If the goal mentions a selector
  by name (e.g. #longDescriptionInput), find the element in the digest whose
  selector matches or whose name matches, and use the digest's selector value.
- Choose the action that matches the element's "type":
    textbox/dateinput -> "type"   (for dateinput, format the value as shown by the field's placeholder, e.g. dd/mm/yyyy)
    combobox          -> "search_select"   (type-to-filter dropdown; type the value, then pick the matching option)
    select            -> "select"
    checkbox          -> "check" or "uncheck"
    button/link       -> "click"
    a field that opens a popup/modal to choose from (date/slot/lookup pickers)
      -> "pick_first" (opens it and takes the first valid/available option). The
      popup may take a few seconds to load; do NOT cancel it if it looks empty at
      first — pick_first waits. Only give up if pick_first itself fails.
- Respect required fields (marked with required=true). Fill them before submitting.
- If a field is disabled, do not act on it; it will enable when prerequisites are met.
- For a REQUIRED field whose value the goal did NOT specify: do NOT guess random
  text. Instead propose a sensible default and set "assumed": true on the action:
    * combobox/select -> pick the FIRST available real option (search a single
      common letter only if needed to reveal options; never type the field's own
      label as a search term).
    * textbox -> a short valid placeholder (e.g. a city name, a 10-digit phone, a
      valid-format email).
    * dateinput -> a valid date in the field's format.
  When the goal DID specify the value, use it exactly and omit "assumed".
- DEPENDENT / CASCADING fields are common. If a dropdown shows no options (e.g. it
  depends on another field not yet set, or says 'No ... Found'), do the
  prerequisite first, then return to it — do not keep retrying an empty dropdown.
  Some fields auto-fill others on blur (e.g. a code field populating name/location
  fields); after typing such a field, do NOT manually type the fields it fills —
  re-perceive and see what populated. Searchable-dropdown fields usually must be
  explicitly picked (search_select), they do not auto-fill themselves.
- MODALS: if a popup/modal is open, deal with it (make its selection / close it)
  before clicking anything else. Never click background fields while a modal is up.
- Do NOT click the final Save/Submit/Register button until all required fields are
  filled and there are no validation errors.
- SCREEN-SPECIFIC GUIDANCE: if a "PLAYBOOK FOR THIS SCREEN" section is provided
  below, it describes this exact screen's order of operations, custom widgets, and
  cascades. Follow it closely — it overrides the generic guidance above where they
  differ. If no playbook is provided, rely on the generic rules and what you see.
- When the goal is achieved, return {"action":"finish","reason":"..."}.

OUTPUT SCHEMA (return exactly this shape):
{
  "thought": "one short sentence of reasoning",
  "action": "<one of the allowed actions>",
  "target_ref": "<ref from digest, or null for navigate/finish>",
  "selector": "<copy the selector field EXACTLY from the digest element with that ref>",
  "value": "<text to type / option to select / url, or null>",
  "assumed": false,
  "expect": "what should be visibly true after this action",
  "done": false
}
(Always populate 'selector' by copying it from the digest element.
Set "assumed": true ONLY when you chose a value for a required field that the
goal did not specify.)
"""


def _compact_digest(digest: dict) -> dict:
    """Strip bbox and noise; keep what the model needs to choose an action.
    Includes the selector so the agent uses the REAL live selector instead of
    hallucinating one from the playbook or goal text."""
    els = []
    for e in digest.get("elements", []):
        item = {
            "ref":      e["ref"],
            "type":     e["type"],
            "name":     e.get("name", ""),
            "selector": e.get("selector", ""),   # ← always include real live selector
        }
        if e.get("required"):         item["required"]         = True
        if e.get("disabled"):         item["disabled"]         = True
        if e.get("readonly"):         item["readonly"]         = True
        if e.get("widget"):           item["widget"]           = e["widget"]
        if e.get("has_picker_button"): item["has_picker_button"] = True
        if e.get("placeholder"):      item["placeholder"]      = e["placeholder"]
        if "checked" in e:            item["checked"]          = e["checked"]
        if e.get("value"):            item["value"]            = e["value"]
        if e.get("text"):             item["text"]             = e["text"]
        els.append(item)
    tables = [{"ref": t["ref"], "headers": t.get("headers"), "row_count": t.get("row_count")}
              for t in digest.get("tables", [])]
    return {"url": digest.get("url"), "title": digest.get("title"),
            "elements": els, "tables": tables,
            "errors": digest.get("errors", [])}


def decide(goal: str, digest: dict, screenshot: bytes, memory: list, timeout: int = 60) -> dict:
    """
    Returns the parsed decision dict. Raises on API or parse failure so the
    loop can heal/stop rather than act on garbage.
    """
    key = _load_env_key()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY not set (env or .env)")

    # Load any screen-specific playbook for the current URL and append it to the
    # generic system prompt. Unknown screens get generic-only rules.
    playbook = _load_playbook(digest.get("url", ""))
    system_prompt = SYSTEM_PROMPT
    if playbook:
        system_prompt = (SYSTEM_PROMPT
                         + "\n\n=== PLAYBOOK FOR THIS SCREEN ===\n"
                         + playbook
                         + "\n=== END PLAYBOOK ===\n")

    b64 = base64.b64encode(screenshot).decode("ascii")
    mem_txt = "\n".join(f"- {m}" for m in memory[-12:]) or "(nothing yet)"

    user_text = (
        f"GOAL: {goal}\n\n"
        f"ACTIONS TAKEN SO FAR:\n{mem_txt}\n\n"
        f"CURRENT SCREEN DIGEST (JSON):\n{json.dumps(_compact_digest(digest))}\n\n"
        f"IMPORTANT: The digest above includes the real 'selector' for each element.\n"
        f"When you choose an element, copy its selector EXACTLY from the digest.\n"
        f"Do NOT use selectors from the playbook or goal text — always use the digest selector.\n\n"
        f"Allowed actions: {', '.join(ALLOWED_ACTIONS)}\n"
        f"Return ONE action as strict JSON, nothing else."
    )

    body = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": user_text},
            ],
        }],
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
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    return _parse_action(text)


def _parse_action(text: str) -> dict:
    """Parse the model's JSON, tolerating stray backticks/prose."""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t.lower().startswith("json"):
            t = t[4:]
    # grab the outermost {...}
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"No JSON object in model reply: {text[:200]}")
    obj = json.loads(t[start:end + 1])
    if obj.get("action") not in ALLOWED_ACTIONS:
        raise ValueError(f"Model returned disallowed action '{obj.get('action')}'")
    return obj


# ── Standalone check: feed a saved digest + screenshot, print the decision ──────
# Run AFTER perception.py has written perception_sample.json/.png:
#   python agent/llm_client.py "Register a new patient named Test Patient, Male, age 30"
if __name__ == "__main__":
    import sys
    goal = sys.argv[1] if len(sys.argv) > 1 else "Register a new patient: First Name 'Test', Sex Male, Age 30 years"
    with open("perception_sample.json", "r", encoding="utf-8") as f:
        digest = json.load(f)
    with open("perception_sample.png", "rb") as f:
        shot = f.read()
    decision = decide(goal, digest, shot, memory=[])
    print(json.dumps(decision, indent=2))
