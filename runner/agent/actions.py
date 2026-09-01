"""
ATHMA Visual QA Agent — action mapping (THE CONTRACT).

Translates an agent "decision" (the JSON the LLM returns) into a step dict in
the EXACT format the existing runner already executes. Every agent action maps
1:1 onto one of the runner's 112 existing actions. If it's not in this map, the
agent cannot do it — which guarantees authored scripts replay deterministically.

No runner code is imported or changed here; this only builds step dicts.
"""

# Agent action -> runner action name (must exist in async_runner.py / runner_json.py)
ACTION_MAP = {
    "navigate":       "navigate",
    "click":          "click",
    "double_click":   "double_click",
    "type":           "type",
    "clear":          "clear",
    "select":         "select",          # native <select>
    "search_select":  "search_select",   # ng-select / searchable combobox
    "pick_first":      "pick_first",      # open a popup (e.g. Slot) and take the first option
    "check":          "check",
    "uncheck":        "uncheck",
    "set_date":       "type",            # date inputs go through type w/ formatted value
    "press":          "press",
    "hover":          "hover",
    "scroll":         "scroll",
    "wait_for":       "wait_for_selector",
    "screenshot":     "screenshot",
    # assertions (verify / oracle)
    "assert_visible":  "assert_visible",
    "assert_text":     "assert_text",
    "assert_value":    "assert_value",
    "assert_url":      "assert_url",
    "assert_count":    "assert_count",
    "assert_checked":  "assert_checked",
    "assert_contains": "assert_contains",
    # tables
    "get_table_value": "get_table_value",
    "table_action":    "table_action",
    # memory / variables (cross-screen state)
    "store":           "set_variable",
    "store_text":      "store_text",
    "date_today":      "date_today",
    "execute_script":  "execute_script",
}

# Required step fields per agent action. `ref` is resolved to a selector by the
# caller (using the perception digest) BEFORE build_step is called.
REQUIRED = {
    "navigate":       ["value"],          # value = url
    "click":          ["selector"],
    "type":           ["selector", "value"],
    "search_select":  ["selector", "value"],
    "pick_first":     ["selector"],
    "select":         ["selector", "value"],
    "check":          ["selector"],
    "uncheck":        ["selector"],
    "set_date":       ["selector", "value"],
    "assert_visible": ["selector"],
    "assert_text":    ["selector", "value"],
    "assert_value":   ["selector", "value"],
    "assert_url":     ["value"],
    "assert_count":   ["selector", "value"],
    "store":          ["store_as", "value"],
}


class ActionError(Exception):
    pass


def build_step(decision: dict, digest: dict) -> dict:
    """
    decision: the validated LLM action, e.g.
        {"action":"type","target_ref":"e1","value":"Test","expect":"..."}
    digest:   perception output for the current screen (maps ref -> selector)

    Returns a runner-ready step dict, e.g.
        {"action":"type","selector":"#patient-fname","value":"Test"}

    Raises ActionError if the action is unknown or required fields are missing.
    """
    a = decision.get("action")
    if a not in ACTION_MAP:
        raise ActionError(f"Unknown agent action '{a}'. Allowed: {sorted(ACTION_MAP)}")

    step = {"action": ACTION_MAP[a]}

    # Resolve target_ref -> selector via the digest
    # If the decision includes an explicit 'selector' field, use that directly
    # (agent read it from the digest and passed it back explicitly).
    ref = decision.get("target_ref")
    explicit_sel = decision.get("selector")  # agent may echo back the digest selector
    if explicit_sel:
        step["selector"] = explicit_sel
    elif ref:
        el = _find_ref(digest, ref)
        if el is None:
            raise ActionError(f"target_ref '{ref}' not found in current screen digest")
        step["selector"] = el["selector"]

    # Carry value-style fields straight through
    for f in ("value", "value2", "value3", "value4", "store_as"):
        if decision.get(f) is not None:
            step[f] = decision[f]

    # navigate's url comes in as `value`
    if a == "navigate" and "value" not in step and decision.get("url"):
        step["value"] = decision["url"]

    _validate(a, step)
    return step


def _find_ref(digest: dict, ref: str):
    for el in digest.get("elements", []):
        if el.get("ref") == ref:
            return el
    return None


def _validate(agent_action: str, step: dict):
    for field in REQUIRED.get(agent_action, []):
        if not step.get(field) and step.get(field) != 0:
            raise ActionError(
                f"Action '{agent_action}' requires '{field}' but it was empty. Step: {step}"
            )


# ── Self-test (no runner, no AI) ────────────────────────────────────────────────
if __name__ == "__main__":
    digest = {"elements": [
        {"ref": "e1", "role": "textbox", "name": "First Name", "selector": "#patient-fname"},
        {"ref": "e3", "role": "combobox", "name": "Sex", "selector": "ng-select[name=sex]"},
    ]}
    print(build_step({"action": "type", "target_ref": "e1", "value": "Test"}, digest))
    print(build_step({"action": "search_select", "target_ref": "e3", "value": "Female"}, digest))
    print(build_step({"action": "navigate", "value": "/patient-registration-new"}, digest))
    try:
        build_step({"action": "fly", "target_ref": "e1"}, digest)
    except ActionError as e:
        print("OK rejected:", e)
