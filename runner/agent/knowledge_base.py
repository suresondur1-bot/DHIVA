"""
ATHMA Smart Author -- Knowledge Base (Layer 1)

Loads and provides:
  - Screen controls (from study screen _controls.json)
  - Playbook (from playbooks/*.md)
  - Widget interaction patterns (hardcoded, built from experience)

This is the ONLY place widget knowledge lives. Add a new pattern here
and it works everywhere automatically.
"""
import json
import os
import re

PLAYBOOKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "playbooks")


# -- Widget interaction patterns ----------------------------------------------
# Each pattern describes HOW to interact with a widget type.
# The execution engine reads these and generates the correct step sequence.

WIDGET_PATTERNS = {

    # ngbdatepicker -- readonly calendar input (Angular Bootstrap)
    "ngbdatepicker": {
        "description": "Angular Bootstrap readonly date picker",
        "match": lambda el: el.get("widget") == "ngbdatepicker" or (
            el.get("readonly") and el.get("type") == "dateinput"
        ),
        "steps": [
            {"action": "date_today", "value": "__today_aria__", "value2": "%A, %B %#d, %Y"},
            {"action": "click", "selector": "__picker_button__"},
            {"action": "wait", "value": "500"},
            {"action": "click", "selector": "[aria-label='__today_aria_val__']"},
            {"action": "wait", "value": "300"},
        ],
        "supports_value": False,
    },

    # ng-select -- searchable dropdown (Angular)
    "ng-select": {
        "description": "Angular ng-select searchable dropdown",
        "match": lambda el: el.get("type") == "combobox",
        "steps": [
            {"action": "search_select", "selector": "__selector__", "value": "__value__"},
        ],
        "supports_value": True,
    },

    # ngb-typeahead -- search-as-you-type plain input
    "ngb-typeahead": {
        "description": "Angular Bootstrap typeahead search input",
        "match": lambda el: (
            el.get("type") == "textbox"
            and not el.get("readonly")
            and any(x in (el.get("selector") or "").lower()
                    for x in ["input", "search", "supplier", "item"])
        ),
        "steps": [
            {"action": "search_select", "selector": "__selector__", "value": "__value__"},
        ],
        "supports_value": True,
    },

    # readonly textbox -- auto-populated, skip
    "readonly-textbox": {
        "description": "Read-only auto-populated field -- skip",
        "match": lambda el: el.get("readonly") and el.get("type") in ("textbox", "dateinput")
                            and el.get("widget") != "ngbdatepicker",
        "steps": [],
        "supports_value": False,
    },

    # plain textbox -- type directly
    "textbox": {
        "description": "Plain text input",
        "match": lambda el: el.get("type") == "textbox" and not el.get("readonly"),
        "steps": [
            {"action": "type", "selector": "__selector__", "value": "__value__"},
        ],
        "supports_value": True,
    },

    # button -- click
    "button": {
        "description": "Button click",
        "match": lambda el: el.get("type") == "button",
        "steps": [
            {"action": "click", "selector": "__selector__"},
        ],
        "supports_value": False,
    },

    # checkbox
    "checkbox": {
        "description": "Checkbox",
        "match": lambda el: el.get("type") == "checkbox",
        "steps": [
            {"action": "check", "selector": "__selector__"},
        ],
        "supports_value": False,
    },
}


def get_widget_pattern(element: dict) -> dict:
    """Return the matching widget pattern for an element, or None."""
    for name, pattern in WIDGET_PATTERNS.items():
        try:
            if pattern["match"](element):
                return pattern
        except Exception:
            continue
    return None


# -- Screen knowledge base ---------------------------------------------------

class ScreenKnowledge:
    """
    Holds everything known about one screen:
      - All controls (from _controls.json produced by Study Screen)
      - The playbook (from playbooks/*.md)
    """

    def __init__(self, screen_slug: str):
        self.slug = screen_slug
        self.controls = []
        self.playbook = ""
        self.field_map = {}
        self._load()

    def _load(self):
        controls_path = os.path.join(PLAYBOOKS_DIR, f"{self.slug}_controls.json")
        if os.path.exists(controls_path):
            with open(controls_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.controls = data.get("elements", [])
            for el in self.controls:
                name = (el.get("name") or "").strip()
                if name:
                    self.field_map[name.lower()] = el
                sel = el.get("selector") or ""
                if "#" in sel:
                    frag = sel.split("#")[-1].split(")")[0].split(" ")[0].lower()
                    if frag:
                        self.field_map[frag] = el

        playbook_path = os.path.join(PLAYBOOKS_DIR, f"{self.slug}.md")
        if os.path.exists(playbook_path):
            with open(playbook_path, "r", encoding="utf-8") as f:
                self.playbook = f.read()

    def find_element(self, field_name: str):
        """Find an element by field name (fuzzy match)."""
        key = field_name.strip().lower()

        if key in self.field_map:
            return self.field_map[key]

        for fname, el in self.field_map.items():
            if key in fname or fname in key:
                return el

        key_words = set(re.split(r'\W+', key)) - {"", "the", "a", "an", "of", "for"}
        best_score = 0
        best_el = None
        for fname, el in self.field_map.items():
            fname_words = set(re.split(r'\W+', fname)) - {"", "the", "a", "an", "of", "for"}
            score = len(key_words & fname_words)
            if score > best_score:
                best_score = score
                best_el = el

        return best_el if best_score > 0 else None

    def get_picker_button_selector(self, element: dict):
        """
        For a date picker element, return the adjacent calendar button selector.
        Known mappings take priority; falls back to td-position derivation.
        """
        sel = element.get("selector") or ""

        # Known mappings -- add new screens here
        known = {
            "#serviceStartDate": "tbody > tr > td:nth-of-type(12) > div > button",
            "#serviceEndDate":   "tbody > tr > td:nth-of-type(13) > div > button",
        }
        if sel in known:
            return known[sel]

        # Derive from td position in selector
        td_match = re.search(r'td:nth-of-type\((\d+)\)', sel)
        if td_match:
            return f"tbody > tr > td:nth-of-type({td_match.group(1)}) > div > button"

        return None


def load_screen_knowledge(url: str):
    """
    Load screen knowledge for the given URL by matching against _registry.json.
    Returns None if no matching screen found.
    """
    registry_path = os.path.join(PLAYBOOKS_DIR, "_registry.json")
    if not os.path.exists(registry_path):
        return None

    with open(registry_path, "r", encoding="utf-8") as f:
        registry = json.load(f)

    for entry in registry.get("playbooks", []):
        match = entry.get("match", "")
        if match and match in url:
            slug = entry.get("file", "").replace(".md", "")
            return ScreenKnowledge(slug)

    return None
