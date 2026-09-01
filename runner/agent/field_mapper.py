"""
ATHMA Smart Author -- Field Mapper (Layer 2)

ONE Claude API call: plain English goal -> ordered field-value list.
Supports single-screen and multi-screen goals.
"""
import json
import os
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from llm_client import _load_env_key

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VER = "2023-06-01"
MODEL         = "claude-sonnet-4-6"


def map_goal_to_fields_multi(goal: str, knowledge, start_url: str = "") -> list:
    """
    Maps a plain English goal (single or multi-screen) to an ordered field-value list.
    Emits navigate hints when the flow moves to a new screen.
    """
    key = _load_env_key()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY not set (env or .env)")

    field_catalogue = []
    for el in knowledge.controls:
        name = el.get("name") or ""
        sel  = el.get("selector") or ""
        if not name and not sel:
            continue
        field_catalogue.append({
            "name":     name or sel,
            "type":     el.get("type") or "",
            "readonly": el.get("readonly", False),
            "widget":   el.get("widget") or "",
            "selector": sel,
        })

    system = (
        "You are a QA automation expert. Read a plain English test goal that may span "
        "MULTIPLE screens and map it to an ordered list of steps.\n\n"
        "Return ONLY a JSON array -- no prose, no markdown, no backticks.\n"
        "Each item must have:\n"
        "  field       - field name or description\n"
        "  selector    - exact selector from catalogue, or null for navigate/find steps\n"
        "  value       - value to enter (string, or null for buttons/date pickers)\n"
        "  action_hint - one of: search_select, type, click, date_picker, store_text, navigate, find_record\n"
        "  store_as    - variable name (only for store_text steps)\n\n"
        "Rules:\n"
        "- Follow the ORDER defined in the playbook stages exactly\n"
        "- For navigation to a new screen: action_hint='navigate', value=full URL\n"
        "- For finding a record in a list: action_hint='find_record', value=record identifier\n"
        "- For 'today' dates: action_hint='date_picker', value=null\n"
        "- For storing a result: action_hint='store_text', include 'store_as', selector from playbook\n"
        "- The selector for store_text must come from the playbook -- never guess it\n"
        "- action_hint 'wait' ONLY for numeric ms values -- NEVER for typing text\n"
        "- Readonly/auto-populated fields: DO NOT include\n"
        "- Long Description (#longDescriptionInput) auto-fills -- DO NOT include\n"
        "- Start Date / End Date: use date_picker -- DO NOT add separate calendar button click\n"
        "- When goal mentions finding a saved document (e.g. {{SAIPR}} or DRAFT-xxx):\n"
        "    1. navigate to list page URL\n"
        "    2. type the document number in search box\n"
        "    3. click search button\n"
        "    4. find_record with the document number\n"
        "    5. then the edit/action steps\n"
        "- Always include 'selector' from catalogue for each non-navigate step\n"
        "- Return minimum steps to complete the full goal"
    )

    user = (
        f"GOAL: {goal}\n\n"
        f"STARTING URL: {start_url}\n\n"
        f"FIELD CATALOGUE:\n{json.dumps(field_catalogue, indent=2)}\n\n"
        f"PLAYBOOK:\n{knowledge.playbook}\n\n"
        f"Return the complete ordered step list as JSON array covering ALL screens in the goal."
    )

    resp = requests.post(
        ANTHROPIC_URL,
        headers={
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VER,
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": 4000,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=90,
    )

    if resp.status_code != 200:
        raise RuntimeError(f"Claude API error {resp.status_code}: {resp.text[:300]}")

    text = resp.json()["content"][0]["text"].strip()
    if text.startswith("```"):
        lines = [l for l in text.split("\n") if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        result = json.loads(text)
        if not isinstance(result, list):
            raise ValueError("Expected a JSON array")
        return result
    except Exception as e:
        raise RuntimeError(f"Field mapper failed: {e}\nResponse:\n{text}")


def map_goal_to_fields(goal: str, knowledge) -> list:
    """Single-screen convenience wrapper."""
    return map_goal_to_fields_multi(goal, knowledge, start_url="")
