"""
custom_controls.py - Qavya custom-control engine (ISOLATED, additive).

Lets users teach Qavya how to recognize and operate controls it doesn't natively
support. A control DEFINITION is pure data (no code) describing:
  1. recognition - how to tell an element IS this control
  2. keywords    - for each supported keyword, a recipe of fixed PRIMITIVES

This module is self-contained. It does NOT modify async_runner.py. The runner
calls into it at ONE place (a delegation hook) and falls back to its existing
behaviour whenever no custom control matches. If this file is absent or empty,
the runner behaves exactly as before.

Definition shape (stored as JSON, one per control):
{
  "id": "fancy_dropdown",
  "name": "Fancy Dropdown",
  "recognition": {
     "matches": ".fancy-select",      # element matches this CSS, OR
     "closest": ".fancy-container",    # element is inside an ancestor matching this, OR
     "role":    "combobox"            # element has this ARIA role
     # any combination; ALL provided conditions must hold
  },
  "keywords": {
     "click":     [ {"do":"click","target":"self"} ],
     "type":      [ {"do":"type","target":"self input","text":"{{value}}"} ],
     "select":    [ {"do":"click","target":"self"},
                    {"do":"wait","ms":300},
                    {"do":"click_option","within":".fancy-options","matching":"{{value}}"} ],
     "get_value": [ {"do":"read_text","target":".fancy-selected"} ]
  }
}

PRIMITIVES (the only allowed "do" values - safe, fixed vocabulary, NO raw code):
  click          {target}
  type           {target, text}
  clear          {target}
  wait           {ms}
  press          {target?, key}
  click_option   {within, matching}        # click option whose text matches value
  read_text      {target}                  # returns text (for get_value / asserts)
  wait_for       {target, ms?}             # wait until element appears

TARGET resolution:
  "self"            -> the matched control element (the step's selector)
  "self <sub>"      -> a descendant of the control matched by CSS "<sub>"
  any other string  -> a normal selector, resolved via the runner's get_locator
"""

import os
import re
import json

# These are injected by the runner when it calls into this module, so we reuse
# the SAME locator + variable + logging mechanics the rest of Qavya uses.
# (get_locator(page, selector), apply_variables(value, resolved), log(run_id, lvl, msg, idx))


PRIMITIVES = {"click", "type", "clear", "wait", "press", "click_option", "read_text", "wait_for"}


# -----------------------------------------------------------------------------
# Definition loading. Definitions are normally fetched from the Qavya backend and
# passed in. For standalone/local use we also allow a JSON file via the
# QAVYA_CONTROLS_FILE env var. Either way, this module just receives a LIST of
# definition dicts.
# -----------------------------------------------------------------------------
def load_definitions_from_file(path=None):
    """Optional helper: load definitions from a local JSON file (list of defs).
    Looks at QAVYA_CONTROLS_FILE, then a default qavya_controls.json next to this
    module, so no env var is required."""
    path = path or os.environ.get("QAVYA_CONTROLS_FILE", "")
    if not path:
        default_path = os.path.join(os.path.dirname(__file__), "qavya_controls.json")
        if os.path.exists(default_path):
            path = default_path
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data = data.get("controls", [])
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _valid_definition(d):
    """Reject anything malformed so a bad definition can never crash the runner."""
    if not isinstance(d, dict):
        return False
    if not isinstance(d.get("recognition"), dict):
        return False
    if not isinstance(d.get("keywords"), dict):
        return False
    # Every primitive used must be in the safe whitelist.
    for steps in d["keywords"].values():
        if not isinstance(steps, list):
            return False
        for st in steps:
            if not isinstance(st, dict) or st.get("do") not in PRIMITIVES:
                return False
    return True


# -----------------------------------------------------------------------------
# Recognition: does the element at `selector` match definition `d`?
# Runs entirely in the page via evaluate, so it understands the live DOM.
# -----------------------------------------------------------------------------
async def _find_frame_with(page, css_or_closest_or_role, max_polls=10):
    """Return the frame OR page whose document contains the element described by
    the recognition dict, or None. Searches every window/tab AND every frame
    inside each — many portals (e.g. eax-cgi) render content inside a frame, so
    the top document doesn't contain the element. Frames and Pages share the same
    evaluate/locator API, so the returned object is usable for reading too.

    max_polls controls how long to wait: recognition (is this control present?)
    passes a small number so unrelated steps aren't slowed; reading passes more
    because by then we know the control applies and may just be mid-render."""
    css = css_or_closest_or_role.get("matches")
    closest = css_or_closest_or_role.get("closest")
    role = css_or_closest_or_role.get("role")
    js = """([css, closest, role]) => {
        let el = null;
        if (css) el = document.querySelector(css);
        else if (closest) el = document.querySelector(closest);
        else if (role) el = document.querySelector('[role="' + role + '"]');
        if (!el) return false;
        if (css && !el.matches(css)) return false;
        if (closest && !el.closest(closest)) return false;
        if (role && el.getAttribute('role') !== role) return false;
        if (!css && !closest && !role) return false;
        return true;
    }"""
    def _contexts():
        # Every page, and every frame within every page.
        ctxs = []
        try:
            pages = list(page.context.pages)
        except Exception:
            pages = [page]
        if page not in pages:
            pages.insert(0, page)
        for p in pages:
            ctxs.append(p)
            try:
                for fr in p.frames:        # includes the main frame + all child frames
                    if fr not in ctxs:
                        ctxs.append(fr)
            except Exception:
                pass
        return ctxs
    for _ in range(max(1, max_polls)):  # poll while the page/frames settle
        for ctx in _contexts():
            try:
                if await ctx.evaluate(js, [css, closest, role]):
                    return ctx
            except Exception:
                continue
        if max_polls <= 1:
            break
        try:
            await page.wait_for_timeout(500)
        except Exception:
            break
    return None


