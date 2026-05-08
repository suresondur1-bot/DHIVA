"""
Functional Automation Tool — Python Playwright Runner
Usage: python runner.py --run-id <id> --config <json>
"""
import sys
import io
import json
import time
import base64
import os
import argparse
import traceback
import re
import random
import string
import requests
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Pillow is optional
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# PostgreSQL driver
try:
    import psycopg2
    HAS_PG = True
except ImportError:
    HAS_PG = False

API_BASE = os.environ.get("API_BASE", "http://localhost:6001")
RUNNER_TOKEN = ""  # set at runtime from config
SCREENSHOTS_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

# Log file — written alongside runner.py in the runner/ folder
LOGS_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOGS_DIR, exist_ok=True)


# ─── DEBUG MODE ───────────────────────────────────────────────────────────────
DEBUG_MODE      = False       # set from --debug flag
DEBUG_SLOW_MO   = 500         # ms between steps in debug mode
DEBUG_BREAKPOINTS = set()     # set of step indices with breakpoints
_debug_command  = None        # "continue" | "step" | "skip" | "stop"
_debug_paused   = False

# debug step mode: pause after EVERY step, not just breakpoints
DEBUG_STEP_MODE = False   # True = step one at a time

def debug_broadcast(run_id, event_type, payload):
    """Send a debug event to the frontend via WebSocket broadcast."""
    try:
        requests.post(
            f"{API_BASE}/api/runs/{run_id}/debug-event",
            json={"type": event_type, **payload},
            timeout=5
        )
    except Exception as e:
        print(f"[debug] broadcast failed: {e}")

def debug_wait_for_command(run_id, step_idx, resolved_vars, reason="breakpoint"):
    """Block until user sends a debug command via API."""
    global _debug_command, _debug_paused
    _debug_paused = True
    _debug_command = None

    # Broadcast paused state with variable snapshot
    var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}
    try:
        requests.post(
            f"{API_BASE}/api/runs/{run_id}/debug-paused",
            json={"step_index": step_idx, "variables": var_snapshot, "reason": reason},
            timeout=5
        )
    except Exception as e:
        print(f"[debug] Failed to broadcast pause: {e}")

    # Poll for command
    print(f"[debug] Paused at step {step_idx+1} ({reason}) — waiting for user command...")
    deadline = time.time() + 300  # 5 min timeout
    while _debug_command is None and time.time() < deadline:
        time.sleep(0.25)
        try:
            resp = requests.get(
                f"{API_BASE}/api/runs/{run_id}/debug-command",
                timeout=3
            )
            if resp.ok:
                cmd = resp.json().get("command")
                if cmd:
                    _debug_command = cmd
                    print(f"[debug] Received command: {cmd}")
                    break
        except Exception:
            pass

    _debug_paused = False
    cmd = _debug_command or "stop"
    _debug_command = None
    return cmd  # "continue" | "step" | "skip" | "stop"

# ─── VARIABLE COUNTERS (for increment type) ──────────────────────────────────
_increment_counters = {}


def resolve_variables(variables):
    """Resolve variable definitions into a dict of name -> value."""
    import random
    import string
    resolved = {}
    for var in (variables or []):
        name   = var.get("name", "")
        vtype  = var.get("type", "fixed")
        config = var.get("config", {})
        if not name:
            continue
        try:
            cfg_str = config if isinstance(config, str) else str(config.get("value","") if isinstance(config, dict) else config)
            if vtype == "random_email":
                prefix = cfg_str.strip() if cfg_str.strip() else "user"
                rand   = "".join(random.choices(string.digits, k=8))
                resolved[name] = f"{prefix}_{rand}@test.com"
            elif vtype == "random_number":
                try:
                    parts = cfg_str.split("-")
                    lo, hi = int(parts[0].strip()), int(parts[1].strip())
                except:
                    lo, hi = 1000, 9999
                resolved[name] = str(random.randint(lo, hi))
            elif vtype == "timestamp":
                fmt = cfg_str.strip() if cfg_str.strip() else "%Y%m%d_%H%M%S"
                fmt = fmt.replace("YYYY","%Y").replace("MM","%m").replace("DD","%d")
                resolved[name] = datetime.now().strftime(fmt)
            elif vtype == "fixed":
                resolved[name] = cfg_str
            elif vtype == "dynamic":
                resolved[name] = resolve_dynamic_value(cfg_str)
            elif vtype == "data_table":
                resolved[name] = resolve_dynamic_value(cfg_str)
            elif vtype in ("from_list", "list"):
                # config is "val1, val2, val3" comma-separated string
                raw = cfg_str if cfg_str else (config.get("items","") if isinstance(config, dict) else "")
                if isinstance(raw, list):
                    items = [str(x).strip() for x in raw if str(x).strip()]
                else:
                    items = [x.strip() for x in str(raw).split(",") if x.strip()]
                resolved[name] = random.choice(items) if items else ""
            elif vtype == "random_text":
                try:
                    length = int(cfg_str.strip()) if cfg_str.strip() else 8
                except:
                    length = 8
                resolved[name] = "".join(random.choices(string.ascii_letters, k=length))
            elif vtype == "increment":
                try:
                    start = int(cfg_str.strip())
                except:
                    start = 1
                if name not in _increment_counters:
                    _increment_counters[name] = start
                else:
                    _increment_counters[name] += 1
                resolved[name] = str(_increment_counters[name])
            elif vtype == "uuid":
                import uuid as _uuid2
                resolved[name] = str(_uuid2.uuid4())
            else:
                resolved[name] = cfg_str
        except Exception as e:
            resolved[name] = ""
    return resolved


def apply_variables(value, resolved):
    """Replace {{var_name}} placeholders with resolved values."""
    if not isinstance(value, str):
        return value
    for name, val in resolved.items():
        value = value.replace("{{" + name + "}}", val)
    return value



def log(run_id, level, message, step_index=None):
    """Send log entry to backend via API and write to log file."""
    ts = datetime.utcnow().isoformat()
    payload = {
        "level":      level,
        "message":    message,
        "step_index": step_index,
        "timestamp":  ts
    }
    # Always print to console
    print(f"[{level.upper()}] {message}")

    # Always write to log file: runner/logs/run_<id>.log
    try:
        log_file = os.path.join(LOGS_DIR, f"run_{run_id}.log")
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"[{ts[11:19]}] [{level.upper()}] {message}\n")
    except Exception as e:
        print(f"[warn] Could not write to log file: {e}")

    # Send to backend API
    try:
        requests.post(f"{API_BASE}/api/runs/{run_id}/log", json=payload, timeout=5)
    except Exception as e:
        print(f"[warn] Could not send log to backend: {e}")


def take_screenshot(page, run_id, label):
    """Take screenshot and send to backend."""
    try:
        filename = f"{run_id}_{label}_{int(time.time())}.png"
        filepath = os.path.join(SCREENSHOTS_DIR, filename)
        page.screenshot(path=filepath, full_page=True)
        # Send as base64 to backend
        with open(filepath, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        requests.post(f"{API_BASE}/api/runs/{run_id}/screenshot", json={
            "label":    label,
            "filename": filename,
            "data":     b64,
            "timestamp": datetime.utcnow().isoformat()
        }, timeout=10)
    except Exception as e:
        print(f"[warn] Screenshot failed: {e}")

def take_live_screenshot(page, run_id, step_label):
    """Take a live preview screenshot and broadcast via WebSocket."""
    try:
        b64 = base64.b64encode(
            page.screenshot(full_page=False, type="jpeg", quality=65)
        ).decode()
        requests.post(f"{API_BASE}/api/runs/{run_id}/live-screen", json={
            "data":      b64,
            "label":     step_label,
            "timestamp": datetime.utcnow().isoformat()
        }, timeout=5)
    except Exception:
        pass  # Non-critical


# ── Continuous screen capture thread ──────────────────────────────────────────
import threading



def start_screen_capture(page, run_id, interval=1.5):
    """Disabled: background thread causes greenlet conflicts.
    Screenshots taken per-step in main thread instead."""
    pass  # no-op

def stop_screen_capture():
    pass  # no-op

def get_locator(page, selector):
    """Smart locator — handles camelCase (inspector) and snake_case formats."""
    import re as _re
    if not selector:
        return page.locator("body")
    sel = selector.strip()

    # ── Normalise camelCase → snake_case (inspector returns camelCase) ────
    sel = _re.sub(r"\bgetByRole\b",        "get_by_role",        sel)
    sel = _re.sub(r"\bgetByText\b",        "get_by_text",        sel)
    sel = _re.sub(r"\bgetByLabel\b",       "get_by_label",       sel)
    sel = _re.sub(r"\bgetByPlaceholder\b", "get_by_placeholder", sel)
    sel = _re.sub(r"\bgetByTitle\b",       "get_by_title",       sel)
    sel = _re.sub(r"\bgetByAltText\b",     "get_by_alt_text",    sel)
    sel = _re.sub(r"\bgetByTestId\b",      "get_by_test_id",     sel)

    # ── get_by_role("role", name="label") ────────────────────────────────
    m = _re.match(r'get_by_role\(["\'](\w+)["\'"],\s*name=["\'](.*?)["\'"],\s*exact=True\)', sel)
    if m: return page.get_by_role(m.group(1), name=m.group(2), exact=True)
    m = _re.match(r'get_by_role\(["\'](\w+)["\'"],\s*name=["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_role(m.group(1), name=m.group(2))
    m = _re.match(r'get_by_role\(["\'](\w+)["\'"]\)', sel)
    if m: return page.get_by_role(m.group(1))

    # ── get_by_text("...") ────────────────────────────────────────────────
    m = _re.match(r'get_by_text\(["\'](.*?)["\'"],\s*exact=True\)', sel)
    if m: return page.get_by_text(m.group(1), exact=True)
    m = _re.match(r'get_by_text\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_text(m.group(1), exact=False)

    # ── get_by_label("...") ───────────────────────────────────────────────
    m = _re.match(r'get_by_label\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_label(m.group(1))

    # ── get_by_placeholder("...") ─────────────────────────────────────────
    m = _re.match(r'get_by_placeholder\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_placeholder(m.group(1))

    # ── get_by_title("...") ───────────────────────────────────────────────
    m = _re.match(r'get_by_title\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_title(m.group(1))

    # ── get_by_alt_text("...") ────────────────────────────────────────────
    m = _re.match(r'get_by_alt_text\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_alt_text(m.group(1))

    # ── Pseudo selectors ──────────────────────────────────────────────────
    m = _re.match(r':text-is\(["\'](.*?)["\'"]\)$', sel)
    if m: return page.get_by_text(m.group(1), exact=True)

    m = _re.match(r':text\(["\'](.*?)["\'"]\)$', sel)
    if m: return page.get_by_text(m.group(1), exact=False)

    if ":has-text(" in sel:
        ht = _re.search(r':has-text\(["\'](.*?)["\'"]\)', sel)
        if ht:
            tag_sel = sel[:ht.start()].strip() or "*"
            return page.locator(tag_sel).filter(has_text=ht.group(1))

    # ── >> nth=N ──────────────────────────────────────────────────────────
    nth = _re.search(r">>\s*nth=(\d+)", sel)
    if nth:
        return page.locator(sel[:nth.start()].strip()).nth(int(nth.group(1)))

    # ── .nth(N) suffix ────────────────────────────────────────────────────
    nth = _re.match(r'(.+)\.nth\((\d+)\)$', sel)
    if nth:
        return page.locator(nth.group(1)).nth(int(nth.group(2)))

    # ── XPath ─────────────────────────────────────────────────────────────
    if sel.startswith("//") or sel.startswith("(//"):
        return page.locator(sel)

    # ── Default: CSS selector ─────────────────────────────────────────────
    return page.locator(sel)

# ─── AI AUTO-HEAL ─────────────────────────────────────────────────────────────
def ai_heal_step(page, step, run_id, idx, original_error, resolved_vars=None):
    """
    When a step fails, take a screenshot and ask Claude to find
    the element with a new selector. Tries each suggestion in order.
    Returns the new selector string if healed, None if not.
    """
    resolved_vars = resolved_vars or {}
    action   = step.get("action", "")
    selector = apply_variables(step.get("selector", ""), resolved_vars)
    value    = apply_variables(step.get("value", ""),    resolved_vars)

    # Only heal steps that use a selector
    if not selector or action in ("navigate", "wait", "wait_for_url",
                                   "assert_url", "assert_title", "screenshot",
                                   "execute_script", "press", "db_validate"):
        return None

    log(run_id, "info", f"  [AI Heal] Step {idx+1} failed — asking AI to find element...", idx)

    try:
        # Take screenshot of current state
        img_bytes = page.screenshot(type="jpeg", quality=75)
        screenshot_b64 = base64.b64encode(img_bytes).decode("utf-8")
    except Exception as e:
        log(run_id, "info", f"  [AI Heal] Could not capture screenshot: {e}", idx)
        return None

    # Call the AI heal endpoint
    try:
        resp = requests.post(
            f"{API_BASE}/api/ai/heal",
            json={
                "screenshot_base64": screenshot_b64,
                "selector":          selector,
                "action":            action,
                "step_description":  f"{action} on [{selector}]",
                "run_id":            run_id,
            },
            timeout=60
        )
        data = resp.json()
    except Exception as e:
        log(run_id, "info", f"  [AI Heal] AI request failed: {e}", idx)
        return None

    suggestions = data.get("suggestions", [])
    if not suggestions:
        log(run_id, "info", f"  [AI Heal] AI returned no suggestions", idx)
        return None

    log(run_id, "info", f"  [AI Heal] AI suggested {len(suggestions)} selector(s) — trying each...", idx)

    # Try each suggestion
    for i, sug in enumerate(suggestions):
        new_sel   = sug.get("selector", "")
        confidence= sug.get("confidence", "")
        reason    = sug.get("reason", "")
        if not new_sel:
            continue

        log(run_id, "info", f"  [AI Heal] Trying [{i+1}] {new_sel} ({confidence}) — {reason}", idx)
        try:
            loc = get_locator(page, new_sel)
            loc.wait_for(state="visible", timeout=5000)
            # It worked — execute the action with the new selector
            if action == "click":
                loc.click(timeout=10000)
            elif action == "type":
                loc.fill(value, timeout=10000)
            elif action == "clear":
                loc.clear(timeout=10000)
            elif action == "hover":
                loc.hover(timeout=10000)
            elif action in ("assert_text",):
                assert loc.inner_text() and value in loc.inner_text()
            elif action == "assert_visible":
                assert loc.is_visible()
            elif action == "assert_value":
                assert loc.input_value() == value
            elif action == "select":
                loc.select_option(value, timeout=10000)
            elif action == "search_select":
                # Type in search field, wait for dropdown, click matching option
                search_text  = apply_variables(step.get("search_text", ""), resolved_vars)
                option_match = apply_variables(value, resolved_vars)
                wait_ms      = int(step.get("wait_ms", 1500))  # configurable wait after typing

                # Step 1: Click/focus the input
                loc.click(timeout=10000)
                page.wait_for_timeout(200)

                # Step 2: Clear existing value first
                loc.clear()
                page.wait_for_timeout(100)

                # Step 3: Type using keyboard.type (more stable, fires proper events)
                loc.focus()
                page.wait_for_timeout(100)
                page.keyboard.type(search_text)

                # Fallback: also try fill() in case press() didn't work
                current_val = ""
                try: current_val = loc.input_value(timeout=1000)
                except: pass
                if current_val.strip() != search_text.strip():
                    loc.fill(search_text, timeout=5000)
                    # Trigger Angular/React input events using selector-based evaluate
                    # (avoid element_handle() which causes greenlet conflicts)
                    try:
                        sel_str = selector.strip()
                        # Build a safe JS selector string
                        page.evaluate(f"""
                            (() => {{
                                const el = document.querySelector({repr(sel_str)});
                                if (el) {{
                                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                                    el.dispatchEvent(new KeyboardEvent('keyup', {{ key: ' ', bubbles: true }}));
                                }}
                            }})()
                        """)
                    except Exception:
                        pass  # non-critical — char-by-char typing already fired events

                # Step 4: Wait for dropdown to populate (configurable)
                page.wait_for_timeout(wait_ms)

                # Step 5: Try to find the matching option
                # Priority: specific dropdown patterns first, generic last
                option_selectors = [
                    f"[role='option']:has-text('{option_match}')",
                    f"[role='listbox'] li:has-text('{option_match}')",
                    f"[role='listbox'] [role='option']:has-text('{option_match}')",
                    f".dropdown-item:has-text('{option_match}')",
                    f".dropdown-menu li:has-text('{option_match}')",
                    f".ng-option:has-text('{option_match}')",
                    f".select2-option:has-text('{option_match}')",
                    f"[class*='option']:has-text('{option_match}')",
                    f"[class*='suggestion']:has-text('{option_match}')",
                    f"[class*='result']:has-text('{option_match}')",
                    f"[class*='item']:has-text('{option_match}')",
                    f"ul li:has-text('{option_match}')",
                    f"li:has-text('{option_match}')",
                ]

                found = False
                # Try each selector — prefer exact text match over partial
                for opt_sel in option_selectors:
                    try:
                        locs = page.locator(opt_sel)
                        count = locs.count()
                        if count == 0:
                            continue
                        # Try exact match first
                        for idx in range(count):
                            item = locs.nth(idx)
                            try:
                                if not item.is_visible(timeout=500):
                                    continue
                                item_text = (item.inner_text(timeout=500) or "").strip()
                                # Prefer exact match, then partial
                                if item_text == option_match or option_match in item_text:
                                    item.click(timeout=5000)
                                    found = True
                                    log(run_id, "info", f"[search_select] Clicked: '{item_text}' using {opt_sel}")
                                    break
                            except Exception:
                                continue
                        if found:
                            break
                    except Exception:
                        continue

                # If still not found — try waiting a bit longer and retry once
                if not found:
                    page.wait_for_timeout(1500)
                    for opt_sel in option_selectors[:6]:  # try top selectors again
                        try:
                            locs = page.locator(opt_sel)
                            if locs.count() > 0:
                                for idx in range(locs.count()):
                                    item = locs.nth(idx)
                                    try:
                                        if item.is_visible(timeout=500) and option_match in (item.inner_text(timeout=500) or ""):
                                            item.click(timeout=5000)
                                            found = True
                                            break
                                    except Exception:
                                        continue
                            if found:
                                break
                        except Exception:
                            continue

                if not found:

                    # Strategy 5: Exact text match on any visible small element
                    if not matched_locator:
                        try:
                            import re as _re_s5
                            all_cands = page.locator('li, tr, td, div, span, button, a')
                            count = all_cands.count()
                            for ci in range(min(count, 20)):
                                c = all_cands.nth(ci)
                                try:
                                    if not c.is_visible(timeout=300): continue
                                    txt = (c.inner_text(timeout=300) or '').strip()
                                    if option_text.lower() in txt.lower() and len(txt) < len(option_text) * 4:
                                        matched_locator = c
                                        log(run_id, 'info', f'[search_select] Strategy5 found: {txt!r}')
                                        break
                                except Exception:
                                    continue
                        except Exception:
                            pass

                    # Diagnostic: show what IS visible on page near the input
                    try:
                        visible_opts = []
                        for sel in ["[role='option']", "li", ".dropdown-item", "[class*='option']"]:
                            try:
                                items = page.locator(sel).all()
                                for it in items[:5]:
                                    if it.is_visible(timeout=200):
                                        t = (it.inner_text(timeout=200) or "").strip()
                                        if t: visible_opts.append(t[:40])
                            except: pass
                        hint = f" Visible options: [{', '.join(visible_opts[:8])}]" if visible_opts else ""
                        raise Exception(f"Could not find dropdown option containing '{option_match}' after typing '{search_text}'.{hint}")
                    except Exception as diag_e:
                        raise diag_e
            elif action == "check":
                loc.check(timeout=10000)
            elif action == "uncheck":
                loc.uncheck(timeout=10000)
            elif action == "wait_for_selector":
                loc.wait_for(state="visible", timeout=30000)
            else:
                # For any other action, just verify visibility
                assert loc.is_visible(), "Element not visible"

            log(run_id, "pass",
                f"  [AI Heal] SUCCESS — healed with: {new_sel}", idx)
            return new_sel

        except Exception as e:
            log(run_id, "info",
                f"  [AI Heal] [{i+1}] failed: {str(e)[:80]}", idx)
            continue

    log(run_id, "info", f"  [AI Heal] All suggestions failed — step cannot be auto-healed", idx)
    return None

def run_step(page, step, run_id, idx, resolved_vars=None):
    """Acquires _page_lock to prevent greenlet conflict with screenshot thread."""
    return _run_step_impl(page, step, run_id, idx, resolved_vars)

def _run_step_impl(page, step, run_id, idx, resolved_vars=None):
    """Inner step implementation - called with _page_lock held."""
    """Execute a single test step."""
    action  = step.get("action", "")
    value   = apply_variables(step.get("value",    ""), resolved_vars)
    selector= apply_variables(step.get("selector", ""), resolved_vars)
    timeout = step.get("timeout", 30000)

    step_desc = {
        "navigate":           f"Navigating browser to URL: {value}",
        "click":              f"Clicking on element: [ {selector} ]",
        "type":               f"Typing text '{value}' into field: [ {selector} ]",
        "clear":              f"Clearing input field: [ {selector} ]",
        "select":             f"Selecting option '{value}' from dropdown: [ {selector} ]",
        "search_select":      "Search & Select: type '{}' -> pick '{}' in [ {} ]".format(step.get("search_text", value), value, selector),
        "check":              f"Checking checkbox: [ {selector} ]",
        "uncheck":            f"Unchecking checkbox: [ {selector} ]",
        "hover":              f"Hovering mouse over element: [ {selector} ]",
        "press":              f"Pressing key '{value}' on element: [ {selector} ]",
        "wait":               f"Waiting for {value} milliseconds...",
        "wait_for_selector":  f"Waiting for element to appear: [ {selector} ]",
        "wait_for_url":       f"Waiting for URL to contain: '{value}'",
        "assert_text":        f"Asserting element [ {selector} ] contains text: '{value}'",
        "assert_visible":     f"Asserting element is visible on page: [ {selector} ]",
        "assert_url":         f"Asserting current URL contains: '{value}'",
        "assert_title":       f"Asserting page title contains: '{value}'",
        "assert_value":       f"Asserting input [ {selector} ] has value: '{value}'",
        "screenshot":         f"Taking screenshot — label: '{value or 'screenshot'}'",
        "scroll":             f"Scrolling page to Y position: {value}",
        "execute_script":     f"Executing JavaScript on the page",
        "db_validate":        f"Running DB validation query",
    }.get(action, f"{action} — {selector or value}")
    log(run_id, "info", f">> Step {idx+1}: {step_desc}", idx)
    # Live screen preview before each step
    if page:
        take_live_screenshot(page, run_id, f"Step {idx+1}: {action}")

    try:
        if action == "navigate":
            nav_timeout = max(timeout, 30000)
            try:
                page.goto(value, timeout=nav_timeout, wait_until="domcontentloaded")
            except PWTimeout:
                # Retry with load event — some pages never fire domcontentloaded
                page.goto(value, timeout=nav_timeout, wait_until="load")

        elif action == "click":
            get_locator(page, selector).click(timeout=timeout)

        elif action == "type":
            get_locator(page, selector).fill(value, timeout=timeout)

        elif action == "clear":
            get_locator(page, selector).fill("", timeout=timeout)

        elif action == "select":
            get_locator(page, selector).select_option(value, timeout=timeout)
            
        elif action == "search_select":
                import re as _re_ss
                search_text = apply_variables(step.get("search_text", value), resolved_vars).strip()
                option_text = apply_variables(value, resolved_vars).strip()
                loc         = get_locator(page, selector)
                wait_ms     = int(step.get("wait_ms", 2000))

                log(run_id, "info", f"[search_select] typing={search_text!r} picking={option_text!r}", idx)

                # ── Step 1: Detect if this is ng-select or native input ──────────
                is_ng_select = False
                try:
                    is_ng_select = page.evaluate(
                        f"""() => {{
                            const el = document.querySelector({repr(selector)});
                            if (!el) return false;
                            const tag = el.tagName.toLowerCase();
                            return tag === 'ng-select' || el.classList.contains('ng-select') ||
                                   el.closest('ng-select') !== null;
                        }}"""
                    ) or False
                except Exception:
                    pass

                # ── Step 2: Open and type ────────────────────────────────────────
                if is_ng_select:
                    # ng-select: click container to open, then type in its inner input
                    loc.click(timeout=timeout)
                    page.wait_for_timeout(400)
                    # Find the inner search input that appears after ng-select opens
                    typed = False
                    for ng_inp_sel in [
                        "ng-dropdown-panel ~ .ng-input input",
                        ".ng-input > input",
                        "ng-select .ng-input input",
                        "ng-select input[type=text]",
                        ".ng-value-container input",
                    ]:
                        try:
                            ng_inp = page.locator(ng_inp_sel).first
                            if ng_inp.is_visible(timeout=500):
                                ng_inp.fill("")
                                ng_inp.press_sequentially(search_text)
                                typed = True
                                log(run_id, "info", f"[search_select] typed into ng-select via {ng_inp_sel}")
                                break
                        except Exception:
                            continue
                    if not typed:
                        # Fallback: type via keyboard (focus should be on ng-select input)
                        page.keyboard.press_sequentially(search_text) if hasattr(page.keyboard, "press_sequentially") else page.keyboard.type(search_text)
                    page.wait_for_timeout(300)  # let filter apply
                else:
                    # Regular input (ngb-typeahead / autocomplete)
                    # Must use pressSequentially to trigger Angular change detection
                    loc.click(timeout=timeout)
                    page.wait_for_timeout(200)
                    # Clear existing value
                    try:
                        loc.select_all()
                    except Exception:
                        loc.focus()
                        page.keyboard.press("Control+a")
                    page.keyboard.press("Delete")
                    page.wait_for_timeout(100)
                    # Type character by character using press_sequentially
                    # This fires proper keydown/keypress/keyup/input events
                    # that Angular's (ngModelChange) / (keyup) handlers need
                    try:
                        loc.press_sequentially(search_text)  # no delay = synchronous
                    except Exception:
                        # Fallback for older Playwright versions
                        for ch in search_text:
                            loc.press(ch)

                # ── Step 3: Poll until dropdown options appear ───────────────────
                # networkidle is unreliable for ng-select which renders AFTER API returns
                # Poll every 300ms up to 5s until we see actual options
                _dropdown_ready = False
                for _attempt in range(17):  # 17 x 300ms = ~5 seconds
                    try:
                        _n = page.locator("ng-dropdown-panel .ng-option").count()
                        if _n > 0:
                            _dropdown_ready = True
                            log(run_id, "info", f"[search_select] dropdown ready with {_n} options (attempt {_attempt+1})")
                            break
                        _n2 = page.locator("ngb-typeahead-window").count()
                        if _n2 > 0:
                            _dropdown_ready = True
                            break
                        _n3 = page.locator("[role=option]:visible").count()
                        if _n3 > 0:
                            _dropdown_ready = True
                            break
                    except Exception:
                        pass
                    page.wait_for_timeout(300)
                if not _dropdown_ready:
                    log(run_id, "info", "[search_select] dropdown not appeared after 5s — continuing anyway")
                    page.wait_for_timeout(500)

                # ── Step 4: Find the matching option ────────────────────────────
                matched = None

                # Priority 1: ng-select .ng-option (most common in ATHMA)
                # Use Playwright filter (has_text) instead of scanning one by one — much faster
                if not matched:
                    try:
                        import re as _re_ng
                        opts = page.locator("ng-dropdown-panel .ng-option")
                        n = opts.count()
                        log(run_id, "info", f"[search_select] ng-dropdown-panel has {n} options")
                        if n > 0:
                            # Fast path: use has_text filter
                            filtered = opts.filter(has_text=_re_ng.compile(
                                _re_ng.escape(option_text), _re_ng.I
                            ))
                            if filtered.count() > 0:
                                matched = filtered.first
                                log(run_id, "info", f"[search_select] matched via filter: {option_text!r}")
                            else:
                                # Slow path: scan all (needed when option text has extra chars like newlines)
                                for j in range(min(n, 10)):  # cap at 10 to avoid long loops
                                    o = opts.nth(j)
                                    try:
                                        txt = (o.inner_text(timeout=500) or "").strip()
                                        if option_text.lower() in txt.lower():
                                            matched = o
                                            log(run_id, "info", f"[search_select] matched scan: {txt[:50]!r}")
                                            break
                                    except Exception:
                                        continue
                                if not matched and n > 10:
                                    log(run_id, "info", f"[search_select] checking remaining {n-10} options")
                                    for j in range(10, n):
                                        o = opts.nth(j)
                                        try:
                                            txt = (o.inner_text(timeout=500) or "").strip()
                                            if option_text.lower() in txt.lower():
                                                matched = o
                                                break
                                        except Exception:
                                            continue
                    except Exception as e:
                        log(run_id, "info", f"[search_select] ng-option scan failed: {e}")

                # Priority 2: ngb-typeahead (table-row based)
                if not matched:
                    for sel2 in ["ngb-typeahead-window button",
                                 "ngb-typeahead-window td",
                                 "ngb-typeahead-window tr",
                                 "ngb-typeahead-window .dropdown-item"]:
                        try:
                            c = page.locator(sel2).filter(
                                has_text=_re_ss.compile(option_text, _re_ss.I)
                            ).first
                            if c.is_visible(timeout=500):
                                if sel2.endswith("td"):
                                    c = page.locator("ngb-typeahead-window tr").filter(
                                        has_text=_re_ss.compile(option_text, _re_ss.I)
                                    ).first
                                matched = c
                                break
                        except Exception:
                            continue

                # Priority 3: ARIA role=option
                if not matched:
                    try:
                        c = page.get_by_role("option", name=option_text, exact=False).first
                        if c.is_visible(timeout=500):
                            matched = c
                    except Exception:
                        pass

                # Priority 4: Any visible dropdown item containing the text
                if not matched:
                    for sel2 in [
                        ".ng-option", ".dropdown-item", ".dropdown-menu li",
                        "[role=option]", "[class*=option]", "ul li"
                    ]:
                        try:
                            c = page.locator(sel2).filter(
                                has_text=_re_ss.compile(option_text, _re_ss.I)
                            ).first
                            if c.is_visible(timeout=500):
                                matched = c
                                break
                        except Exception:
                            continue

                # Priority 5: get_by_text fallback
                if not matched:
                    try:
                        c = page.get_by_text(option_text, exact=False).first
                        if c.is_visible(timeout=500):
                            matched = c
                    except Exception:
                        pass

                if not matched:
                    # Diagnostic
                    try:
                        diag = page.evaluate("""
                            () => {
                                const parts = [];
                                ['ng-dropdown-panel','ngb-typeahead-window',
                                 '[role=listbox]','.dropdown-menu'].forEach(s => {
                                    const el = document.querySelector(s);
                                    if (el) parts.push(s + ': ' + el.innerText.replace(/\n/g,'|').slice(0,150));
                                });
                                return parts.join(' /// ') || 'no dropdown found';
                            }
                        """)
                    except Exception:
                        diag = "could not read page"
                    raise Exception(
                        "Search & Select: option '{}' not found after typing '{}'. Diagnostic: [{}]".format(
                            option_text, search_text, diag)
                    )

                matched.scroll_into_view_if_needed()
                page.wait_for_timeout(100)
                matched.click(force=True, timeout=timeout)
                page.wait_for_timeout(300)
                log(run_id, "pass", f"[OK] Search & Select: selected '{option_text}'", idx)


        elif action == "double_click":
            get_locator(page, selector).dblclick(timeout=timeout)

        elif action == "right_click":
            get_locator(page, selector).click(button="right", timeout=timeout)

        elif action == "upload_attachment":
            # value = file path(s), comma-separated for multiple
            files = [v.strip() for v in value.split(",")]
            get_locator(page, selector).set_input_files(files if len(files)>1 else files[0], timeout=timeout)

        elif action == "download":
            # Click a download link and wait for download
            with page.expect_download() as dl_info:
                get_locator(page, selector).click(timeout=timeout)
            download = dl_info.value
            download_path = download.path()
            log(run_id, "info", f"  Downloaded: {download.suggested_filename} → {download_path}", idx)

        elif action == "assert_attribute":
            # value format: "attr_name=expected_value"
            parts = value.split("=", 1)
            attr_name = parts[0].strip()
            expected  = parts[1].strip() if len(parts) > 1 else ""
            actual = get_locator(page, selector).get_attribute(attr_name, timeout=timeout)
            assert expected in (actual or ""), f"Attribute '{attr_name}' expected to contain '{expected}', got '{actual}'"

        elif action == "assert_css":
            # value format: "css_property=expected_value"
            parts = value.split("=", 1)
            prop     = parts[0].strip()
            expected = parts[1].strip() if len(parts) > 1 else ""
            actual = get_locator(page, selector).evaluate(f"el => window.getComputedStyle(el).getPropertyValue('{prop}')")
            assert expected in str(actual), f"CSS '{prop}' expected '{expected}', got '{actual}'"

        elif action == "assert_enabled":
            loc = get_locator(page, selector)
            loc.wait_for(state="visible", timeout=timeout)
            assert loc.is_enabled(), f"Element [{selector}] expected to be enabled but is disabled"

        elif action == "assert_disabled":
            loc = get_locator(page, selector)
            loc.wait_for(state="visible", timeout=timeout)
            assert not loc.is_enabled(), f"Element [{selector}] expected to be disabled but is enabled"

        elif action == "assert_checked":
            loc = get_locator(page, selector)
            loc.wait_for(state="visible", timeout=timeout)
            assert loc.is_checked(), f"Checkbox [{selector}] expected to be checked but is unchecked"

        elif action == "assert_not_checked":
            loc = get_locator(page, selector)
            loc.wait_for(state="visible", timeout=timeout)
            assert not loc.is_checked(), f"Checkbox [{selector}] expected to be unchecked but is checked"

        elif action == "assert_selected":
            # Asserts a <select> has the given option selected
            actual = get_locator(page, selector).input_value(timeout=timeout)
            assert value in actual, f"Select [{selector}] expected '{value}' to be selected, got '{actual}'"

        elif action == "drag_and_drop":
            # selector = source element, value = target selector
            source = get_locator(page, selector)
            target = get_locator(page, value)
            source.drag_to(target, timeout=timeout)

        elif action == "focus":
            get_locator(page, selector).focus(timeout=timeout)

        elif action == "blur":
            get_locator(page, selector).blur(timeout=timeout)

        elif action == "switch_frame":
            # selector = frame name, id, or url substring
            # value = optional (ignored)
            try:
                frame = page.frame(name=selector)
                if not frame:
                    frame = page.frame(url=lambda u: selector in u)
                if not frame:
                    frame = page.frame_locator(selector).first
                log(run_id, "info", f"  Switched to frame: {selector}", idx)
            except Exception as e:
                raise Exception(f"Could not switch to frame '{selector}': {e}")

        elif action == "switch_window":
            # Switch to window by index (value) or title (selector)
            pages = page.context.pages
            if value and value.isdigit():
                idx_win = int(value)
                if idx_win < len(pages):
                    pages[idx_win].bring_to_front()
                    log(run_id, "info", f"  Switched to window index {idx_win}", idx)
            else:
                for p in pages:
                    if selector and selector.lower() in p.title().lower():
                        p.bring_to_front()
                        log(run_id, "info", f"  Switched to window: {p.title()}", idx)
                        break

        elif action == "close_window":
            # Close current page or by index (value)
            pages = page.context.pages
            if value and value.isdigit():
                idx_win = int(value)
                if idx_win < len(pages):
                    pages[idx_win].close()
            else:
                page.close()
            log(run_id, "info", f"  Closed window", idx)

        elif action == "refresh":
            page.reload(timeout=timeout)

        elif action == "back":
            page.go_back(timeout=timeout)

        elif action == "forward":
            page.go_forward(timeout=timeout)

        elif action == "set_cookie":
            # value format: "name=value" or "name=value; domain=x; path=/"
            parts = {p.split("=",1)[0].strip(): p.split("=",1)[1].strip()
                     for p in value.split(";") if "=" in p}
            name = list(parts.keys())[0]
            val  = parts[name]
            cookie = {"name": name, "value": val,
                      "domain": parts.get("domain", page.url.split("/")[2]),
                      "path":   parts.get("path", "/")}
            page.context.add_cookies([cookie])
            log(run_id, "info", f"  Set cookie: {name}={val}", idx)

        elif action == "clear_cookie":
            # value = cookie name to clear, or empty = clear all
            if value:
                cookies = page.context.cookies()
                remaining = [c for c in cookies if c["name"] != value]
                page.context.clear_cookies()
                if remaining:
                    page.context.add_cookies(remaining)
                log(run_id, "info", f"  Cleared cookie: {value}", idx)
            else:
                page.context.clear_cookies()
                log(run_id, "info", "  Cleared all cookies", idx)

        elif action == "assert_cookie":
            # value format: "name=expected_value" or just "name" to check existence
            parts = value.split("=", 1)
            name  = parts[0].strip()
            expected = parts[1].strip() if len(parts) > 1 else None
            cookies = {c["name"]: c["value"] for c in page.context.cookies()}
            assert name in cookies, f"Cookie '{name}' not found"
            if expected:
                assert expected in cookies[name], f"Cookie '{name}' expected '{expected}', got '{cookies[name]}'"

        elif action == "check":
            get_locator(page, selector).check(timeout=timeout)

        elif action == "uncheck":
            get_locator(page, selector).uncheck(timeout=timeout)

        elif action == "hover":
            get_locator(page, selector).hover(timeout=timeout)

        elif action == "press":
            # If selector is body/empty — use page.keyboard.press() (global keypress)
            # This handles shortcuts like "." that open popups
            if not selector or selector.strip().lower() in ("body", "html", "document"):
                page.keyboard.press(value)
            else:
                get_locator(page, selector).press(value, timeout=timeout)

        elif action == "wait":
            time.sleep(float(value) / 1000)

        elif action == "wait_for_selector":
            # For getByRole/getByText selectors, use locator.wait_for instead
            _loc = get_locator(page, selector)
            _loc.wait_for(state="visible", timeout=timeout)

        elif action == "wait_for_url":
            page.wait_for_url(value, timeout=timeout)

        elif action == "assert_text":
            el = get_locator(page, selector)
            actual = el.inner_text(timeout=timeout)
            assert value in actual, f"Expected '{value}' in '{actual}'"

        elif action == "assert_visible":
            el = get_locator(page, selector)
            assert el.is_visible(timeout=timeout), f"Element '{selector}' is not visible"

        elif action == "assert_url":
            current = page.url
            assert value in current, f"Expected URL to contain '{value}', got '{current}'"

        elif action == "assert_title":
            title = page.title()
            assert value in title, f"Expected title to contain '{value}', got '{title}'"

       # elif action == "assert_value":
       #     actual = page.input_value(selector, timeout=timeout)
       #     assert value == actual, f"Expected value '{value}', got '{actual}'"
       
       
        elif action == "assert_url":
            # Wait until URL contains expected value
            try:
                page.wait_for_url(f"**{value}**", timeout=timeout)
            except PWTimeout:
                current = page.url
                raise AssertionError(
                    f"Expected URL to contain '{value}', but timed out. Current URL: '{current}'"
                )
 
        elif action == "assert_element_count":
            count = get_locator(page, selector).count()
            assert int(value) == count, f"Expected {value} elements, found {count}"

        elif action == "screenshot":
            take_screenshot(page, run_id, value or f"step_{idx+1}")

        elif action == "scroll":
            page.evaluate(f"window.scrollTo(0, {value or 0})")

        elif action == "execute_script":
            page.evaluate(value)

        elif action == "db_validate":
            db_result = run_db_validate(step, run_id, idx, resolved_vars)
            if db_result["status"] == "failed":
                return db_result
            # Merge any stored variables back
            if resolved_vars is not None and "stored_var" in db_result:
                resolved_vars.update(db_result["stored_var"])

        else:
            raise ValueError(f"Unknown action: {action}")

        pass_desc = {
            "navigate":           f"PASSED — Browser successfully navigated to: {value}",
            "click":              f"PASSED — Successfully clicked on element: [ {selector} ]",
            "type":               f"PASSED — Successfully inserted text '{value}' into field: [ {selector} ]",
            "clear":              f"PASSED — Successfully cleared input field: [ {selector} ]",
            "select":             f"PASSED — Successfully selected '{value}' from dropdown: [ {selector} ]",
            "search_select":      f"PASSED — Search & selected '{value}' after typing '{step.get('search_text','')}': [ {selector} ]",
            "check":              f"PASSED — Successfully checked checkbox: [ {selector} ]",
            "uncheck":            f"PASSED — Successfully unchecked checkbox: [ {selector} ]",
            "hover":              f"PASSED — Successfully hovered over element: [ {selector} ]",
            "press":              f"PASSED — Successfully pressed key '{value}' on: [ {selector} ]",
            "wait":               f"PASSED — Wait of {value}ms completed successfully",
            "wait_for_selector":  f"PASSED — Element appeared on page: [ {selector} ]",
            "wait_for_url":       f"PASSED — URL now contains expected value: '{value}'",
            "assert_text":        f"PASSED — Element [ {selector} ] contains expected text: '{value}'",
            "assert_visible":     f"PASSED — Element is visible on page: [ {selector} ]",
            "assert_url":         f"PASSED — Current URL contains expected value: '{value}'",
            "assert_title":       f"PASSED — Page title contains expected value: '{value}'",
            "assert_value":       f"PASSED — Input [ {selector} ] has correct value: '{value}'",
            "screenshot":         f"PASSED — Screenshot captured successfully: '{value or 'screenshot'}'",
            "scroll":             f"PASSED — Page scrolled to Y position: {value}",
            "execute_script":     f"PASSED — JavaScript executed successfully on the page",
            "db_validate":        f"PASSED — DB validation query passed",
        }.get(action, f"PASSED — Step {idx+1} completed: {action}")
        log(run_id, "pass", f"[OK] {pass_desc}", idx)
        # Take screenshot after every step for live view
        if page:
            take_live_screenshot(page, run_id, f"After Step {idx+1}: {action}")
        return {"status": "passed", "step": idx}

    except (PWTimeout, AssertionError, Exception) as e:
        original_error = str(e)[:200]
        action_used    = step.get("action", "")

        # ── AI Auto-Heal ────────────────────────────────────────────────────
        # Only attempt heal for element-interaction steps, not assertions
        if page and action_used not in ("assert_text", "assert_visible",
                                         "assert_url", "assert_title", "assert_value",
                                         "db_validate", "navigate"):
            healed_selector = ai_heal_step(page, step, run_id, idx, original_error, resolved_vars)
            if healed_selector:
                take_live_screenshot(page, run_id, f"After Heal Step {idx+1}")
                # Save healed selector to DB for future runs
                test_case_id = step.get("_test_case_id")
                if test_case_id:
                    try:
                        requests.patch(
                            f"{API_BASE}/api/ai/heal/{test_case_id}/{idx}",
                            json={"new_selector": healed_selector},
                            timeout=5
                        )
                        log(run_id, "pass", f"  [AI Heal] Selector saved to DB — future runs will use: {healed_selector}", idx)
                    except Exception as save_err:
                        log(run_id, "info", f"  [AI Heal] Could not save to DB: {save_err}", idx)
                return {"status": "passed", "step": idx, "healed": True, "healed_selector": healed_selector}
        # ── End Auto-Heal ────────────────────────────────────────────────────

        if isinstance(e, PWTimeout):
            msg = f"Timeout on step {idx+1}: {action_used} — {original_error}"
        elif isinstance(e, AssertionError):
            msg = f"Assertion failed on step {idx+1}: {original_error}"
        else:
            msg = f"Error on step {idx+1}: {action_used} — {original_error}"

        log(run_id, "fail", f"[FAIL] {msg}", idx)
        take_screenshot(page, run_id, f"fail_step_{idx+1}")
        return {"status": "failed", "step": idx, "error": msg}



def run_db_validate(step, run_id, idx, resolved_vars=None):
    """Execute a DB validation step."""
    cfg = step.get("db_config", {})
    if not cfg:
        return {"status": "failed", "step": idx, "error": "No db_config found on step"}

    conn_mode   = cfg.get("conn_mode", "manual")
    assert_type = cfg.get("assert_type", "equals")
    expected    = apply_variables(str(cfg.get("expected", "")), resolved_vars)
    column      = cfg.get("column", "")
    store_as    = cfg.get("store_as", "")
    query_raw   = cfg.get("query", "")
    query       = apply_variables(query_raw, resolved_vars)

    log(run_id, "info", f"  DB Query: {query[:120]}{'...' if len(query)>120 else ''}", idx)

    # Resolve connection — saved or manual
    conn_mode = cfg.get("conn_mode", "saved")

    if conn_mode == "manual":
        # Use inline connection details from step config
        host     = cfg.get("host", "localhost").strip()
        port     = int(cfg.get("port", 5432) or 5432)
        database = cfg.get("database", "").strip()
        user     = cfg.get("user", "").strip()
        password = cfg.get("password", "")
        if not host or not database or not user:
            msg = f"Step {idx+1}: Manual DB connection requires host, database and username"
            log(run_id, "fail", f"[FAIL] {msg}", idx)
            return {"status": "failed", "step": idx, "error": msg}
        conn_cfg = {"host": host, "port": port, "database": database, "user": user, "password": password}
        log(run_id, "info", f"  Using manual connection: {user}@{host}:{port}/{database}", idx)

    else:
        # Fetch saved connection from backend by name
        conn_name = cfg.get("conn_name", "").strip()
        if not conn_name:
            msg = f"Step {idx+1}: No connection name provided — enter a saved connection name or switch to manual"
            log(run_id, "fail", f"[FAIL] {msg}", idx)
            return {"status": "failed", "step": idx, "error": msg}
        log(run_id, "info", f"  Using saved connection: '{conn_name}'", idx)
        try:
            from urllib.parse import quote
            resp = requests.get(
                f"{API_BASE}/api/db-connections/{quote(conn_name, safe='')}/config",
                headers={"Authorization": f"Bearer {RUNNER_TOKEN}"},
                timeout=10
            )
            if not resp.ok:
                raise Exception(resp.json().get("error", "Connection not found"))
            conn_cfg = resp.json()
        except Exception as e:
            msg = f"Could not load connection '{conn_name}': {e}"
            log(run_id, "fail", f"[FAIL] {msg}", idx)
            return {"status": "failed", "step": idx, "error": msg}

    db_type = "postgresql"

    # ── Execute query ──────────────────────────────────────────────────────────
    try:
        rows, col_names = execute_db_query(db_type, conn_cfg, query)
    except Exception as e:
        msg = f"DB query error on step {idx+1}: {e}"
        log(run_id, "fail", f"[FAIL] {msg}", idx)
        return {"status": "failed", "step": idx, "error": msg}

    log(run_id, "info", f"  Query returned {len(rows)} row(s)", idx)

    # ── Apply assertion ────────────────────────────────────────────────────────
    stored = {}
    try:
        if assert_type == "is_empty":
            assert len(rows) == 0, f"Expected 0 rows but got {len(rows)}"
            log(run_id, "pass", f"[OK] PASSED — DB query returned 0 rows as expected", idx)

        elif assert_type == "not_empty":
            assert len(rows) > 0, "Expected rows but query returned 0 results"
            log(run_id, "pass", f"[OK] PASSED — DB query returned {len(rows)} row(s) as expected", idx)

        elif assert_type == "row_count":
            assert len(rows) == int(expected), f"Expected {expected} rows but got {len(rows)}"
            log(run_id, "pass", f"[OK] PASSED — DB query returned exactly {len(rows)} row(s)", idx)

        elif assert_type == "store":
            if not rows:
                raise AssertionError("Query returned no rows — nothing to store")
            cell = get_cell(rows[0], col_names, column)
            var_name = store_as or "db_result"
            stored[var_name] = str(cell)
            log(run_id, "pass", f"[OK] PASSED — Stored '{cell}' into variable {{{{ {var_name} }}}}", idx)

        else:  # equals, contains, not_equals
            if not rows:
                raise AssertionError(f"Query returned no rows — cannot assert value")
            cell = str(get_cell(rows[0], col_names, column))
            log(run_id, "info", f"  Actual value: '{cell}'", idx)
            if assert_type == "equals":
                assert cell == expected, f"Expected '{expected}' but got '{cell}'"
                log(run_id, "pass", f"[OK] PASSED — Value '{cell}' equals expected '{expected}'", idx)
            elif assert_type == "not_equals":
                assert cell != expected, f"Expected value to NOT equal '{expected}' but it did"
                log(run_id, "pass", f"[OK] PASSED — Value '{cell}' correctly differs from '{expected}'", idx)
            elif assert_type == "contains":
                assert expected in cell, f"Expected '{cell}' to contain '{expected}'"
                log(run_id, "pass", f"[OK] PASSED — Value '{cell}' contains '{expected}'", idx)

        result = {"status": "passed", "step": idx}
        if stored:
            result["stored_var"] = stored
        return result

    except AssertionError as e:
        msg = f"DB validation failed on step {idx+1}: {e}"
        log(run_id, "fail", f"[FAIL] {msg}", idx)
        return {"status": "failed", "step": idx, "error": msg}


def get_cell(row, col_names, column_hint):
    """Get a cell value from a row dict by column name or first column."""
    if column_hint and column_hint in row:
        return row[column_hint]
    if column_hint:
        # case-insensitive search
        for k in row:
            if k.lower() == column_hint.lower():
                return row[k]
    # Fall back to first column
    if col_names:
        return row.get(col_names[0])
    return list(row.values())[0] if row else None


def execute_db_query(db_type, cfg, query):
    """Execute a PostgreSQL query and return (rows_as_dicts, col_names)."""
    if not HAS_PG:
        raise Exception("psycopg2 not installed. Run: pip install psycopg2-binary --break-system-packages")
    conn = psycopg2.connect(
        host=cfg["host"],
        port=int(cfg.get("port", 5432) or 5432),
        dbname=cfg["database"],
        user=cfg["user"],
        password=cfg["password"],
        connect_timeout=10
    )
    try:
        cur = conn.cursor()
        cur.execute(query)
        col_names = [d[0] for d in cur.description] if cur.description else []
        rows = [dict(zip(col_names, r)) for r in (cur.fetchall() or [])]
        return rows, col_names
    finally:
        conn.close()


def run_api_test(config, run_id):
    """Run an API test."""
    results = []
    method     = config.get("method", "GET")
    url        = config.get("url", "")
    headers    = config.get("headers", {})
    body       = config.get("body", None)
    assertions = config.get("assertions", [])

    log(run_id, "info", f"API Test: {method} {url}")
    start = time.time()

    try:
        response = requests.request(
            method, url, headers=headers,
            json=json.loads(body) if body else None,
            timeout=30
        )
        duration = int((time.time() - start) * 1000)
        log(run_id, "info", f"Response: {response.status_code} in {duration}ms")

        # Run assertions
        for i, assertion in enumerate(assertions):
            atype  = assertion.get("type", "")
            avalue = assertion.get("value", "")
            try:
                if atype == "status_code":
                    assert response.status_code == int(avalue), f"Expected status {avalue}, got {response.status_code}"
                elif atype == "response_contains":
                    assert avalue in response.text, f"Response does not contain '{avalue}'"
                elif atype == "json_key_exists":
                    data = response.json()
                    assert avalue in data, f"JSON key '{avalue}' not found"
                elif atype == "json_value":
                    key, expected = avalue.split("=", 1)
                    data = response.json()
                    assert str(data.get(key)) == expected, f"Expected {key}={expected}, got {data.get(key)}"
                elif atype == "response_time":
                    assert duration <= int(avalue), f"Response time {duration}ms exceeded {avalue}ms"

                log(run_id, "pass", f"[OK] Assertion {i+1} passed: {atype}")
                results.append({"status": "passed", "step": i})
            except AssertionError as e:
                log(run_id, "fail", f"[FAIL] Assertion {i+1} failed: {str(e)}")
                results.append({"status": "failed", "step": i, "error": str(e)})

    except Exception as e:
        log(run_id, "fail", f"[FAIL] API request failed: {str(e)}")
        results.append({"status": "failed", "step": 0, "error": str(e)})

    return results



# ─── VARIABLE RESOLVER ────────────────────────────────────────────────────────
import random
import string
import uuid as _uuid

# Stores resolved values so increment/fixed stay consistent per run
_resolved_cache = {}


def resolve_dynamic_value(config_value):
    """Resolve a dynamic variable value based on $ suffix pattern.
    123$           -> random number same length
    Suresh$        -> random Indian first name
    suresh$        -> random Indian first name (case insensitive)
    Suresh Sharma$ -> random Indian full name
    test@x.com$    -> random email same domain
    test$          -> random string same length
    """
    import random, string as _string
    val = str(config_value or "").strip()
    if not val.endswith("$"):
        return val  # not dynamic, return as-is
    base = val[:-1]  # strip $

    FIRST_NAMES = ["Aarav","Aditya","Akash","Amit","Ananya","Anjali","Arjun","Aryan",
        "Deepak","Divya","Gaurav","Ishaan","Kavya","Kiran","Meera","Mihir","Mohan",
        "Neha","Nikhil","Pooja","Priya","Rahul","Raj","Ravi","Rohit","Sakshi",
        "Sanjay","Sneha","Suresh","Tanvi","Vikram","Vikas","Vivek","Zara",
        "Harish","Ramesh","Ganesh","Dinesh","Mahesh","Rajesh","Naresh","Umesh",
        "Sunita","Geeta","Anita","Kavita","Nita","Rita","Sita","Lata","Rekha"]
    LAST_NAMES = ["Gupta","Sharma","Verma","Singh","Kumar","Patel","Mehta","Joshi",
        "Rao","Nair","Iyer","Reddy","Shah","Chauhan","Malhotra","Sinha","Pandey",
        "Mishra","Tiwari","Dubey","Shukla","Agarwal","Bansal","Goel","Kapoor"]

    # Email pattern
    if "@" in base and "." in base.split("@")[-1]:
        parts = base.split("@")
        domain = parts[1]
        rand = "".join(random.choices(_string.ascii_lowercase + _string.digits, k=6))
        return f"{rand}@{domain}"

    # Numeric pattern
    if base.replace("-","").replace(".","").isdigit():
        digits = len([c for c in base if c.isdigit()])
        lo = 10**(digits-1) if digits > 1 else 0
        hi = (10**digits) - 1
        return str(random.randint(lo, hi))

    # Full name pattern (two+ words, any case)
    words = base.split()
    if len(words) >= 2 and all(w.replace("_","").isalpha() for w in words if w):
        return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"

    # Single name pattern — any alpha string (case insensitive)
    if base and base.replace("_","").isalpha():
        return random.choice(FIRST_NAMES)

    # Default: random alphanumeric string same length
    length = max(4, len(base))
    return "".join(random.choices(_string.ascii_lowercase, k=length))

def resolve_variable(var, run_id):
    """Resolve a single variable definition to a concrete value."""
    name   = var.get("name", "")
    vtype  = var.get("type", "fixed")
    config = var.get("config", "")

    # Only cache fixed/increment/db_query — random types must NOT be cached
    # so they can regenerate on every loop iteration
    if vtype not in RANDOM_TYPES and name in _resolved_cache:
        return _resolved_cache[name]

    value = ""

    if vtype == "random_email":
        prefix = config.strip() if config.strip() else "user"
        rand   = "".join(random.choices(string.digits, k=8))
        value  = f"{prefix}_{rand}@test.com"

    elif vtype == "random_number":
        try:
            parts = config.split("-")
            lo, hi = int(parts[0].strip()), int(parts[1].strip())
        except:
            lo, hi = 1000, 9999
        value = str(random.randint(lo, hi))

    elif vtype == "timestamp":
        fmt = config.strip() if config.strip() else "%Y%m%d_%H%M%S"
        # Convert simple YYYYMMDD format to strftime
        fmt = fmt.replace("YYYY", "%Y").replace("MM", "%m").replace("DD", "%d")
        fmt = fmt.replace("HH", "%H").replace("mm", "%M").replace("ss", "%S")
        value = datetime.utcnow().strftime(fmt)

    elif vtype == "fixed":
        value = str(config).strip() if isinstance(config, str) else str(config.get("value","") if isinstance(config, dict) else config)

    elif vtype == "dynamic":
        # config is the raw value string with optional $ suffix
        cfg_val = config if isinstance(config, str) else config.get("value","")
        value = resolve_dynamic_value(cfg_val)

    elif vtype == "data_table":
        # Single-row data table — config has value + col_index
        cfg_val = config.get("value","") if isinstance(config, dict) else str(config)
        value = resolve_dynamic_value(cfg_val)  # handles $ suffix

    elif vtype == "from_list":
        items = [x.strip() for x in config.split(",") if x.strip()]
        value = random.choice(items) if items else config

    elif vtype == "random_text":
        try:
            length = int(config.strip()) if config.strip() else 8
        except:
            length = 8
        import string as _string
        chars = _string.ascii_letters
        value = "".join(random.choices(chars, k=length))

    elif vtype == "increment":
        try:
            start = int(config.strip())
        except:
            start = 1
        # Use a file-based counter per variable name
        counter_file = os.path.join(os.path.dirname(__file__), f".counter_{name}")
        try:
            with open(counter_file, "r") as cf:
                current = int(cf.read().strip())
        except:
            current = start
        value = str(current)
        with open(counter_file, "w") as cf:
            cf.write(str(current + 1))

    elif vtype == "dynamic":
        cfg_val = config if isinstance(config, str) else config.get("value","")
        return resolve_dynamic_value(cfg_val)

    elif vtype == "data_table":
        cfg_val = config.get("value","") if isinstance(config, dict) else str(config)
        return resolve_dynamic_value(cfg_val)

    elif vtype == "uuid":
        value = str(_uuid.uuid4())

    _resolved_cache[name] = value
    log(run_id, "info", f"[VAR] {{{{{name}}}}} = {value}")
    return value


def resolve_variables_in_steps(steps, variables, run_id):
    """Replace all {{var_name}} placeholders in all steps."""
    if not variables:
        return steps

    # Build resolution map
    var_map = {}
    for var in variables:
        var_map[var["name"]] = resolve_variable(var, run_id)

    import copy
    resolved_steps = copy.deepcopy(steps)

    for step in resolved_steps:
        for field in ["value", "selector", "url"]:
            if field in step and step[field]:
                val = step[field]
                for var_name, var_value in var_map.items():
                    val = val.replace("{{" + var_name + "}}", var_value)
                step[field] = val

    return resolved_steps



# ─── CONTROL FLOW INTERPRETER ─────────────────────────────────────────────────

def evaluate_condition(page, step, resolved_vars):
    """Evaluate an if_start condition. Returns True or False."""
    cond     = step.get("if_condition", "element_visible")
    selector = step.get("if_selector", "")
    var_name = step.get("if_var", "")
    expected = step.get("if_value", "")

    # Resolve variables in the values
    if resolved_vars:
        selector = apply_variables(selector, resolved_vars)
        var_name = apply_variables(var_name,  resolved_vars)
        expected = apply_variables(expected,  resolved_vars)

    try:
        if cond == "element_visible":
            return get_locator(page, selector).is_visible() if selector else False

        elif cond == "element_not_visible":
            return not get_locator(page, selector).is_visible() if selector else True

        elif cond == "var_equals":
            actual = resolved_vars.get(var_name.strip("{}"), "") if resolved_vars else ""
            return str(actual).strip() == str(expected).strip()

        elif cond == "var_not_equals":
            actual = resolved_vars.get(var_name.strip("{}"), "") if resolved_vars else ""
            return str(actual).strip() != str(expected).strip()

        elif cond == "var_contains":
            actual = resolved_vars.get(var_name.strip("{}"), "") if resolved_vars else ""
            return str(expected) in str(actual)

        elif cond == "url_contains":
            return expected in page.url

        elif cond == "url_not_contains":
            return expected not in page.url

        elif cond == "page_title_contains":
            return expected in page.title()

    except Exception:
        pass
    return False



RANDOM_TYPES = {"random_email", "random_number", "random_text", "timestamp", "from_list", "uuid", "dynamic"}

def generate_fresh_value(var):
    """Generate a fresh random value for a variable — bypasses cache. Used inside loops."""
    vtype  = var.get("type", "fixed")
    config = var.get("config", "")

    if vtype == "random_email":
        prefix = config.strip() if config.strip() else "user"
        rand   = "".join(random.choices(string.digits, k=8))
        return f"{prefix}_{rand}@test.com"

    elif vtype == "random_number":
        try:
            parts = config.split("-")
            lo, hi = int(parts[0].strip()), int(parts[1].strip())
        except:
            lo, hi = 1000, 9999
        return str(random.randint(lo, hi))

    elif vtype == "timestamp":
        fmt = config.strip() if config.strip() else "%Y%m%d_%H%M%S"
        fmt = fmt.replace("YYYY","%Y").replace("MM","%m").replace("DD","%d")
        fmt = fmt.replace("HH","%H").replace("mm","%M").replace("ss","%S")
        return datetime.utcnow().strftime(fmt)

    elif vtype == "from_list":
        items = [x.strip() for x in config.split(",") if x.strip()]
        return random.choice(items) if items else config

    elif vtype == "random_text":
        try:
            length = int(config.strip()) if config.strip() else 8
        except:
            length = 8
        import string as _string
        return "".join(random.choices(_string.ascii_letters, k=length))

    elif vtype == "uuid":
        import uuid as _uuid2
        return str(_uuid2.uuid4())

    # For fixed/increment/db_query — return cached/existing value (don't change these)
    return None

def run_steps_with_flow(page, steps, run_id, resolved_vars, config, continue_on_fail=False, variables=None):
    """
    Execute steps with full control flow support:
    - loop_start / loop_end
    - foreach_start / foreach_end
    - if_start / else / if_end
    - switch_start / case / switch_end
    - break
    """
    global DEBUG_STEP_MODE  # allow continue command to turn off step-mode
    results  = []
    i        = 0
    n        = len(steps)

    while i < n:
        step   = steps[i]
        action = step.get("action", "")

        # ── LOOP ────────────────────────────────────────────────────────────
        if action == "loop_start":
            # ── DATA TABLE support ──────────────────────────────────────────
            data_table = step.get("data_table", {})
            dt_enabled = data_table.get("enabled", False)

            if dt_enabled:
                dt_columns = data_table.get("columns", [])
                dt_rows    = data_table.get("rows", [])
                count = len(dt_rows)
                log(run_id, "info", f">> Data Table Loop: {count} row(s), columns: {dt_columns}")
            else:
                count = int(apply_variables(step.get("value","1"), resolved_vars) or 1)

            # Find matching loop_end
            depth, end_idx = 1, i+1
            while end_idx < n and depth > 0:
                a = steps[end_idx].get("action","")
                if a in ("loop_start","foreach_start"): depth += 1
                elif a in ("loop_end","foreach_end"):   depth -= 1
                end_idx += 1
            end_idx -= 1  # points to the loop_end step

            if not dt_enabled:
                log(run_id, "info", f">> Loop: repeating {count} time(s) [{i+1}..{end_idx+1}]")
            body = steps[i+1:end_idx]
            broken = False
            # Loop-level continue_on_fail: collect assertion failures, complete all iterations
            loop_cof = step.get("continue_on_fail", False)
            loop_failures = []  # collect assertion failures across iterations

            for iteration in range(count):
                loop_vars = {**resolved_vars, "__loop_index__": str(iteration)}

                # ── Inject data table row values ────────────────────────────
                if dt_enabled and iteration < len(dt_rows):
                    row = dt_rows[iteration]
                    for col_idx, col_name in enumerate(dt_columns):
                        if col_name and col_idx < len(row):
                            loop_vars[col_name] = str(row[col_idx])
                    log(run_id, "info", f"   Data Table row {iteration+1}/{count}: { {c: dt_rows[iteration][j] for j,c in enumerate(dt_columns) if c} }")

                # Regenerate random-type variables on each iteration
                if variables:
                    for var in variables:
                        if var.get("type") in RANDOM_TYPES and (not dt_enabled or var["name"] not in dt_columns):
                            fresh = generate_fresh_value(var)
                            if fresh is not None:
                                loop_vars[var["name"]] = fresh

                if not dt_enabled:
                    log(run_id, "info", f"   Loop iteration {iteration+1}/{count} — vars: { {k:v for k,v in loop_vars.items() if not k.startswith('__')} }")

                if loop_cof:
                    # Run with continue_on_fail=True so sub-steps don't stop on assertion fail
                    sub = run_steps_with_flow(page, body, run_id, loop_vars, config, True, variables)
                    for k, v in loop_vars.items():
                        if k != "__loop_index__": resolved_vars[k] = v
                    clean = [r for r in sub if not r.get("__break__") and not r.get("__continue__")]
                    results.extend(clean)
                    # Collect assertion failures for summary
                    for r in clean:
                        if r.get("status") == "failed":
                            err_msg = r.get("error","assertion failed")
                            loop_failures.append(f"Iteration {iteration+1}: {err_msg}")
                            log(run_id, "warn", f"   [LOOP SOFT FAIL] Iteration {iteration+1}: {err_msg}")
                    # Hard failures (non-assertion) still break
                    if any(r.get("__break__") for r in sub): broken = True; break
                    if any(r.get("__continue__") for r in sub): continue
                else:
                    sub = run_steps_with_flow(page, body, run_id, loop_vars, config, continue_on_fail, variables)
                    for k, v in loop_vars.items():
                        if k != "__loop_index__": resolved_vars[k] = v
                    results.extend([r for r in sub if not r.get("__break__") and not r.get("__continue__")])
                    if any(r.get("__break__") for r in sub): broken = True; break
                    if any(r.get("__continue__") for r in sub): continue
                    if not continue_on_fail and any(r["status"]=="failed" for r in sub): break

            # After loop completes — report all collected assertion failures
            if loop_failures:
                summary = f"Loop completed with {len(loop_failures)} assertion failure(s):\n" + "\n".join(f"  • {f}" for f in loop_failures)
                log(run_id, "fail", f"[FAIL] {summary}")
                results.append({"status": "failed", "step": i, "error": summary})
            i = end_idx + 1
            continue

        # ── LOOP END (skip if reached normally) ─────────────────────────────
        if action == "loop_end":
            i += 1; continue

        # ── FOREACH ─────────────────────────────────────────────────────────
        if action == "foreach_start":
            raw_items  = apply_variables(step.get("value",""), resolved_vars)
            item_var   = step.get("loop_var","current_item") or "current_item"
            items      = [x.strip() for x in raw_items.split(",") if x.strip()]
            # Find foreach_end
            depth, end_idx = 1, i+1
            while end_idx < n and depth > 0:
                a = steps[end_idx].get("action","")
                if a in ("loop_start","foreach_start"): depth += 1
                elif a in ("loop_end","foreach_end"):   depth -= 1
                end_idx += 1
            end_idx -= 1

            log(run_id, "info", f">> ForEach: {len(items)} item(s) → {{{{{item_var}}}}}")
            body = steps[i+1:end_idx]
            foreach_cof = step.get("continue_on_fail", False)
            foreach_failures = []

            for idx2, item in enumerate(items):
                loop_vars = {**resolved_vars, item_var: item, "__loop_index__": str(idx2)}
                if variables:
                    for var in variables:
                        if var.get("type") in RANDOM_TYPES:
                            fresh = generate_fresh_value(var)
                            if fresh is not None:
                                loop_vars[var["name"]] = fresh
                log(run_id, "info", f"   ForEach item {idx2+1}/{len(items)}: {item}")

                if foreach_cof:
                    sub = run_steps_with_flow(page, body, run_id, loop_vars, config, True, variables)
                    for k, v in loop_vars.items():
                        if k not in (item_var, "__loop_index__"): resolved_vars[k] = v
                    clean = [r for r in sub if not r.get("__break__") and not r.get("__continue__")]
                    results.extend(clean)
                    for r in clean:
                        if r.get("status") == "failed":
                            err_msg = r.get("error","assertion failed")
                            foreach_failures.append(f"Item {idx2+1} ({item}): {err_msg}")
                            log(run_id, "warn", f"   [LOOP SOFT FAIL] Item {idx2+1} ({item}): {err_msg}")
                    if any(r.get("__break__") for r in sub): break
                    if any(r.get("__continue__") for r in sub): continue
                else:
                    sub = run_steps_with_flow(page, body, run_id, loop_vars, config, continue_on_fail, variables)
                    for k, v in loop_vars.items():
                        if k not in (item_var, "__loop_index__"): resolved_vars[k] = v
                    results.extend([r for r in sub if not r.get("__break__") and not r.get("__continue__")])
                    if any(r.get("__break__") for r in sub): break
                    if any(r.get("__continue__") for r in sub): continue
                    if not continue_on_fail and any(r["status"]=="failed" for r in sub): break

            if foreach_failures:
                summary = f"ForEach completed with {len(foreach_failures)} assertion failure(s):\n" + "\n".join(f"  • {f}" for f in foreach_failures)
                log(run_id, "fail", f"[FAIL] {summary}")
                results.append({"status": "failed", "step": i, "error": summary})
            i = end_idx + 1
            continue

        if action == "foreach_end":
            i += 1; continue

        # ── BREAK ───────────────────────────────────────────────────────────
        if action == "break":
            log(run_id, "info", ">> Break — exiting loop")
            results.append({"status":"passed","step":i,"__break__":True})
            return results

        # ── CONTINUE ────────────────────────────────────────────────────────
        if action == "continue":
            log(run_id, "info", ">> Continue — skipping to next loop iteration")
            results.append({"status":"passed","step":i,"__continue__":True})
            return results

        # ── REPEAT UNTIL ────────────────────────────────────────────────────
        if action == "repeat_until":
            max_retries = int(step.get("max_retries") or 10)
            interval_ms = int(step.get("interval_ms") or 2000)
            # Find matching repeat_until_end
            depth, end_idx = 1, i+1
            while end_idx < n and depth > 0:
                a = steps[end_idx].get("action","")
                if a == "repeat_until":   depth += 1
                elif a == "repeat_until_end": depth -= 1
                end_idx += 1
            end_idx -= 1

            body = steps[i+1:end_idx]
            log(run_id, "info", f">> Repeat Until: max {max_retries} tries, interval {interval_ms}ms")

            for attempt in range(max_retries):
                log(run_id, "info", f"   Repeat Until attempt {attempt+1}/{max_retries}")
                sub = run_steps_with_flow(page, body, run_id, resolved_vars, config, True, variables)
                results.extend(sub)
                # Check condition after running body
                if evaluate_condition(page, step, resolved_vars):
                    log(run_id, "pass", f"[OK] Repeat Until condition met after {attempt+1} attempt(s)")
                    break
                if attempt < max_retries - 1:
                    time.sleep(interval_ms / 1000.0)
            else:
                log(run_id, "fail", f"[FAIL] Repeat Until: condition not met after {max_retries} attempts")
                results.append({"status":"failed","step":i,"error":f"Condition not met after {max_retries} attempts"})
                if not continue_on_fail: return results

            i = end_idx + 1
            continue

        if action == "repeat_until_end":
            i += 1; continue

        # ── TRY / CATCH ─────────────────────────────────────────────────────
        if action == "try_start":
            # Find catch_start and try_end
            depth = 1
            catch_idx = None
            end_idx   = None
            j = i + 1
            while j < n and depth > 0:
                a = steps[j].get("action","")
                if a == "try_start":                    depth += 1
                elif a == "catch_start" and depth == 1: catch_idx = j
                elif a == "try_end":
                    depth -= 1
                    if depth == 0: end_idx = j
                j += 1
            if end_idx is None: end_idx = n - 1

            try_body   = steps[i+1 : catch_idx if catch_idx else end_idx]
            catch_body = steps[catch_idx+1 : end_idx] if catch_idx else []

            log(run_id, "info", ">> Try block starting")
            sub = run_steps_with_flow(page, try_body, run_id, resolved_vars, config, True, variables)
            had_failure = any(r["status"] == "failed" for r in sub)

            if had_failure and catch_body:
                error_msg = next((r.get("error","") for r in sub if r["status"]=="failed"), "")
                catch_step = steps[catch_idx] if catch_idx else {}
                error_var  = catch_step.get("error_var","")
                if error_var:
                    resolved_vars[error_var] = error_msg
                    log(run_id, "info", f"   Catch: stored error in {{{{{error_var}}}}}: {error_msg[:80]}")
                log(run_id, "info", ">> Catch block running")
                catch_sub = run_steps_with_flow(page, catch_body, run_id, resolved_vars, config, continue_on_fail, variables)
                results.extend(catch_sub)
            else:
                results.extend(sub)
                if had_failure:
                    log(run_id, "info", ">> Try failed (no catch block defined)")

            i = end_idx + 1
            continue

        if action in ("catch_start", "try_end"):
            i += 1; continue

        # ── WAIT UNTIL ──────────────────────────────────────────────────────
        if action == "wait_until":
            timeout_ms  = int(step.get("timeout") or 30000)
            poll_ms     = 500
            deadline    = time.time() + timeout_ms / 1000.0
            label       = step.get("if_condition","element_visible")
            log(run_id, "info", f">> Wait Until: [{label}] timeout={timeout_ms}ms")

            met = False
            while time.time() < deadline:
                if evaluate_condition(page, step, resolved_vars):
                    met = True
                    break
                time.sleep(poll_ms / 1000.0)

            if met:
                log(run_id, "pass", f"[OK] Wait Until condition met")
                results.append({"status":"passed","step":i})
            else:
                msg = f"Wait Until timed out after {timeout_ms}ms — condition [{label}] never became true"
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── IF / ELSE / END_IF ───────────────────────────────────────────────
        if action == "if_start":
            condition_result = evaluate_condition(page, step, resolved_vars)
            log(run_id, "info", f">> IF condition: {'TRUE' if condition_result else 'FALSE'}")

            # Find else and if_end positions
            depth = 1
            else_idx = None
            end_idx  = None
            j = i + 1
            while j < n and depth > 0:
                a = steps[j].get("action","")
                if a == "if_start":                    depth += 1
                elif a == "else" and depth == 1:       else_idx = j
                elif a == "if_end":
                    depth -= 1
                    if depth == 0: end_idx = j
                j += 1

            if end_idx is None: end_idx = n - 1

            if condition_result:
                true_body = steps[i+1 : else_idx if else_idx else end_idx]
            else:
                true_body = steps[else_idx+1 : end_idx] if else_idx else []

            sub = run_steps_with_flow(page, true_body, run_id, resolved_vars, config, continue_on_fail, variables)
            # Variables set inside IF branch are available after the block
            results.extend(sub)
            i = end_idx + 1
            continue

        if action in ("else","if_end"):
            i += 1; continue

        # ── SWITCH / CASE / END_SWITCH ───────────────────────────────────────
        if action == "switch_start":
            switch_val = apply_variables(step.get("value",""), resolved_vars)
            log(run_id, "info", f">> Switch on: '{switch_val}'")

            # Collect all case blocks until switch_end
            depth = 1
            j = i + 1
            cases = []   # list of (match_value, [steps])
            current_case_val  = None
            current_case_body = []

            while j < n and depth > 0:
                a = steps[j].get("action","")
                if a == "switch_start":
                    depth += 1
                    current_case_body.append(steps[j])
                elif a == "switch_end":
                    depth -= 1
                    if depth == 0:
                        if current_case_val is not None:
                            cases.append((current_case_val, current_case_body))
                        break
                    else:
                        current_case_body.append(steps[j])
                elif a == "case" and depth == 1:
                    if current_case_val is not None:
                        cases.append((current_case_val, current_case_body))
                    current_case_val  = apply_variables(steps[j].get("value",""), resolved_vars)
                    current_case_body = []
                else:
                    current_case_body.append(steps[j])
                j += 1

            end_idx = j

            matched = False
            for case_val, case_body in cases:
                if str(case_val) == str(switch_val):
                    log(run_id, "info", f"   Switch matched case: '{case_val}'")
                    sub = run_steps_with_flow(page, case_body, run_id, resolved_vars, config, continue_on_fail, variables)
                    results.extend(sub)
                    matched = True
                    break

            if not matched:
                log(run_id, "info", f"   Switch: no case matched '{switch_val}'")

            i = end_idx + 1
            continue

        if action in ("case","switch_end"):
            i += 1; continue

        # ── GROUP / COMMENT ─────────────────────────────────────────────────
        if action == "group":
            label = step.get("value","") or "Group"
            log(run_id, "info", f"── {label} ──")
            results.append({"status":"passed","step":i})
            i += 1
            continue

        # ── STORE text / value / URL ─────────────────────────────────────────
        if action in ("store_text","store_value","store_url"):
            var_name = step.get("value","").strip()
            if not var_name:
                log(run_id, "info", f">> store: no variable name specified, skipping")
                results.append({"status":"passed","step":i})
                i += 1
                continue
            try:
                if action == "store_url":
                    stored = page.url
                elif action == "store_text":
                    stored = get_locator(page, apply_variables(step.get("selector",""), resolved_vars)).inner_text()
                else:
                    stored = get_locator(page, apply_variables(step.get("selector",""), resolved_vars)).input_value()
                resolved_vars[var_name] = stored
                log(run_id, "pass", f"[OK] Stored '{stored[:80]}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"store failed: {e}"
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── ASSERT NOT TEXT ──────────────────────────────────────────────────
        if action == "assert_not_text":
            try:
                sel  = apply_variables(step.get("selector",""), resolved_vars)
                val  = apply_variables(step.get("value",""),    resolved_vars)
                text = get_locator(page, sel).inner_text(timeout=step.get("timeout",30000))
                assert val not in text, f"Text '{val}' found but should NOT be present. Actual: '{text[:100]}'"
                log(run_id, "pass", f"[OK] Text '{val}' correctly absent")
                results.append({"status":"passed","step":i})
            except AssertionError as e:
                msg = str(e)
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── ASSERT NOT VISIBLE ───────────────────────────────────────────────
        if action == "assert_not_visible":
            try:
                sel = apply_variables(step.get("selector",""), resolved_vars)
                loc = get_locator(page, sel)
                visible = loc.is_visible()
                assert not visible, f"Element '{sel}' is visible but should be hidden"
                log(run_id, "pass", f"[OK] Element correctly not visible")
                results.append({"status":"passed","step":i})
            except AssertionError as e:
                msg = str(e)
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── ASSERT COUNT ─────────────────────────────────────────────────────
        if action == "assert_count":
            try:
                sel      = apply_variables(step.get("selector",""), resolved_vars)
                expected = int(apply_variables(step.get("value","0"), resolved_vars))
                actual   = get_locator(page, sel).count()
                assert actual == expected, f"Expected {expected} element(s), found {actual}"
                log(run_id, "pass", f"[OK] Element count = {actual}")
                results.append({"status":"passed","step":i})
            except (AssertionError, ValueError) as e:
                msg = str(e)
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1
            continue


        # ── STORE ATTR / TITLE / COUNT / JS ──────────────────────────────────
        if action in ("store_attr","store_title","store_count","store_js"):
            var_name = apply_variables(step.get("store_as","") or step.get("value",""), resolved_vars).strip()
            if not var_name:
                log(run_id,"info",">> store: no variable name specified, skipping")
                results.append({"status":"passed","step":i}); i+=1; continue
            try:
                sel = apply_variables(step.get("selector",""), resolved_vars)
                if action == "store_attr":
                    attr = apply_variables(step.get("value2","") or step.get("value",""), resolved_vars)
                    stored = str(get_locator(page, sel).get_attribute(attr) or "")
                elif action == "store_title":
                    stored = page.title()
                elif action == "store_count":
                    stored = str(get_locator(page, sel).count())
                else:  # store_js
                    js = apply_variables(step.get("value",""), resolved_vars).strip()
                    # Wrap bare expressions in an arrow function so page.evaluate works
                    # page.evaluate() needs either "() => expr" or a full function string
                    if js and not js.startswith("()") and not js.startswith("function"):
                        js = f"() => {{ return {js}; }}"
                    result_raw = page.evaluate(js)
                    # Clean up the result — strip commas from numbers like "1,180.00"
                    stored = str(result_raw).strip()
                resolved_vars[var_name] = stored
                log(run_id,"pass",f"[OK] Stored '{str(stored)[:80]}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"store failed: {e}"
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── GET TABLE VALUE ───────────────────────────────────────────────────
        # Usage: action=get_table_value, value="Gross Amount", store_as="gross_amount"
        # Optional: value2="compare_with" to assert instead of store
        # Finds the row whose label matches value, returns the numeric cell in that row
        # ── GET TABLE VALUE ───────────────────────────────────────────────────
        # Usage: label="Gross Amount", store_as="var", value2="compare_value"
        # Approach: use Python to parse page text directly — no complex JS
        if action == "get_table_value":
            label    = apply_variables(step.get("value",""),    resolved_vars).strip()
            store_as = apply_variables(step.get("store_as",""), resolved_vars).strip()
            compare  = apply_variables(step.get("value2",""),   resolved_vars).strip()
            selector = apply_variables(step.get("selector",""), resolved_vars).strip()
            try:
                import re as _re

                # Wait for page to settle
                try:    page.wait_for_load_state("networkidle", timeout=3000)
                except: time.sleep(0.5)

                # ── Strategy 1: Use Playwright locator to find label, then get sibling ──
                # This is the most reliable — works regardless of table/div structure
                stored = None
                label_lower = label.lower()

                # Try to find by exact text first, then partial
                for exact in [True, False]:
                    try:
                        loc = page.get_by_text(label, exact=exact)
                        count = loc.count()
                        if count > 0:
                            # Found the label element — try to get value from:
                            # 1. Next sibling td/span/div
                            # 2. Parent row's other cells
                            for idx in range(min(count, 3)):
                                el = loc.nth(idx)
                                # Try evaluate to get the parent row and extract value
                                # Use locator.evaluate() to avoid element_handle greenlet conflicts
                                val = el.evaluate("""
                                    (el) => {
                                        if (!el) return null;
                                        function clean(s) {
                                            return (s||'').trim().replace(/,/g,'').replace(/[\u20B9$€£\s]/g,'');
                                        }
                                        function isNum(s) {
                                            return /^-?[\d]+(\.\d+)?$/.test(s);
                                        }
                                        let container = el;
                                        for (let d = 0; d < 5; d++) {
                                            if (!container.parentElement) break;
                                            container = container.parentElement;
                                            const tag = container.tagName.toLowerCase();
                                            if (tag === 'tr' || tag === 'li' ||
                                                container.classList.contains('row') ||
                                                container.classList.contains('summary-row')) {
                                                const children = Array.from(container.querySelectorAll('td,th,span,div,p'));
                                                for (const child of children) {
                                                    if (child === el || child.contains(el)) continue;
                                                    const t = clean(child.innerText || child.textContent);
                                                    if (t && isNum(t)) return t;
                                                }
                                                for (const child of children) {
                                                    if (child === el || child.contains(el)) continue;
                                                    const t = (child.innerText||child.textContent||'').trim();
                                                    const c = clean(t);
                                                    if (c && c !== '-' && c !== '–') return c;
                                                }
                                                break;
                                            }
                                        }
                                        let sib = el.nextElementSibling;
                                        for (let k=0; k<5 && sib; k++) {
                                            const t = clean(sib.innerText||sib.textContent);
                                            if (t && t !== '-') return t;
                                            sib = sib.nextElementSibling;
                                        }
                                        return null;
                                    }
                                """)
                                if val:
                                    stored = str(val).strip()
                                    break
                        if stored: break
                    except Exception as e:
                        log(run_id, "info", f"[get_table_value] strategy1 attempt failed: {e}")
                        pass

                # ── Strategy 2: Parse full page innerText as lines ───────────────
                if not stored:
                    try:
                        # Get full visible text of page
                        full_text = page.inner_text("body")
                        lines_txt = [l.strip() for l in full_text.split("\n") if l.strip()]
                        for i_line, line in enumerate(lines_txt):
                            if label_lower in line.lower():
                                # Look at surrounding lines for a number
                                for j in range(i_line+1, min(i_line+6, len(lines_txt))):
                                    candidate = lines_txt[j].replace(",","").replace("\u20B9","").strip()
                                    if _re.match(r"^-?[\d]+(\.\d+)?$", candidate):
                                        stored = candidate
                                        break
                                    # Also check if the same line has numbers after the label
                                    after = line[line.lower().index(label_lower)+len(label):].strip()
                                    after_clean = after.replace(",","").replace("\u20B9","").strip()
                                    if after_clean and _re.match(r"^-?[\d]+(\.\d+)?$", after_clean):
                                        stored = after_clean
                                        break
                                if stored: break
                    except Exception as e:
                        log(run_id, "info", f"[get_table_value] strategy2 failed: {e}")

                # ── Strategy 3: Scoped to explicit table selector ────────────────
                if not stored and selector:
                    try:
                        tbl_text = page.inner_text(selector)
                        tbl_lines = [l.strip() for l in tbl_text.split("\n") if l.strip()]
                        for i_line, line in enumerate(tbl_lines):
                            if label_lower in line.lower():
                                for j in range(i_line+1, min(i_line+4, len(tbl_lines))):
                                    c = tbl_lines[j].replace(",","").strip()
                                    if _re.match(r"^-?[\d]+(\.\d+)?$", c):
                                        stored = c; break
                                if stored: break
                    except Exception as e:
                        log(run_id, "info", f"[get_table_value] strategy3 failed: {e}")

                # ── Not found — diagnostic dump ──────────────────────────────────
                if not stored:
                    try:
                        full_text = page.inner_text("body")
                        # Show lines around where label might appear
                        lines_txt = [l.strip() for l in full_text.split("\n") if l.strip()]
                        # Show all lines that have numbers (likely value rows)
                        num_lines = [l for l in lines_txt if _re.search(r"[\d]+\.\d+", l)]
                        all_sample = " | ".join(lines_txt[:40])
                        raise Exception(
                            f"Label '{label}' not found.\n"
                            f"Lines with numbers: {num_lines[:15]}\n"
                            f"First 40 lines: {all_sample}"
                        )
                    except Exception as diag_e:
                        raise diag_e

                # ── Success ──────────────────────────────────────────────────────
                log(run_id, "pass", f"[OK] get_table_value '{label}' = {stored}")

                if store_as:
                    resolved_vars[store_as] = stored
                    log(run_id, "pass", f"[OK] Stored '{stored}' → {{{{{store_as}}}}}")

                if compare:
                    def _n(s):
                        try: return float(str(s).replace(",","").strip())
                        except: return str(s).strip()
                    n1, n2 = _n(stored), _n(compare)
                    if isinstance(n1, float) and isinstance(n2, float):
                        assert n1 == n2, f"Mismatch: '{label}' = {stored}, expected {compare}"
                    else:
                        assert str(stored).strip() == str(compare).strip(), \
                            f"Mismatch: '{label}' = {stored!r}, expected {compare!r}"
                    log(run_id, "pass", f"[OK] '{label}' {stored} == {compare} ✓")

                results.append({"status":"passed","step":i})
            except AssertionError as e:
                log(run_id,"fail",f"[FAIL] {e}")
                results.append({"status":"failed","step":i,"error":str(e)})
                if not continue_on_fail: return results
            except Exception as e:
                log(run_id,"fail",f"[FAIL] get_table_value failed: {e}")
                results.append({"status":"failed","step":i,"error":str(e)})
                if not continue_on_fail: return results
            i += 1; continue

        # ── ASSERT VAR ACTIONS ────────────────────────────────────────────────
        # ── ASSERT SOFT — never breaks, always continues ──────────────────────
        # Use inside loops or standalone — collects failure as warn but continues
        if action == "assert_soft":
            try:
                import re as _re
                v1 = apply_variables(step.get("value",""),  resolved_vars)
                v2 = apply_variables(step.get("value2","") or step.get("selector",""), resolved_vars)
                op = step.get("operator","equals")
                def _n(s):
                    try: return float(str(s).replace(",","").strip())
                    except: return None
                passed = False
                if op == "equals":
                    n1,n2 = _n(v1),_n(v2)
                    passed = (n1==n2) if (n1 is not None and n2 is not None) else (v1.strip()==v2.strip())
                elif op == "contains":  passed = v2 in v1
                elif op == "greater":   passed = (_n(v1) or 0) > (_n(v2) or 0)
                elif op == "less":      passed = (_n(v1) or 0) < (_n(v2) or 0)
                elif op == "not_equals":
                    n1,n2 = _n(v1),_n(v2)
                    passed = (n1!=n2) if (n1 is not None and n2 is not None) else (v1.strip()!=v2.strip())
                else: passed = v1.strip() == v2.strip()

                if passed:
                    log(run_id, "pass", f"[OK] assert_soft: '{v1[:60]}' {op} '{v2[:60]}'")
                    results.append({"status":"passed","step":i})
                else:
                    msg = f"Soft assertion failed: '{v1[:60]}' {op} '{v2[:60]}'"
                    log(run_id, "warn", f"[SOFT FAIL] {msg}")
                    # Mark as failed so loop summary picks it up, but DON'T return early
                    results.append({"status":"failed","step":i,"error":msg,"soft":True})
            except Exception as e:
                log(run_id, "warn", f"[SOFT FAIL] assert_soft error: {e}")
                results.append({"status":"failed","step":i,"error":str(e),"soft":True})
            i += 1; continue

        if action in ("assert_equals","assert_not_equals","assert_contains","assert_not_contains",
                      "assert_starts_with","assert_ends_with","assert_greater","assert_less",
                      "assert_between","assert_matches","assert_matches_regex","assert_empty","assert_not_empty"):
            try:
                import re as _re
                v1 = apply_variables(step.get("value",""),  resolved_vars)
                v2 = apply_variables(step.get("value2","") or step.get("selector",""), resolved_vars)
                if action == "assert_equals":
                    # Try numeric comparison first (handles 1180.0 == 1180 == "1,180.00")
                    def _clean_num(s):
                        return str(s).strip().replace(",","").replace(" ","")
                    try:
                        assert float(_clean_num(v1)) == float(_clean_num(v2)),                             f"Expected {v2} but got {v1}"
                    except (ValueError, TypeError):
                        assert v1.strip() == v2.strip(), f"Expected '{v2}' but got '{v1}'"
                elif action == "assert_not_equals":
                    def _clean_num(s):
                        return str(s).strip().replace(",","").replace(" ","")
                    try:
                        assert float(_clean_num(v1)) != float(_clean_num(v2)),                             f"Expected NOT {v2} but got {v1}"
                    except (ValueError, TypeError):
                        assert v1.strip() != v2.strip(), f"Expected NOT '{v2}' but got '{v1}'"
                elif action == "assert_contains":     assert v2 in v1,             f"'{v1}' does not contain '{v2}'"
                elif action == "assert_not_contains": assert v2 not in v1,         f"'{v1}' should not contain '{v2}'"
                elif action == "assert_starts_with":  assert v1.startswith(v2),    f"'{v1}' does not start with '{v2}'"
                elif action == "assert_ends_with":    assert v1.endswith(v2),      f"'{v1}' does not end with '{v2}'"
                elif action == "assert_greater":      assert float(v1)>float(v2),  f"{v1} is not > {v2}"
                elif action == "assert_less":         assert float(v1)<float(v2),  f"{v1} is not < {v2}"
                elif action == "assert_between":
                    lo = apply_variables(step.get("value2","0"), resolved_vars)
                    hi = apply_variables(step.get("value3","0"), resolved_vars)
                    assert float(lo)<=float(v1)<=float(hi), f"{v1} is not between {lo} and {hi}"
                elif action in ("assert_matches","assert_matches_regex"): assert _re.search(v2,v1),    f"'{v1}' does not match pattern '{v2}'"
                elif action == "assert_empty":        assert v1.strip()=="",       f"Expected empty but got '{v1}'"
                elif action == "assert_not_empty":    assert v1.strip()!="",       f"Value is empty"
                log(run_id,"pass",f"[OK] {action}: '{v1[:60]}'")
                results.append({"status":"passed","step":i})
            except AssertionError as e:
                msg = str(e)
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── STRING OPERATIONS ─────────────────────────────────────────────────
        if action in ("str_upper","str_lower","str_trim","str_replace","str_substring",
                      "str_concat","str_length","str_split"):
            # Resolve the variable NAME (strip {{ }}) to get the var name for storing back
            raw_val  = step.get("value","")
            src_var  = raw_val.strip().strip("{}").strip()  # get var name without {{ }}
            # Get the actual value — first try resolved_vars by name, then apply_variables
            if src_var in resolved_vars:
                src = resolved_vars[src_var]
            else:
                src = apply_variables(raw_val, resolved_vars)
            var_name = apply_variables(step.get("store_as",""), resolved_vars).strip() or src_var
            try:
                v2  = apply_variables(step.get("value2",""),   resolved_vars)
                # Strip surrounding quotes if user typed them (e.g. " " → space, "," → comma)
                v2 = v2.strip()
                if len(v2) >= 2 and v2[0] in ('"', "'") and v2[-1] == v2[0]:
                    v2 = v2[1:-1]
                if   action == "str_upper":     result_val = src.upper()
                elif action == "str_lower":     result_val = src.lower()
                elif action == "str_trim":      result_val = src.strip()
                elif action == "str_replace":
                    find, repl = v2.split("||",1) if "||" in v2 else (v2,"")
                    result_val = src.replace(find, repl)
                elif action == "str_substring":
                    parts = v2.split(",")
                    start = int(parts[0]) if parts else 0
                    end   = int(parts[1]) if len(parts)>1 else len(src)
                    result_val = src[start:end]
                elif action == "str_concat":    result_val = src + v2
                elif action == "str_length":    result_val = str(len(src))
                elif action == "str_split":
                    # UI stores delimiter in value2, index in value3 (separate fields)
                    # Also support legacy combined format: "delimiter||index" in value2
                    v3 = apply_variables(step.get("value3",""), resolved_vars).strip()
                    if "||" in v2 and not v3:
                        # Legacy combined format
                        parts = v2.split("||", 1)
                        delim = parts[0] if parts[0] else " "
                        idx_n = int(parts[1]) if len(parts) > 1 and parts[1].strip().lstrip("-").isdigit() else 0
                    else:
                        # New separate format: value2=delimiter, value3=index
                        delim = v2 if v2 else " "
                        idx_n = int(v3) if v3.strip().lstrip("-").isdigit() else 0
                    # Strip surrounding quotes if user typed " " or ' ' in delimiter field
                    if len(delim) >= 2 and delim[0] in ('"',"\'") and delim[-1] == delim[0]:
                        delim = delim[1:-1]
                    # Empty delimiter after stripping = split by space
                    if not delim:
                        delim = " "
                    pieces = src.split(delim)
                    log(run_id, "info", f"[str_split] src={src!r} delim={delim!r} idx={idx_n} pieces={pieces}")
                    if idx_n < 0:
                        result_val = pieces[idx_n] if pieces else ""
                    elif idx_n < len(pieces):
                        result_val = pieces[idx_n]
                    else:
                        result_val = pieces[-1] if pieces else ""
                        log(run_id, "warn", f"[str_split] index {idx_n} out of range — {len(pieces)} pieces, using last")
                if var_name:
                    resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: '{str(result_val)[:80]}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"{action} failed: {e}"
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── MATH OPERATIONS ───────────────────────────────────────────────────
        if action in ("math_add","math_subtract","math_multiply","math_divide",
                      "math_round","math_abs","math_random","math_random_int"):
            var_name = apply_variables(step.get("store_as","") or step.get("value",""), resolved_vars).strip()
            try:
                import random as _random, math as _math
                v1_var = apply_variables(step.get("value",""), resolved_vars).strip()
                v1     = resolved_vars.get(v1_var, v1_var)  # resolve variable value
                v2     = apply_variables(step.get("value2",""), resolved_vars)
                if   action == "math_add":      result_val = str(float(v1) + float(v2))
                elif action == "math_subtract": result_val = str(float(v1) - float(v2))
                elif action == "math_multiply": result_val = str(float(v1) * float(v2))
                elif action == "math_divide":   result_val = str(float(v1) / float(v2)) if float(v2)!=0 else "0"
                elif action == "math_round":
                    decimals = int(v2) if v2 else 0
                    result_val = str(round(float(v1), decimals))
                elif action == "math_abs":      result_val = str(abs(float(v1)))
                elif action == "math_random":
                    lo2, hi2 = (float(v1), float(v2)) if v2 else (0, float(v1))
                    result_val = str(_random.randint(int(lo2), int(hi2)))
                # Clean up .0 for whole numbers
                if result_val.endswith(".0"): result_val = result_val[:-2]
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: {result_val} → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"{action} failed: {e}"
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── DATE / TIME OPERATIONS ────────────────────────────────────────────
        if action in ("date_today","date_now","date_add","date_subtract","date_format","date_diff"):
            var_name = apply_variables(step.get("store_as","") or step.get("value",""), resolved_vars).strip()
            try:
                from datetime import datetime as _dt, timedelta as _td
                fmt  = apply_variables(step.get("value2","") or "%d/%m/%Y", resolved_vars)
                val1_var = apply_variables(step.get("value",""), resolved_vars).strip()
                val1 = resolved_vars.get(val1_var, val1_var)
                if   action == "date_today":    result_val = _dt.now().strftime(fmt)
                elif action == "date_now":      result_val = _dt.now().strftime(fmt if fmt else "%d/%m/%Y %H:%M:%S")
                elif action == "date_add":
                    days = int(apply_variables(step.get("value2","1"), resolved_vars))
                    base = _dt.strptime(val1, fmt) if val1 else _dt.now()
                    result_val = (base + _td(days=days)).strftime(fmt)
                elif action == "date_subtract":
                    days = int(apply_variables(step.get("value2","1"), resolved_vars))
                    base = _dt.strptime(val1, fmt) if val1 else _dt.now()
                    result_val = (base - _td(days=days)).strftime(fmt)
                elif action == "date_format":
                    in_fmt = apply_variables(step.get("value3","") or "%d/%m/%Y", resolved_vars)
                    result_val = _dt.strptime(val1, in_fmt).strftime(fmt)
                elif action == "date_diff":
                    val2 = apply_variables(step.get("value2",""), resolved_vars)
                    in_fmt2 = apply_variables(step.get("value3","") or "%d/%m/%Y", resolved_vars)
                    d1 = _dt.strptime(val1, in_fmt2)
                    d2 = _dt.strptime(val2, in_fmt2)
                    result_val = str(abs((d2-d1).days))
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: '{result_val}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"{action} failed: {e}"
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── ENCODE / PARSE OPERATIONS ─────────────────────────────────────────
        if action in ("encode_base64","decode_base64","url_encode","json_extract","json_parse"):
            var_name = apply_variables(step.get("store_as","") or step.get("value",""), resolved_vars).strip()
            try:
                import base64 as _b64, urllib.parse as _up, json as _json
                src_var = apply_variables(step.get("value",""), resolved_vars).strip()
                src = resolved_vars.get(src_var, apply_variables(step.get("selector","") or src_var, resolved_vars))
                v2  = apply_variables(step.get("value2",""), resolved_vars)
                if   action == "encode_base64": result_val = _b64.b64encode(src.encode()).decode()
                elif action == "decode_base64": result_val = _b64.b64decode(src.encode()).decode()
                elif action == "url_encode":    result_val = _up.quote(src)
                elif action == "json_parse":
                    parsed = _json.loads(src)
                    result_val = _json.dumps(parsed) if isinstance(parsed, (dict,list)) else str(parsed)
                elif action == "json_extract":
                    obj = _json.loads(src) if isinstance(src,str) else src
                    path = v2.split(".")
                    for key in path:
                        if key.isdigit(): obj = obj[int(key)]
                        else: obj = obj[key]
                    result_val = str(obj)
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: '{str(result_val)[:80]}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                msg = f"{action} failed: {e}"
                log(run_id,"fail",f"[FAIL] {msg}")
                results.append({"status":"failed","step":i,"error":msg})
                if not continue_on_fail: return results
            i += 1; continue

        # ── REGULAR STEP ─────────────────────────────────────────────────────
        if DEBUG_MODE:
            # ── PAUSE BEFORE EXECUTING (step-mode or breakpoint) ─────────────
            # Broadcast "about to execute" so UI highlights the line
            var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}
            debug_broadcast(run_id, "line_start", {
                "step_index": i,
                "action": step.get("action", ""),
                "variables": var_snapshot
            })

            # Always pause before each step in step-mode
            # Also pause at breakpoints even when not in step-mode (user hit Continue)
            should_pause = DEBUG_STEP_MODE or (i in DEBUG_BREAKPOINTS)
            if should_pause:
                reason = "breakpoint" if i in DEBUG_BREAKPOINTS else "step"
                print(f"[DEBUG PAUSE] Pausing before step {i+1}, reason={reason}", flush=True)
                log(run_id, "info", f"[DEBUG] Paused before step {i+1} ({reason})", i)
                cmd = debug_wait_for_command(run_id, i, resolved_vars, reason=reason)
                print(f"[DEBUG RESUME] step {i+1} got command: {cmd}", flush=True)

                if cmd == "stop":
                    log(run_id, "info", "[DEBUG] Run stopped by user")
                    debug_broadcast(run_id, "debug_stopped", {"step_index": i})
                    return results

                if cmd == "skip":
                    log(run_id, "info", f"[DEBUG] Skipped step {i+1}")
                    debug_broadcast(run_id, "line_skipped", {"step_index": i})
                    results.append({"status": "skipped", "step": i})
                    i += 1
                    continue

                if cmd == "continue":
                    # Turn off step mode — run freely until next breakpoint
                    DEBUG_STEP_MODE = False

                # "step" → execute this step then pause again (stay in step mode)

            # Slow-mo delay (only when NOT pausing — otherwise user controls timing)
            if not should_pause and DEBUG_SLOW_MO > 0:
                time.sleep(DEBUG_SLOW_MO / 1000.0)

        step_start_ms = int(time.time() * 1000)
        result = run_step(page, step, run_id, i, resolved_vars)
        step_dur_ms = int(time.time() * 1000) - step_start_ms
        results.append(result)

        if DEBUG_MODE:
            # Capture URL and screenshot after step completes
            current_url = ""
            try: current_url = page.url if page else ""
            except: pass

            screenshot_b64 = ""
            try:
                if page:
                    sc_bytes = page.screenshot(full_page=False)
                    screenshot_b64 = base64.b64encode(sc_bytes).decode("utf-8")
            except: pass

            var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}

            if result["status"] == "failed":
                debug_broadcast(run_id, "line_error", {
                    "step_index": i,
                    "error": result.get("error", "Unknown error"),
                    "duration_ms": step_dur_ms,
                    "screenshot": screenshot_b64,
                    "url": current_url,
                    "variables": var_snapshot
                })
                # Always pause on error — wait for user to decide continue or stop
                cmd = debug_wait_for_command(run_id, i, resolved_vars, reason="error")
                if cmd == "stop":
                    debug_broadcast(run_id, "debug_stopped", {"step_index": i})
                    return results
                # Any other command → continue (error step already failed, move on)
            else:
                debug_broadcast(run_id, "line_done", {
                    "step_index": i,
                    "duration_ms": step_dur_ms,
                    "screenshot": screenshot_b64,
                    "url": current_url,
                    "variables": var_snapshot
                })

        if result["status"] == "failed" and not continue_on_fail:
            return results
        i += 1
    return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id",       required=True, type=int)
    parser.add_argument("--config",       required=True)
    parser.add_argument("--debug",        action="store_true", default=False)
    parser.add_argument("--slow-mo",      type=int, default=500)
    parser.add_argument("--breakpoints",  default="")  # comma-separated step indices
    args = parser.parse_args()

    run_id = args.run_id
    config = json.loads(args.config)
    global RUNNER_TOKEN, DEBUG_MODE, DEBUG_SLOW_MO, DEBUG_BREAKPOINTS, DEBUG_STEP_MODE
    RUNNER_TOKEN    = config.get("runner_token", "")
    DEBUG_MODE      = args.debug
    DEBUG_SLOW_MO   = args.slow_mo
    DEBUG_STEP_MODE = args.debug  # True = pause before every step
    DEBUG_BREAKPOINTS = set(int(x) for x in args.breakpoints.split(",") if x.strip().isdigit())
    if DEBUG_MODE:
        print(f"[debug] Debug mode ON — slow_mo={DEBUG_SLOW_MO}ms breakpoints={DEBUG_BREAKPOINTS}")

    test_type    = config.get("type", "ui")
    steps        = config.get("steps", [])
    browser      = config.get("browser", "chrome")
    base_url     = config.get("base_url", "")
    variables    = config.get("variables", [])
    test_case_id = config.get("test_case_id")  # used for AI heal save-back
    project_id   = config.get("project_id")
    project_vars = config.get("project_vars", {})  # project-level globals (pre-decrypted)

    # Inject _test_case_id into every step so auto-heal can save back to DB
    if test_case_id:
        for s in steps:
            s["_test_case_id"] = test_case_id

    log(run_id, "info", f">> Starting test run #{run_id} — Type: {test_type}, Browser: {browser}")
    if DEBUG_MODE:
        print(f"[DEBUG STARTUP] run_id={run_id} DEBUG_MODE={DEBUG_MODE} DEBUG_STEP_MODE={DEBUG_STEP_MODE} breakpoints={DEBUG_BREAKPOINTS} steps={len(steps)}", flush=True)

    # NOTE: We do NOT pre-bake variables into step text here.
    # {{placeholders}} are kept intact and resolved at runtime by apply_variables()
    # inside run_step(). This allows random vars to regenerate on every loop iteration.
    if variables:
        log(run_id, "info", f"[VAR] {len(variables)} variable(s) will be resolved at runtime per step")

    # Update run status to running
    try:
        requests.patch(f"{API_BASE}/api/runs/{run_id}", json={"status": "running", "started_at": datetime.utcnow().isoformat()}, timeout=5)
    except: pass

    step_results = []
    start_time   = time.time()

    try:
        if test_type == "api":
            step_results = run_api_test(config.get("api_config", {}), run_id)
        else:
            # UI test with Playwright
            with sync_playwright() as p:
                # Browser selection
                browser_map = {
                    "chrome":  p.chromium,
                    "firefox": p.firefox,
                    "edge":    p.chromium,
                    "safari":  p.webkit,
                }
                br = browser_map.get(browser, p.chromium)

                # Use Playwright's built-in Chromium (no Chrome install needed)
                # Only use channel if explicitly set to edge (uses installed Edge)
                launch_opts = {"headless": not DEBUG_MODE, "slow_mo": DEBUG_SLOW_MO if DEBUG_MODE else 0}
                if browser == "edge":
                    try:
                        launch_opts["channel"] = "msedge"
                        browser_inst = br.launch(**launch_opts)
                    except Exception:
                        # Fall back to built-in chromium if Edge not found
                        launch_opts = {"headless": not DEBUG_MODE, "slow_mo": DEBUG_SLOW_MO if DEBUG_MODE else 0}
                        browser_inst = p.chromium.launch(**launch_opts)
                else:
                    browser_inst = br.launch(**launch_opts)
                context = browser_inst.new_context(
                    viewport={"width": 1280, "height": 720},
                    ignore_https_errors=True
                )
                page = context.new_page()
                page.set_default_timeout(30000)
                page.set_default_navigation_timeout(30000)

                # Start continuous screen capture thread (every 1.5s)
                if DEBUG_MODE or True:  # always capture during runs
                    start_screen_capture(page, run_id, interval=1.5)

                # Navigate to base URL first if provided
                if base_url:
                    try:
                        page.goto(base_url, timeout=30000, wait_until="domcontentloaded")
                        log(run_id, "info", f"Navigated to base URL: {base_url}")
                    except Exception as e:
                        log(run_id, "warn", f"Base URL navigation warning: {str(e)[:100]}")

                # Take initial screenshot
                take_screenshot(page, run_id, "initial")

                # Resolve variables — project globals (lowest priority) merged with test vars
                resolved_vars = {}
                # 1. Start with project-level globals
                if project_vars:
                    resolved_vars.update(project_vars)
                    log(run_id, "info", f"🌐 Project variables loaded: {', '.join(project_vars.keys())}")
                # 2. Test-level variables override project vars
                test_resolved = resolve_variables(config.get("variables", []))
                resolved_vars.update(test_resolved)
                if test_resolved:
                    log(run_id, "info", f"⚙️ Test variables: {', '.join(f'{k}={str(v)[:20]}' for k,v in test_resolved.items())}")

                # Run all steps — with full control flow (loops, IF, switch)
                step_results = run_steps_with_flow(
                    page, steps, run_id, resolved_vars, config,
                    continue_on_fail=config.get("continue_on_fail", False),
                    variables=config.get("variables", [])
                )
                stop_screen_capture()  # Stop continuous capture when steps done

                # Persist runtime variable changes back to project DB
                if project_id and project_vars:
                    try:
                        import requests as _req, os as _os
                        runtime_updates = {}
                        for k, v in resolved_vars.items():
                            # Only persist vars that were project-level runtime vars and changed
                            if k in project_vars and str(project_vars.get(k,"")) != str(v):
                                runtime_updates[k] = v
                        if runtime_updates:
                            base = _os.environ.get("API_BASE_URL", "http://localhost:6001")
                            _req.patch(
                                f"{base}/api/projects/{project_id}/variables/runtime",
                                json={"updates": runtime_updates, "runner_token": RUNNER_TOKEN},
                                timeout=10
                            )
                            log(run_id, "info", f"🔄 Persisted {len(runtime_updates)} runtime variable(s): {', '.join(runtime_updates.keys())}")
                    except Exception as _e:
                        log(run_id, "warn", f"Could not persist runtime vars: {_e}")

                # Take final screenshot
                take_screenshot(page, run_id, "final")
                browser_inst.close()

    except Exception as e:
        error_msg = traceback.format_exc()
        log(run_id, "error", f"[FAIL] Test runner crashed: {error_msg[:500]}")
        step_results.append({"status": "failed", "step": 0, "error": str(e)})

    # Calculate final results
    duration    = int((time.time() - start_time) * 1000)
    passed      = sum(1 for r in step_results if r["status"] == "passed")
    failed      = sum(1 for r in step_results if r["status"] == "failed")
    # "passed" only if steps ran AND none failed
    # "error" if no steps ran at all (runner crashed before executing anything)
    # "failed" if steps ran but some failed
    if len(step_results) == 0:
        final_status = "error"
    elif failed == 0:
        final_status = "passed"
    else:
        final_status = "failed"

    log(run_id, "info", f"{'[OK] PASSED' if final_status=='passed' else '[FAIL] FAILED'} — {passed}/{len(step_results)} steps passed in {duration}ms")
    # Mark debug run as finished in DB
    if DEBUG_MODE:
        try:
            requests.patch(
                f"{API_BASE}/api/runs/{run_id}/finish-debug",
                json={"status": final_status, "duration": duration},
                timeout=5
            )
        except Exception:
            pass

    # Update final run status
    try:
        requests.patch(f"{API_BASE}/api/runs/{run_id}", json={
            "status":       final_status,
            "duration_ms":  duration,
            "steps_total":  len(step_results),
            "steps_passed": passed,
            "steps_failed": failed,
            "finished_at":  datetime.utcnow().isoformat()
        }, timeout=5)
    except Exception as e:
        print(f"Failed to update run status: {e}")

    sys.exit(0 if final_status == "passed" else 1)


if __name__ == "__main__":
    main()