# Backwards-compatible alias (older code referenced _find_page_with).
async def _find_page_with(page, css_or_closest_or_role):
    return await _find_frame_with(page, css_or_closest_or_role)


async def _matches(page, selector, d, get_locator):
    rec = d.get("recognition", {})
    # Fast recognition check: is this control present right now? Use a SHORT poll
    # (2 quick passes) so steps in scripts where the control does NOT apply are
    # not slowed down. If the control truly applies, reading polls longer.
    found = await _find_frame_with(page, rec, max_polls=2)
    return found is not None


def find_matching_definition_sync(definitions):
    """Filter to valid definitions only (recognition match is async, done separately)."""
    return [d for d in (definitions or []) if _valid_definition(d)]


# -----------------------------------------------------------------------------
# Target resolution.
# -----------------------------------------------------------------------------
def _resolve_target(page, control_selector, target, get_locator):
    target = (target or "self").strip()
    if target == "self" or target == "":
        return get_locator(page, control_selector)
    if target.startswith("self "):
        sub = target[5:].strip()
        # descendant of the control
        return get_locator(page, control_selector).locator(sub)
    return get_locator(page, target)


# -----------------------------------------------------------------------------
# Execute one keyword recipe. Returns a dict result (and possibly read text).
# `page`, `get_locator`, `apply_variables`, `log` are passed in from the runner.
# -----------------------------------------------------------------------------
async def run_keyword(page, definition, keyword, control_selector, value,
                      run_id, idx, get_locator, apply_variables, log,
                      resolved_vars=None, timeout=30000):
    resolved_vars = resolved_vars or {}
    kws = definition.get("keywords") or {}
    recipe = kws.get(keyword)
    # Keyword aliasing: the test editor emits action names like store_value /
    # store_text / assert_text, but a control may define the read behaviour under
    # get_value (or read). Treat these read-style actions as equivalent so a
    # control with a get_value recipe still triggers for store_value etc.
    if not recipe:
        READ_ALIASES = ("get_value", "read", "read_text", "store_value",
                        "store_text", "assert_text", "assert_value")
        if keyword in READ_ALIASES:
            for alt in READ_ALIASES:
                if kws.get(alt):
                    recipe = kws[alt]
                    break
    if not recipe:
        return {"handled": False}  # this control doesn't define this keyword

    log(run_id, "info", f"[custom:{definition.get('name', definition.get('id'))}] "
                        f"running '{keyword}' via {len(recipe)} primitive(s)", idx)

    read_result = None
    for st in recipe:
        do = st.get("do")

        # substitute {{value}} and any variables in text/matching fields
        def sub(x):
            if x is None:
                return x
            if isinstance(x, str):
                x = x.replace("{{value}}", str(value))
                return apply_variables(x, resolved_vars)
            return x

        if do == "click":
            loc = _resolve_target(page, control_selector, st.get("target", "self"), get_locator)
            await loc.click(timeout=timeout)

        elif do == "type":
            loc = _resolve_target(page, control_selector, st.get("target", "self"), get_locator)
            txt = sub(st.get("text", "{{value}}"))
            try:
                await loc.fill(txt, timeout=timeout)
            except Exception:
                await loc.click(timeout=timeout)
                await loc.press_sequentially(txt, delay=40)

        elif do == "clear":
            loc = _resolve_target(page, control_selector, st.get("target", "self"), get_locator)
            await loc.fill("", timeout=timeout)

        elif do == "wait":
            await page.wait_for_timeout(int(st.get("ms", 300)))

        elif do == "press":
            key = st.get("key", "Enter")
            tgt = st.get("target")
            if tgt:
                loc = _resolve_target(page, control_selector, tgt, get_locator)
                await loc.press(key, timeout=timeout)
            else:
                await page.keyboard.press(key)

        elif do == "wait_for":
            loc = _resolve_target(page, control_selector, st.get("target", "self"), get_locator)
            await loc.wait_for(state="visible", timeout=int(st.get("ms", timeout)))

        elif do == "click_option":
            within = sub(st.get("within", "")) or "body"
            matching = sub(st.get("matching", "{{value}}"))
            container = get_locator(page, within)
            # click the option whose visible text matches (exact first, then contains)
            opt = container.get_by_text(matching, exact=True)
            try:
                await opt.first.click(timeout=timeout)
            except Exception:
                opt = container.get_by_text(matching, exact=False)
                await opt.first.click(timeout=timeout)

        elif do == "read_text":
            target = (st.get("target", "self") or "self").strip()
            if target == "self" or target == "":
                css = control_selector
            elif target.startswith("self "):
                css = control_selector + " " + target[5:].strip()
            else:
                css = target
            # Find the page OR frame that actually contains the element (portals
            # often render content inside a frame). Read from THAT context.
            target_ctx = await _find_frame_with(page, {"matches": css}) or page
            try:
                read_result = await target_ctx.evaluate(
                    """(sel) => { const e = document.querySelector(sel);
                        return e ? (e.innerText || e.textContent || '').trim() : null; }""",
                    css)
            except Exception:
                read_result = None
            if read_result is None:
                # last resort: locator on the found context (frames support .locator)
                try:
                    read_result = (await target_ctx.locator(css).first.inner_text(timeout=timeout)).strip()
                except Exception:
                    read_result = None

        else:
            # Should never happen (validated), but never crash the run.
            log(run_id, "info", f"[custom] skipping unknown primitive '{do}'", idx)

    return {"handled": True, "read": read_result}
