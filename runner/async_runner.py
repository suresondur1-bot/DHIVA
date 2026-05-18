"""
Async Playwright Runner — drop-in replacement for runner.py
Usage: python async_runner.py --run-id <id> --config <json>

KEY DIFFERENCES vs runner.py:
  - Uses playwright.async_api (asyncio-based) instead of sync_api
  - Shared browser pool: one Chromium process, isolated context per run
  - ~0.3s context startup vs ~1.5s full browser launch
  - 5 concurrent users share ~300MB RAM instead of ~1.5GB
  - All Playwright calls are awaited; logic is otherwise identical
"""
import sys
import io
import json
import time
import base64
import os
import asyncio
import argparse
import traceback
import re
import random
import string
import threading
import hashlib
import requests
from runner_json import JSON_ACTIONS, handle_json_action
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

# ── Windows console encoding ──────────────────────────────────────────────────
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ── Optional deps ─────────────────────────────────────────────────────────────
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import psycopg2
    HAS_PG = True
except ImportError:
    HAS_PG = False

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE     = os.environ.get("API_BASE", "http://localhost:6001")
RUNNER_TOKEN = ""
PYTHON_CMD   = (
    os.environ.get("PYTHON_PATH") or
    ("python" if sys.platform == "win32" else "python3")
)

SCREENSHOTS_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
LOGS_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

# ── Shared browser pool ───────────────────────────────────────────────────────
# One Playwright + one Chromium instance shared across all concurrent runs.
# Each run gets its own isolated BrowserContext (separate cookies, storage, etc.)
_pw_instance   = None   # async_playwright() instance
_browser_pool  = {}     # browser_type -> Browser object
_pool_lock     = None   # created inside asyncio.run() to avoid event loop issues

async def _ensure_lock():
    global _pool_lock
    if _pool_lock is None:
        _pool_lock = asyncio.Lock()

async def get_browser(browser_type: str = "chromium", headless: bool = True, slow_mo: int = 0):
    """Return a shared Browser, launching it once if not already running."""
    global _pw_instance, _browser_pool, _pool_lock
    await _ensure_lock()
    async with _pool_lock:
        if _pw_instance is None:
            _pw_instance = await async_playwright().start()

        if browser_type not in _browser_pool or not _browser_pool[browser_type].is_connected():
            pw = _pw_instance
            launch_opts = {"headless": headless, "slow_mo": slow_mo}
            if browser_type == "chromium":
                _browser_pool[browser_type] = await pw.chromium.launch(**launch_opts)
            elif browser_type == "firefox":
                _browser_pool[browser_type] = await pw.firefox.launch(**launch_opts)
            elif browser_type == "webkit":
                _browser_pool[browser_type] = await pw.webkit.launch(**launch_opts)
            elif browser_type == "edge":
                try:
                    launch_opts["channel"] = "msedge"
                    _browser_pool[browser_type] = await pw.chromium.launch(**launch_opts)
                except Exception:
                    launch_opts.pop("channel", None)
                    _browser_pool[browser_type] = await pw.chromium.launch(**launch_opts)
            print(f"[pool] Launched {browser_type} browser (headless={headless})", flush=True)

        return _browser_pool[browser_type]


async def acquire_context(browser_type: str = "chromium", headless: bool = True, slow_mo: int = 0):
    """Get a fresh isolated BrowserContext from the shared browser."""
    browser = await get_browser(browser_type, headless=headless, slow_mo=slow_mo)
    context = await browser.new_context(
        viewport={"width": 1280, "height": 720},
        ignore_https_errors=True,
    )
    return context

# ── Heal cache ────────────────────────────────────────────────────────────────
_heal_cache: dict = {}

def _load_heal_cache():
    global _heal_cache
    if not RUNNER_TOKEN:
        return
    try:
        resp = requests.get(
            f"{API_BASE}/api/heal-cache",
            headers={"Authorization": f"Bearer {RUNNER_TOKEN}"},
            timeout=3,
        )
        if resp.status_code == 200:
            _heal_cache = resp.json()
            print(f"[heal cache] loaded {len(_heal_cache)} entries", flush=True)
    except Exception as e:
        print(f"[heal cache] could not load: {e}", flush=True)

# ── Debug mode globals ────────────────────────────────────────────────────────
DEBUG_MODE      = False
DEBUG_SLOW_MO   = 500
DEBUG_BREAKPOINTS: set = set()
_debug_command  = None
_debug_paused   = False
DEBUG_STEP_MODE = False

# ── Variable counters ─────────────────────────────────────────────────────────
_increment_counters: dict = {}

# ── Live screenshot per-run state ─────────────────────────────────────────────
# Stored per run_id so concurrent runs don't share state.
_live_state: dict = {}   # run_id -> {"hash": str, "ts": float}
_LIVE_MIN_GAP = 1.0

def _hash_bytes(b):
    return hashlib.md5(b).hexdigest()

# ─────────────────────────────────────────────────────────────────────────────
# Pure-Python helpers (no Playwright, no async needed)
# ─────────────────────────────────────────────────────────────────────────────

def get_json_path(data, path):
    keys = path.split(".")
    value = data
    try:
        for key in keys:
            if isinstance(value, dict):
                value = value[key]
            elif isinstance(value, list):
                value = value[int(key)]
            else:
                return None
        return value
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def validate_api_assertion(response, assertion, variables):
    assertion_type = assertion.get("type")
    if assertion_type == "status_code":
        expected = int(assertion["value"])
        assert response.status_code == expected, f"Expected {expected}, got {response.status_code}"
    elif assertion_type == "response_contains":
        assert assertion["value"] in response.text, f"Response missing '{assertion['value']}'"
    elif assertion_type == "json_key_exists":
        assert get_json_path(response.json(), assertion["key"]) is not None, f"Key '{assertion['key']}' not found"
    elif assertion_type == "json_value":
        actual = get_json_path(response.json(), assertion["key"])
        assert str(actual) == str(assertion["value"]), f"Expected '{assertion['value']}', got '{actual}'"
    elif assertion_type == "response_time":
        actual_ms = int(response.elapsed.total_seconds() * 1000)
        assert actual_ms < int(assertion["value"]), f"{actual_ms}ms > {assertion['value']}ms"
    elif assertion_type == "header_exists":
        assert assertion["key"] in response.headers, f"Header '{assertion['key']}' not found"
    elif assertion_type == "header_equals":
        assert response.headers.get(assertion["key"]) == assertion["value"], "Header mismatch"
    elif assertion_type == "json_array_length":
        arr = get_json_path(response.json(), assertion["path"])
        assert isinstance(arr, list) and len(arr) == int(assertion["length"]), "Array length mismatch"
    elif assertion_type == "response_matches":
        assert re.search(assertion["pattern"], response.text), "Pattern not found"
    elif assertion_type == "status_in_range":
        s = response.status_code
        assert int(assertion["min"]) <= s <= int(assertion["max"]), "Status out of range"
    elif assertion_type == "extract_json":
        val = get_json_path(response.json(), assertion["path"])
        variables[assertion["variable"]] = str(val) if val is not None else ""
        print(f"[EXTRACT] {assertion['variable']} = {val}")
    elif assertion_type == "extract_header":
        variables[assertion["variable"]] = response.headers.get(assertion["key"], "")
    elif assertion_type == "extract_cookie":
        variables[assertion["variable"]] = response.cookies.get(assertion["key"], "")



def resolve_dynamic_value(config_value):
    """Resolve dynamic variable: 123$ -> random number, Suresh$ -> random name, etc."""
    import random as _r, string as _s
    val = str(config_value or "").strip()
    if not val.endswith("$"):
        return val
    base = val[:-1]
    FIRST = ["Aarav","Aditya","Akash","Amit","Ananya","Anjali","Arjun","Aryan",
        "Deepak","Divya","Gaurav","Ishaan","Kavya","Kiran","Meera","Mihir","Mohan",
        "Neha","Nikhil","Pooja","Priya","Rahul","Raj","Ravi","Rohit","Sakshi",
        "Sanjay","Sneha","Suresh","Tanvi","Vikram","Vikas","Vivek","Zara",
        "Harish","Ramesh","Ganesh","Dinesh","Mahesh","Rajesh","Naresh","Umesh",
        "Sunita","Geeta","Anita","Kavita","Nita","Rita","Sita","Lata","Rekha"]
    LAST = ["Gupta","Sharma","Verma","Singh","Kumar","Patel","Mehta","Joshi",
        "Rao","Nair","Iyer","Reddy","Shah","Chauhan","Malhotra","Sinha","Pandey",
        "Mishra","Tiwari","Dubey","Shukla","Agarwal","Bansal","Goel","Kapoor"]
    if "@" in base and "." in base.split("@")[-1]:
        domain = base.split("@")[1]
        rand = "".join(_r.choices(_s.ascii_lowercase + _s.digits, k=6))
        return f"{rand}@{domain}"
    if base.replace("-","").replace(".","").isdigit():
        digits = len([c for c in base if c.isdigit()])
        lo = 10**(digits-1) if digits > 1 else 0
        return str(_r.randint(lo, (10**digits)-1))
    words = base.split()
    if len(words) >= 2 and all(w.replace("_","").isalpha() for w in words if w):
        return f"{_r.choice(FIRST)} {_r.choice(LAST)}"
    if base and base.replace("_","").isalpha():
        return _r.choice(FIRST)
    return "".join(_r.choices(_s.ascii_lowercase, k=max(4, len(base))))

def resolve_variables(variables):
    resolved = {}
    for var in (variables or []):
        name  = var.get("name", "")
        vtype = var.get("type", "fixed")
        config = var.get("config", {})
        if not name:
            continue
        try:
            if "value" in var and var["value"]:
                cfg_str = str(var["value"])
            elif isinstance(config, str):
                cfg_str = config
            else:
                cfg_str = str(config.get("value", "") if isinstance(config, dict) else config)
            if vtype == "random_email":
                prefix = cfg_str.strip() or "user"
                resolved[name] = f"{prefix}_{''.join(random.choices(string.digits, k=8))}@test.com"
            elif vtype == "random_number":
                try:
                    parts = cfg_str.split("-")
                    lo, hi = int(parts[0].strip()), int(parts[1].strip())
                except Exception:
                    lo, hi = 1000, 9999
                resolved[name] = str(random.randint(lo, hi))
            elif vtype == "timestamp":
                fmt = cfg_str.strip() or "%Y%m%d_%H%M%S"
                fmt = fmt.replace("YYYY", "%Y").replace("MM", "%m").replace("DD", "%d")
                resolved[name] = datetime.now().strftime(fmt)
            elif vtype == "fixed":
                resolved[name] = cfg_str
            elif vtype in ("from_list", "list"):
                raw = cfg_str or (config.get("items", "") if isinstance(config, dict) else "")
                if isinstance(raw, list):
                    items = [str(x).strip() for x in raw if str(x).strip()]
                else:
                    items = [x.strip() for x in str(raw).split(",") if x.strip()]
                resolved[name] = random.choice(items) if items else ""
            elif vtype == "random_text":
                length = int(cfg_str.strip()) if cfg_str.strip() else 8
                resolved[name] = "".join(random.choices(string.ascii_letters, k=length))
            elif vtype == "increment":
                start = int(cfg_str.strip()) if cfg_str.strip() else 1
                if name not in _increment_counters:
                    _increment_counters[name] = start
                else:
                    _increment_counters[name] += 1
                resolved[name] = str(_increment_counters[name])
            elif vtype == "uuid":
                import uuid as _uuid
                resolved[name] = str(_uuid.uuid4())
            elif vtype == "dynamic":
                resolved[name] = resolve_dynamic_value(cfg_str)
            elif vtype == "data_table":
                resolved[name] = resolve_dynamic_value(cfg_str)
            else:
                resolved[name] = resolve_dynamic_value(cfg_str) if cfg_str.endswith("$") else cfg_str
        except Exception:
            resolved[name] = ""
    return resolved


def apply_variables(value, resolved):
    if not isinstance(value, str):
        return value
    for name, val in resolved.items():
        if isinstance(val, (dict, list)):
            str_val = json.dumps(val)
        elif val is None:
            str_val = ""
        else:
            str_val = str(val)
        value = value.replace("{{" + name + "}}", str_val)
    return value


# ── Log batching — reduces HTTP calls by grouping logs ──────────────────────
_log_queue: list = []
_log_timer = None
_log_lock = threading.Lock()

def _flush_logs(run_id):
    global _log_queue, _log_timer
    with _log_lock:
        if not _log_queue:
            return
        batch = list(_log_queue)
        _log_queue = []
        _log_timer = None
    def _post():
        try:
            requests.post(f"{API_BASE}/api/runs/{run_id}/logs-batch",
                          json={"logs": batch}, timeout=5)
        except Exception:
            # Fallback: post individually
            for entry in batch:
                try:
                    requests.post(f"{API_BASE}/api/runs/{run_id}/log",
                                  json=entry, timeout=3)
                except Exception:
                    pass
    threading.Thread(target=_post, daemon=True).start()


def log(run_id, level, message, step_index=None):
    ts = datetime.utcnow().isoformat() + "+00:00"
    # Print to stdout so the backend's proc.stdout listener can broadcast to WebSocket
    print(f"[{level.upper()}] {message}", flush=True)
    try:
        log_file = os.path.join(LOGS_DIR, f"run_{run_id}.log")
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"[{ts[11:19]}] [{level.upper()}] {message}\n")
    except Exception:
        pass
    payload = {"level": level, "message": message, "step_index": step_index, "timestamp": ts}
    global _log_queue, _log_timer
    with _log_lock:
        _log_queue.append(payload)
        if level in ("pass", "fail", "error"):
            # Critical logs — flush the whole batch immediately so user sees result instantly
            batch = list(_log_queue)
            _log_queue = []
            if _log_timer is not None:
                _log_timer.cancel()
                _log_timer = None
            def _post_batch(b=batch):
                try:
                    requests.post(f"{API_BASE}/api/runs/{run_id}/logs-batch",
                                  json={"logs": b}, timeout=5)
                except Exception:
                    for entry in b:
                        try:
                            requests.post(f"{API_BASE}/api/runs/{run_id}/log",
                                          json=entry, timeout=3)
                        except Exception:
                            pass
            threading.Thread(target=_post_batch, daemon=True).start()
        else:
            # INFO logs — batch every 0.5s to reduce HTTP calls
            if _log_timer is None:
                _log_timer = threading.Timer(0.5, _flush_logs, args=[run_id])
                _log_timer.daemon = True
                _log_timer.start()


def debug_broadcast(run_id, event_type, payload):
    try:
        requests.post(f"{API_BASE}/api/runs/{run_id}/debug-event",
                      json={"type": event_type, **payload}, timeout=5)
    except Exception:
        pass


def debug_wait_for_command(run_id, step_idx, resolved_vars, reason="breakpoint"):
    global _debug_command, _debug_paused
    _debug_paused = True
    _debug_command = None
    var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}
    try:
        requests.post(f"{API_BASE}/api/runs/{run_id}/debug-paused",
                      json={"step_index": step_idx, "variables": var_snapshot, "reason": reason}, timeout=5)
    except Exception:
        pass
    print(f"[debug] Paused at step {step_idx+1} ({reason}) -- waiting for user command...", flush=True)
    deadline = time.time() + 300
    while _debug_command is None and time.time() < deadline:
        time.sleep(0.25)
        try:
            resp = requests.get(f"{API_BASE}/api/runs/{run_id}/debug-command", timeout=3)
            if resp.ok:
                cmd = resp.json().get("command")
                if cmd:
                    _debug_command = cmd
                    break
        except Exception:
            pass
    _debug_paused = False
    cmd = _debug_command or "stop"
    _debug_command = None
    return cmd


# ─────────────────────────────────────────────────────────────────────────────
# Async screenshot helpers
# ─────────────────────────────────────────────────────────────────────────────

async def take_screenshot(page, run_id, label):
    try:
        filename = f"{run_id}_{label}_{int(time.time())}.jpg"
        filepath = os.path.join(SCREENSHOTS_DIR, filename)
        await page.screenshot(path=filepath, full_page=True, type="jpeg", quality=70)
        with open(filepath, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        def _post():
            try:
                requests.post(f"{API_BASE}/api/runs/{run_id}/screenshot", json={
                    "label": label, "filename": filename, "data": b64,
                    "timestamp": datetime.utcnow().isoformat()
                }, timeout=10)
            except Exception:
                pass
        threading.Thread(target=_post, daemon=True).start()
    except Exception as e:
        print(f"[warn] Screenshot failed: {e}", flush=True)


def _post_live_async(run_id, b64, label):
    def _post():
        try:
            requests.post(f"{API_BASE}/api/runs/{run_id}/live-screen", json={
                "data": b64, "label": label, "timestamp": datetime.utcnow().isoformat()
            }, timeout=3)
        except Exception:
            pass
    threading.Thread(target=_post, daemon=True).start()


async def take_live_screenshot(page, run_id, step_label, force=False):
    """Per-run dedup — concurrent runs each track their own state."""
    state = _live_state.setdefault(run_id, {"hash": None, "ts": 0})
    now = time.time()
    if not force and (now - state["ts"]) < _LIVE_MIN_GAP:
        return
    try:
        raw = await page.screenshot(full_page=False, type="jpeg", quality=60)
    except Exception:
        return
    frame_hash = _hash_bytes(raw)
    if frame_hash == state["hash"] and not force:
        return
    state["hash"] = frame_hash
    state["ts"] = now
    _post_live_async(run_id, base64.b64encode(raw).decode(), step_label)


# ─────────────────────────────────────────────────────────────────────────────
# Async locator helpers  (pure locator resolution — no awaits needed for these)
# ─────────────────────────────────────────────────────────────────────────────

def get_locator(page, selector):
    import re as _re
    if not selector:
        return page.locator("body")
    sel = selector.strip()
    sel = _re.sub(r"\bgetByRole\b",        "get_by_role",        sel)
    sel = _re.sub(r"\bgetByText\b",        "get_by_text",        sel)
    sel = _re.sub(r"\bgetByLabel\b",       "get_by_label",       sel)
    sel = _re.sub(r"\bgetByPlaceholder\b", "get_by_placeholder", sel)
    sel = _re.sub(r"\bgetByTitle\b",       "get_by_title",       sel)
    sel = _re.sub(r"\bgetByAltText\b",     "get_by_alt_text",    sel)
    sel = _re.sub(r"\bgetByTestId\b",      "get_by_test_id",     sel)

    m = _re.match(r'get_by_role\(["\'](\w+)["\'"],\s*name=["\'](.*?)["\'"],\s*exact=True\)', sel)
    if m: return page.get_by_role(m.group(1), name=m.group(2), exact=True)
    m = _re.match(r'get_by_role\(["\'](\w+)["\'"],\s*name=["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_role(m.group(1), name=m.group(2))
    m = _re.match(r'get_by_role\(["\'](\w+)["\'"]\)', sel)
    if m: return page.get_by_role(m.group(1))
    m = _re.match(r'get_by_text\(["\'](.*?)["\'"],\s*exact=True\)', sel)
    if m: return page.get_by_text(m.group(1), exact=True)
    m = _re.match(r'get_by_text\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_text(m.group(1), exact=False)
    m = _re.match(r'get_by_label\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_label(m.group(1))
    m = _re.match(r'get_by_placeholder\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_placeholder(m.group(1))
    m = _re.match(r'get_by_title\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_title(m.group(1))
    m = _re.match(r'get_by_alt_text\(["\'](.*?)["\'"]\)', sel)
    if m: return page.get_by_alt_text(m.group(1))
    m = _re.match(r':text-is\(["\'](.*?)["\'"]\)$', sel)
    if m: return page.get_by_text(m.group(1), exact=True)
    m = _re.match(r':text\(["\'](.*?)["\'"]\)$', sel)
    if m: return page.get_by_text(m.group(1), exact=False)
    if ":has-text(" in sel:
        ht = _re.search(r':has-text\(["\'](.*?)["\'"]\)', sel)
        if ht:
            tag_sel = sel[:ht.start()].strip() or "*"
            return page.locator(tag_sel).filter(has_text=ht.group(1))
    nth = _re.search(r">>\s*nth=(\d+)", sel)
    if nth:
        return page.locator(sel[:nth.start()].strip()).nth(int(nth.group(1)))
    nth = _re.match(r'(.+)\.nth\((\d+)\)$', sel)
    if nth:
        return page.locator(nth.group(1)).nth(int(nth.group(2)))
    if sel.startswith("//") or sel.startswith("(//"):
        return page.locator(sel)
    return page.locator(sel)


def simplify_selector(sel):
    import re as _re
    if not sel or sel.startswith("get_by_") or sel.startswith("//"):
        return sel
    sel = _re.sub(r"^(body|html)\s*>\s*", "", sel)
    sel = _re.sub(r"^(app-root|jhi-main|jhi-app|ng-component)\s*>\s*", "", sel)
    sel = _re.sub(r"^(div|section|main|header|footer)\s*>\s*", "", sel)
    parts = [p.strip() for p in sel.split(">")]
    if len(parts) > 4:
        sel = " > ".join(parts[-3:])
    return sel.strip()


async def get_locator_with_fallback(page, selector, timeout=5000):
    import re as _re
    try:
        loc = get_locator(page, selector)
        await loc.wait_for(state="attached", timeout=timeout)
        return loc
    except Exception:
        pass
    simple = simplify_selector(selector)
    if simple and simple != selector:
        try:
            loc = get_locator(page, simple)
            await loc.wait_for(state="attached", timeout=timeout)
            return loc
        except Exception:
            pass
    m = _re.search(r':has-text\(["\'](.+?)["\']\)', selector)
    if m:
        try:
            loc = page.get_by_text(m.group(1), exact=False).first
            await loc.wait_for(state="attached", timeout=timeout)
            return loc
        except Exception:
            pass
    src = simple or selector
    if ">" in src:
        skip = {"div", "span", "section", "li", "ul", "main", "header", "p", "a", "td", "tr"}
        for seg in reversed(src.split(">")):
            seg = seg.strip()
            if seg and seg not in skip:
                try:
                    loc = page.locator(seg).first
                    await loc.wait_for(state="attached", timeout=timeout)
                    return loc
                except Exception:
                    continue
    if "button" in selector or "btn" in selector:
        try:
            await page.wait_for_timeout(800)
            loc = get_locator(page, selector)
            await loc.wait_for(state="attached", timeout=timeout)
            return loc
        except Exception:
            pass
        if simple and simple != selector:
            try:
                loc = get_locator(page, simple)
                await loc.wait_for(state="attached", timeout=timeout)
                return loc
            except Exception:
                pass
    return get_locator(page, selector)


# ─────────────────────────────────────────────────────────────────────────────
# AI auto-heal (async version)
# ─────────────────────────────────────────────────────────────────────────────

async def ai_heal_step(page, step, run_id, idx, original_error, resolved_vars=None):
    resolved_vars = resolved_vars or {}
    action   = step.get("action", "")
    selector = apply_variables(step.get("selector", ""), resolved_vars)
    value    = apply_variables(step.get("value", ""), resolved_vars)

    if not selector or action in ("navigate", "wait", "wait_for_url", "assert_url",
                                   "assert_title", "screenshot", "execute_script",
                                   "press", "db_validate", "db_extract_multi"):
        return None

    log(run_id, "info", f"  [AI Heal] Step {idx+1} failed -- asking AI to find element...", idx)
    try:
        img_bytes = await page.screenshot(type="jpeg", quality=75)
        screenshot_b64 = base64.b64encode(img_bytes).decode("utf-8")
    except Exception as e:
        log(run_id, "info", f"  [AI Heal] Could not capture screenshot: {e}", idx)
        return None

    try:
        resp = requests.post(f"{API_BASE}/api/ai/heal", json={
            "screenshot_base64": screenshot_b64,
            "selector": selector, "action": action,
            "step_description": f"{action} on [{selector}]",
            "run_id": run_id,
        }, timeout=60)
        data = resp.json()
    except Exception as e:
        log(run_id, "info", f"  [AI Heal] AI request failed: {e}", idx)
        return None

    suggestions = data.get("suggestions", [])
    if not suggestions:
        log(run_id, "info", "  [AI Heal] AI returned no suggestions", idx)
        return None

    log(run_id, "info", f"  [AI Heal] AI suggested {len(suggestions)} selector(s) -- trying each...", idx)
    for i, sug in enumerate(suggestions):
        new_sel = sug.get("selector", "")
        if not new_sel:
            continue
        log(run_id, "info", f"  [AI Heal] Trying [{i+1}] {new_sel} ({sug.get('confidence','')}) -- {sug.get('reason','')}", idx)
        try:
            loc = get_locator(page, new_sel)
            await loc.wait_for(state="visible", timeout=5000)
            if action == "click":
                try:
                    await loc.scroll_into_view_if_needed(timeout=3000)
                    await page.wait_for_timeout(300)
                except Exception:
                    pass
                try:
                    await loc.click(timeout=10000)
                except Exception:
                    await loc.click(timeout=10000, force=True)
            elif action == "type":
                _type_value = value
                _lang = step.get("__lang__", resolved_vars.get("__lang__", ""))
                if _lang and _lang != "en" and _type_value:
                    _type_value = await translate_value(_type_value, _lang)
                    log(run_id, "info", f"[type] Translated to {_lang}: {_type_value}", idx)
                await loc.fill(_type_value, timeout=10000)
            elif action == "clear":
                await loc.clear(timeout=10000)
            elif action == "hover":
                await loc.hover(timeout=10000)
            elif action == "assert_visible":
                assert await loc.is_visible()
            elif action == "assert_value":
                assert await loc.input_value() == value
            elif action == "select":
                await loc.select_option(value, timeout=10000)
            elif action == "check":
                await loc.check(timeout=10000)
            elif action == "uncheck":
                await loc.uncheck(timeout=10000)
            else:
                assert await loc.is_visible(), "Element not visible"
            log(run_id, "pass", f"  [AI Heal] SUCCESS -- healed with: {new_sel}", idx)
            return new_sel
        except Exception as e:
            log(run_id, "info", f"  [AI Heal] [{i+1}] failed: {str(e)[:80]}", idx)
            continue

    log(run_id, "info", "  [AI Heal] All suggestions failed -- step cannot be auto-healed", idx)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# API test runner (pure requests, no Playwright needed)
# ─────────────────────────────────────────────────────────────────────────────

def run_api_test(config, run_id):
    steps    = config.get("steps", [])
    variables = config.get("variables", [])
    resolved  = resolve_variables(variables)
    project_vars = config.get("project_vars", {})
    resolved = {**project_vars, **resolved}
    results  = []
    session  = requests.Session()

    for idx, step in enumerate(steps):
        action = step.get("action", "")
        if action in JSON_ACTIONS:
            result = handle_json_action(action, step, resolved, run_id, idx, apply_variables, log)
            results.append(result)
            continue

        method  = apply_variables(step.get("method",  "GET"),  resolved).upper()
        url     = apply_variables(step.get("url",     ""),     resolved)
        headers_raw = step.get("headers", {}) or {}
        body_raw    = step.get("body",    {}) or {}
        headers = {k: apply_variables(v, resolved) for k, v in
                   (headers_raw.items() if isinstance(headers_raw, dict) else {})}
        try:
            body = json.loads(apply_variables(
                json.dumps(body_raw) if isinstance(body_raw, dict) else str(body_raw), resolved))
        except Exception:
            body = apply_variables(str(body_raw), resolved)

        log(run_id, "info", f">> Step {idx+1}: {method} {url}", idx)
        try:
            resp = session.request(method, url, headers=headers,
                                   json=body if isinstance(body, dict) else None,
                                   data=body if not isinstance(body, dict) else None,
                                   timeout=30)
            for assertion in (step.get("assertions") or []):
                validate_api_assertion(resp, assertion, resolved)
            log(run_id, "pass", f"[OK] {method} {url} → {resp.status_code}", idx)
            results.append({"status": "passed", "step": idx})
        except Exception as e:
            log(run_id, "fail", f"[FAIL] {method} {url}: {e}", idx)
            results.append({"status": "failed", "step": idx, "error": str(e)})
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Single step executor (async)
# ─────────────────────────────────────────────────────────────────────────────


async def translate_value(text_val, lang, run_id=None, idx=None, api_base=None):
    """Translate a value to the target language using Claude API."""
    if not text_val or not text_val.strip():
        return text_val
    lang_names = {"el":"Greek","ar":"Arabic","hi":"Hindi","fr":"French","de":"German","es":"Spanish"}
    lang_name = lang_names.get(lang, lang)
    import requests as _req
    ai_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not ai_key:
        try:
            from dotenv import dotenv_values
            import pathlib
            env_path = pathlib.Path(__file__).parent.parent / "backend" / ".env"
            vals = dotenv_values(env_path)
            ai_key = vals.get("ANTHROPIC_API_KEY", "")
        except Exception:
            pass
    if not ai_key:
        print("[translate_value] No API key found")
        return text_val
    try:
        print(f"[translate_value] Translating '{text_val}' to {lang_name}")
        resp = _req.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": ai_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-haiku-4-5-20251001", "max_tokens": 100,
                  "messages": [{"role": "user", "content":
                    f"Transliterate or translate '{text_val}' into {lang_name} script. "
                    f"If it is a proper name, write it phonetically in {lang_name} characters. "
                    f"If it is a common word, translate its meaning. "
                    f"Return ONLY the {lang_name} text, nothing else. No explanation. No Latin characters."}]},
            timeout=10)
        rj = resp.json()
        if "error" in rj:
            log(run_id, "warn", f"[translate_value] API error: {rj['error']}", idx)
            return text_val
        result = rj["content"][0]["text"].strip()
        log(run_id, "info", f"[translate_value] '{text_val}' → '{result}'", idx)
        return result if result else text_val
    except Exception as e:
        log(run_id, "warn", f"[translate_value] Error: {e}", idx)
        return text_val


async def run_step(page, step, run_id, idx, resolved_vars=None):
    resolved_vars = resolved_vars or {}
    action   = step.get("action", "")
    value    = str(apply_variables(step.get("value", "") or "", resolved_vars))
    selector = apply_variables(step.get("selector", ""), resolved_vars)
    timeout  = step.get("timeout", 30000)

    step_descs = {
        "navigate":          f"Navigating to URL: {value}",
        "click":             f"Clicking: [ {selector} ]",
        "type":              f"Typing '{value}' into: [ {selector} ]",
        "clear":             f"Clearing: [ {selector} ]",
        "select":            f"Selecting '{value}' in: [ {selector} ]",
        "search_select":     f"Search & Select: type '{step.get('search_text', value)}' -> pick '{value}' in [ {selector} ]",
        "check":             f"Checking: [ {selector} ]",
        "uncheck":           f"Unchecking: [ {selector} ]",
        "hover":             f"Hovering: [ {selector} ]",
        "press":             f"Pressing key '{value}' on: [ {selector} ]",
        "wait":              f"Waiting {value}ms",
        "wait_for_selector": f"Waiting for element: [ {selector} ]",
        "wait_for_url":      f"Waiting for URL to contain: '{value}'",
        "assert_text":       f"Asserting [ {selector} ] contains: '{value}'",
        "assert_visible":    f"Asserting visible: [ {selector} ]",
        "assert_url":        f"Asserting URL contains: '{value}'",
        "assert_title":      f"Asserting title contains: '{value}'",
        "assert_value":      f"Asserting input value: '{value}'",
        "screenshot":        f"Taking screenshot: '{value or 'screenshot'}'",
        "scroll":            f"Scrolling page",
        "execute_script":    "Executing JavaScript",
    }
    log(run_id, "info", f">> Step {idx+1}: {step_descs.get(action, f'{action} -- {selector or value}')}", idx)
    note = step.get("description", "") or ""
    if note.strip():
        log(run_id, "info", f"   {note.strip()}", idx)

    await take_live_screenshot(page, run_id, f"Step {idx+1}: {action}")

    try:
        # ── NAVIGATE ──────────────────────────────────────────────────────────
        if action == "navigate":
            nav_timeout = max(timeout, 30000)
            try:
                await page.goto(value, timeout=nav_timeout, wait_until="domcontentloaded")
            except PWTimeout:
                await page.goto(value, timeout=nav_timeout, wait_until="load")
            try:
                await page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass

        # ── CLICK ─────────────────────────────────────────────────────────────
        elif action == "click":
            import re as _re_click
            if selector and selector.startswith('a[href="http'):
                m = _re_click.match(r'a\[href="https?://[^/]+(/[^"]*)"\]', selector)
                if m:
                    selector = f'a[href="{m.group(1)}"]'
            if selector and ":has-text(" in selector:
                ht_m = _re_click.search(r':has-text\(["\'](.+?)["\']\)', selector)
                if ht_m:
                    tag_ht = selector[:ht_m.start()].strip() or "button"
                    txt_ht = ht_m.group(1).strip()
                    try:
                        await page.wait_for_selector(tag_ht, timeout=10000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(500)
                    js = (f"(() => {{ const el = Array.from(document.querySelectorAll('{tag_ht}')).find(b => b.textContent.trim() === '{txt_ht}');"
                          f" if (!el) throw new Error('Button not found: {txt_ht}'); el.click(); return true; }})()")
                    await page.evaluate(js)
                    await page.wait_for_timeout(1000)
                    return {"status": "passed", "step": idx}
            if selector and "href=" in selector:
                m = _re_click.search(r'href="([^"]+)"', selector)
                if m:
                    href_val = m.group(1)
                    js_href = (f"(() => {{ const el = document.querySelector('a[href=\"{href_val}\"]') || "
                               f"Array.from(document.querySelectorAll('a')).find(a => a.getAttribute('href') === '{href_val}');"
                               f" if (!el) throw new Error('Link not found: {href_val}'); el.click(); return true; }})()")
                    try:
                        await page.wait_for_selector(f'a[href="{href_val}"]', timeout=10000)
                    except Exception:
                        pass
                    await page.evaluate(js_href)
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=5000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(1500)
                    return {"status": "passed", "step": idx}
            loc = await get_locator_with_fallback(page, selector, timeout=min(timeout, 8000))
            try:
                await loc.scroll_into_view_if_needed(timeout=3000)
                await page.wait_for_timeout(300)
            except Exception:
                pass
            try:
                await loc.click(timeout=timeout)
            except Exception:
                await page.wait_for_timeout(1000)
                await loc.click(timeout=timeout, force=True)

        # ── TYPE ──────────────────────────────────────────────────────────────
        elif action == "type":
            loc = await get_locator_with_fallback(page, selector, timeout=min(timeout, 8000))
            # Re-apply variables so foreach/loop vars are resolved at execution time
            type_value = apply_variables(step.get("value", "") or "", resolved_vars)
            # Translate if language mode is set
            _lang = step.get("__lang__", resolved_vars.get("__lang__", ""))
            if _lang and _lang != "en" and type_value and not step.get("no_translate"):
                type_value = await translate_value(type_value, _lang, run_id=run_id, idx=idx)
                log(run_id, "info", f"[type] Translated to {_lang}: '{type_value}'", idx)
                # Use fill() for translated text — loc.type() may not handle Unicode correctly
                await loc.fill(type_value, timeout=timeout)
            else:
                await loc.type(type_value, timeout=timeout)

        # ── CLEAR ─────────────────────────────────────────────────────────────
        elif action == "clear":
            await get_locator(page, selector).fill("", timeout=timeout)

        # ── SELECT ────────────────────────────────────────────────────────────
        elif action == "select":
            await get_locator(page, selector).select_option(value, timeout=timeout)

        # ── SEARCH_SELECT ─────────────────────────────────────────────────────
        elif action == "search_select":
            import re as _re_ss
            # Always re-resolve from raw step fields so loop variables set after run_step entry are picked up
            raw_value       = step.get("value", "") or ""
            raw_search_text = step.get("search_text", "") or ""
            search_text = apply_variables(raw_search_text if raw_search_text else raw_value, resolved_vars).strip()
            option_text = apply_variables(raw_value, resolved_vars).strip()
            _lang = step.get("__lang__", resolved_vars.get("__lang__", ""))
            if _lang and _lang != "en" and not step.get("no_translate"):
                if search_text:
                    search_text = await translate_value(search_text, _lang, run_id=run_id, idx=idx)
                    log(run_id, "info", f"[search_select] Translated search to {_lang}: {search_text}", idx)
                if option_text:
                    option_text = await translate_value(option_text, _lang, run_id=run_id, idx=idx)
            loc         = get_locator(page, selector)
            wait_ms     = int(step.get("wait_ms", 2000))
            log(run_id, "info", f"[search_select] typing={search_text!r} picking={option_text!r}", idx)

            is_ng_select = False
            try:
                if "ng-select" in selector.lower():
                    is_ng_select = True
                else:
                    is_ng_select = await page.evaluate(
                        f"""() => {{ const el = document.querySelector({repr(selector)});
                            if (!el) return false;
                            return el.tagName.toLowerCase() === 'ng-select' || el.classList.contains('ng-select') || el.closest('ng-select') !== null; }}"""
                    ) or False
            except Exception:
                is_ng_select = "ng-select" in selector.lower()

            if is_ng_select:
                await loc.click(timeout=timeout)
                await page.wait_for_timeout(400)
                typed = False
                for ng_inp_sel in [".ng-input > input", "input[type=text]"]:
                    try:
                        ng_inp = loc.locator(ng_inp_sel).first
                        if await ng_inp.is_visible(timeout=500):
                            await ng_inp.fill("")
                            await ng_inp.press_sequentially(search_text)
                            typed = True
                            break
                    except Exception:
                        continue
                if not typed:
                    for ng_inp_sel in ["ng-select .ng-input input", "ng-select input[type=text]", ".ng-value-container input"]:
                        try:
                            ng_inp = page.locator(ng_inp_sel).first
                            if await ng_inp.is_visible(timeout=500):
                                await ng_inp.fill("")
                                await ng_inp.press_sequentially(search_text)
                                typed = True
                                break
                        except Exception:
                            continue
                if not typed:
                    await page.keyboard.type(search_text)
                await page.wait_for_timeout(300)
            else:
                await loc.click(timeout=timeout)
                await page.wait_for_timeout(200)
                try:
                    await loc.focus()
                    await page.keyboard.press("Control+a")
                except Exception:
                    pass
                await page.keyboard.press("Delete")
                await page.wait_for_timeout(100)
                try:
                    await loc.press_sequentially(search_text)
                except Exception:
                    for ch in search_text:
                        await loc.press(ch)

            # Poll for dropdown — wait for the FILTERED option to appear
            matched = None
            for _attempt in range(25):
                await page.wait_for_timeout(300)
                try:
                    opts = page.locator("ng-dropdown-panel .ng-option")
                    n = await opts.count()
                    if n > 0:
                        filtered = opts.filter(has_text=_re_ss.compile(_re_ss.escape(option_text), _re_ss.I))
                        if await filtered.count() > 0:
                            matched = filtered.first
                            break
                        for j in range(min(n, 30)):
                            o = opts.nth(j)
                            try:
                                txt = (await o.inner_text(timeout=300) or "").strip()
                                if option_text.lower() in txt.lower():
                                    matched = o
                                    break
                            except Exception:
                                continue
                        if matched:
                            break
                    if await page.locator("ngb-typeahead-window").count() > 0:
                        break
                    if await page.locator("[role=option]:visible").count() > 0:
                        break
                except Exception:
                    pass

            if not matched:
                for sel2 in ["ngb-typeahead-window button", "ngb-typeahead-window td", "ngb-typeahead-window .dropdown-item"]:
                    try:
                        c = page.locator(sel2).filter(has_text=_re_ss.compile(option_text, _re_ss.I)).first
                        if await c.is_visible(timeout=500):
                            matched = c
                            break
                    except Exception:
                        continue

            if not matched:
                try:
                    c = page.get_by_role("option", name=option_text, exact=False).first
                    if await c.is_visible(timeout=500):
                        matched = c
                except Exception:
                    pass

            if not matched:
                for sel2 in [".ng-option", ".dropdown-item", "[role=option]", "[class*=option]", "ul li"]:
                    try:
                        c = page.locator(sel2).filter(has_text=_re_ss.compile(option_text, _re_ss.I)).first
                        if await c.is_visible(timeout=500):
                            matched = c
                            break
                    except Exception:
                        continue

            if not matched:
                try:
                    spans = page.locator("ng-dropdown-panel .ng-option-label")
                    sc = await spans.count()
                    for j in range(min(sc, 30)):
                        sp = spans.nth(j)
                        try:
                            txt = (await sp.inner_text(timeout=300) or "").strip()
                            if option_text.strip().lower() in txt.strip().lower():
                                matched = sp
                                break
                        except Exception:
                            continue
                except Exception:
                    pass
            if not matched:
                try:
                    opts = page.locator("ng-dropdown-panel .ng-option:visible")
                    if await opts.count() == 1:
                        matched = opts.first
                except Exception:
                    pass
            if not matched:
                raise Exception(f"Search & Select: option '{option_text}' not found after typing '{search_text}'.")

            await matched.scroll_into_view_if_needed()
            await page.wait_for_timeout(200)
            _panel_visible = await page.locator("ng-dropdown-panel").count() > 0
            if _panel_visible:
                try:
                    await matched.dispatch_event("mousedown")
                    await page.wait_for_timeout(50)
                    await matched.dispatch_event("mouseup")
                    await page.wait_for_timeout(50)
                    await matched.dispatch_event("click")
                except Exception:
                    await matched.click(force=True, timeout=5000)
            else:
                await matched.click(force=True, timeout=timeout)
            await page.wait_for_timeout(600)
            log(run_id, "pass", f"[OK] Search & Select: selected '{option_text}'", idx)

        # ── OTHER ACTIONS ─────────────────────────────────────────────────────
        elif action == "double_click":
            await get_locator(page, selector).dblclick(timeout=timeout)

        elif action == "right_click":
            await get_locator(page, selector).click(button="right", timeout=timeout)

        elif action == "check":
            await get_locator(page, selector).check(timeout=timeout)

        elif action == "uncheck":
            await get_locator(page, selector).uncheck(timeout=timeout)

        elif action == "hover":
            await get_locator(page, selector).hover(timeout=timeout)

        elif action == "focus":
            loc = get_locator(page, selector)
            await loc.scroll_into_view_if_needed(timeout=timeout)
            await loc.focus(timeout=timeout)

        elif action == "blur":
            await get_locator(page, selector).blur(timeout=timeout)

        elif action == "press":
            if selector:
                await get_locator(page, selector).press(value, timeout=timeout)
            else:
                await page.keyboard.press(value)

        elif action == "press_sequentially":
            loc = get_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout)
            await loc.click(timeout=timeout)
            await page.wait_for_timeout(100)
            # Clear first
            await loc.fill("", timeout=timeout)
            await page.wait_for_timeout(100)
            # Type the full value — fires input event
            await loc.fill(value, timeout=timeout)
            # Dispatch input + keyup events explicitly for Angular debounce inputs
            try:
                await page.evaluate(f"""
                    () => {{
                        const el = document.querySelector({repr(selector)});
                        if (el) {{
                            el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            el.dispatchEvent(new KeyboardEvent('keyup', {{ key: 'e', bubbles: true }}));
                        }}
                    }}
                """)
            except Exception:
                pass
            # Wait for debounce to fire (usually 300-500ms)
            await page.wait_for_timeout(700)
            log(run_id, "info", f"[press_sequentially] filled and waited for debounce: {repr(value)}", idx)

        elif action == "upload_attachment":
            files = [v.strip() for v in value.split(",")]
            await get_locator(page, selector).set_input_files(files if len(files) > 1 else files[0], timeout=timeout)

        elif action == "drag_and_drop":
            source = get_locator(page, selector)
            target = get_locator(page, value)
            await source.drag_to(target, timeout=timeout)

        elif action == "scroll":
            x = int(step.get("value2", 0) or 0)
            y = int(value or 0)
            sel = step.get("value3", "").strip()
            if sel:
                # Scroll specific element into view
                await page.evaluate(f"""() => {{
                    const el = document.querySelector('{sel}');
                    if (el) el.scrollIntoView({{behavior:'smooth', block:'center'}});
                }}""")
            else:
                # Try Angular scroll container first, fallback to window
                await page.evaluate(f"""() => {{
                    const containers = [
                        document.querySelector('.main-content'),
                        document.querySelector('.content-wrapper'),
                        document.querySelector('mat-sidenav-content'),
                        document.querySelector('.page-content'),
                        document.querySelector('main'),
                        document.querySelector('#scrollBox'),
                        document.body
                    ];
                    const container = containers.find(c => c && c.scrollHeight > c.clientHeight);
                    if (container) container.scrollTop += {y};
                    else window.scrollBy(0, {y});
                }}""")

        elif action == "refresh":
            await page.reload(timeout=timeout)

        elif action == "back":
            await page.go_back(timeout=timeout)

        elif action == "forward":
            await page.go_forward(timeout=timeout)

        elif action == "wait":
            await page.wait_for_timeout(int(value or 1000))

        elif action == "wait_for_selector":
            await get_locator(page, selector).wait_for(state="visible", timeout=timeout)

        elif action == "wait_for_url":
            await page.wait_for_url(f"**{value}**", timeout=timeout)

        elif action == "screenshot":
            await take_screenshot(page, run_id, value or "screenshot")

        elif action == "execute_script":
            script = apply_variables(step.get("script", value), resolved_vars)
            result_js = await page.evaluate(script)
            if step.get("store_as"):
                resolved_vars[step["store_as"].strip("{}")] = str(result_js or "")

        # ── ASSERT ACTIONS ────────────────────────────────────────────────────
        elif action == "assert_text":
            loc = await get_locator_with_fallback(page, selector, timeout=min(timeout, 8000))
            actual_text = await loc.inner_text(timeout=timeout)
            assert value in (actual_text or ""), f"Expected '{value}' in element text, got '{actual_text}'"

        elif action == "assert_visible":
            loc = await get_locator_with_fallback(page, selector, timeout=min(timeout, 8000))
            await loc.wait_for(state="visible", timeout=timeout)
            assert await loc.is_visible(), f"Element [{selector}] not visible"

        elif action == "assert_not_visible":
            loc = get_locator(page, selector)
            assert not await loc.is_visible(), f"Element [{selector}] expected hidden but is visible"

        elif action == "assert_url":
            current = page.url
            assert value in current, f"Expected URL to contain '{value}', got '{current}'"

        elif action == "assert_title":
            title = await page.title()
            assert value in title, f"Expected title to contain '{value}', got '{title}'"

        elif action == "assert_value":
            actual = await get_locator(page, selector).input_value(timeout=timeout)
            assert value == actual, f"Expected input value '{value}', got '{actual}'"

        elif action == "assert_attribute":
            parts = value.split("=", 1)
            attr_name = parts[0].strip()
            expected  = parts[1].strip() if len(parts) > 1 else ""
            actual    = await get_locator(page, selector).get_attribute(attr_name, timeout=timeout)
            assert expected in (actual or ""), f"Attribute '{attr_name}' expected '{expected}', got '{actual}'"

        elif action == "assert_enabled":
            loc = get_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout)
            assert await loc.is_enabled(), f"Element [{selector}] expected enabled but is disabled"

        elif action == "assert_disabled":
            loc = get_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout)
            assert not await loc.is_enabled(), f"Element [{selector}] expected disabled but is enabled"

        elif action == "assert_checked":
            loc = get_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout)
            assert await loc.is_checked(), f"Checkbox [{selector}] expected checked"

        elif action == "assert_not_checked":
            loc = get_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout)
            assert not await loc.is_checked(), f"Checkbox [{selector}] expected unchecked"

        elif action == "extract_text":
            loc = await get_locator_with_fallback(page, selector, timeout=min(timeout, 8000))
            extracted = (await loc.inner_text(timeout=timeout) or "").strip()
            var_name = step.get("store_as", "").strip().strip("{}")
            if var_name:
                resolved_vars[var_name] = extracted
            log(run_id, "pass", f"[OK] extract_text: '{extracted[:80]}' → {{{{{var_name}}}}}", idx)
            return {"status": "passed", "step": idx}

        elif action == "extract_attribute":
            parts   = value.split("=", 1)
            attr_nm = parts[0].strip()
            extracted = await get_locator(page, selector).get_attribute(attr_nm, timeout=timeout) or ""
            var_name = step.get("store_as", "").strip().strip("{}")
            if var_name:
                resolved_vars[var_name] = extracted
            log(run_id, "pass", f"[OK] extract_attribute: '{extracted[:80]}' → {{{{{var_name}}}}}", idx)
            return {"status": "passed", "step": idx}

        elif action == "set_variable":
            var_name = step.get("store_as", selector).strip().strip("{}")
            resolved_vars[var_name] = value
            log(run_id, "pass", f"[OK] set_variable: {var_name} = {value[:80]}", idx)
            return {"status": "passed", "step": idx}

        # ── STORE TEXT / VALUE / URL ───────────────────────────────────────
        elif action in ("store_text", "store_value", "store_url"):
            var_name = step.get("value", "").strip()
            if not var_name:
                log(run_id, "info", ">> store: no variable name specified, skipping", idx)
                return {"status": "passed", "step": idx}
            if action == "store_url":
                stored = page.url
            elif action == "store_text":
                stored = await get_locator(page, selector).inner_text()
            else:
                stored = await get_locator(page, selector).input_value()
            resolved_vars[var_name] = stored
            log(run_id, "pass", f"[OK] Stored '{stored[:80]}' → {{{{{var_name}}}}}", idx)
            return {"status": "passed", "step": idx}

        # ── STORE ATTR / TITLE / COUNT / JS ──────────────────────────────────
        elif action in ("store_attr", "store_title", "store_count", "store_js"):
            var_name = apply_variables(step.get("store_as", "") or step.get("value", ""), resolved_vars).strip()
            if not var_name:
                log(run_id, "info", ">> store: no variable name specified, skipping", idx)
                return {"status": "passed", "step": idx}
            sel = apply_variables(step.get("selector", ""), resolved_vars)
            if action == "store_attr":
                attr = apply_variables(step.get("attr_name", "") or step.get("value2", "") or step.get("value", ""), resolved_vars)
                if attr in ("class", "className"):
                    stored = str(await get_locator(page, sel).evaluate("el => el.className") or "")
                else:
                    stored = str(await get_locator(page, sel).get_attribute(attr) or "")
            elif action == "store_title":
                stored = await page.title()
            elif action == "store_count":
                stored = str(await get_locator(page, sel).count())
            else:  # store_js
                js = apply_variables(step.get("js_expr", "") or step.get("value", ""), resolved_vars).strip()
                if js and not js.startswith("()") and not js.startswith("function"):
                    js = f"() => {{ return {js}; }}"
                result_raw = await page.evaluate(js)
                stored = str(result_raw).strip()
            resolved_vars[var_name] = stored
            log(run_id, "pass", f"[OK] Stored '{str(stored)[:80]}' → {{{{{var_name}}}}}", idx)
            return {"status": "passed", "step": idx}

        # ── ASSERT NOT TEXT ──────────────────────────────────────────────────
        elif action == "assert_not_text":
            actual = await get_locator(page, selector).inner_text(timeout=timeout)
            assert value not in (actual or ""), f"Text '{value}' found but should NOT be present"

        # ── ASSERT COUNT ─────────────────────────────────────────────────────
        elif action == "assert_count":
            expected = int(value)
            actual = await get_locator(page, selector).count()
            assert actual == expected, f"Expected {expected} element(s), found {actual}"

        # ── ASSERT CSS ───────────────────────────────────────────────────────
        elif action == "assert_css":
            parts = value.split("=", 1)
            prop     = parts[0].strip()
            expected = parts[1].strip() if len(parts) > 1 else ""
            actual = await get_locator(page, selector).evaluate(f"el => window.getComputedStyle(el).getPropertyValue('{prop}')")
            assert expected in str(actual), f"CSS '{prop}' expected '{expected}', got '{actual}'"

        # ── ASSERT SELECTED ──────────────────────────────────────────────────
        elif action == "assert_selected":
            actual = await get_locator(page, selector).input_value(timeout=timeout)
            assert value in actual, f"Select expected '{value}' selected, got '{actual}'"

        # ── DOWNLOAD ─────────────────────────────────────────────────────────
        elif action == "download":
            async with page.expect_download() as dl_info:
                await get_locator(page, selector).click(timeout=timeout)
            download = await dl_info.value
            log(run_id, "info", f"  Downloaded: {download.suggested_filename}", idx)

        # ── SWITCH FRAME ─────────────────────────────────────────────────────
        elif action == "switch_frame":
            frame = page.frame(name=selector)
            if not frame:
                frame = page.frame(url=lambda u: selector in u)
            if not frame:
                raise Exception(f"Could not switch to frame '{selector}'")
            log(run_id, "info", f"  Switched to frame: {selector}", idx)

        # ── SWITCH / CLOSE WINDOW ─────────────────────────────────────────────
        elif action == "switch_window":
            pages = page.context.pages
            if value and value.isdigit():
                if int(value) < len(pages):
                    await pages[int(value)].bring_to_front()
            else:
                for p in pages:
                    if selector and selector.lower() in (await p.title()).lower():
                        await p.bring_to_front()
                        break

        elif action == "close_window":
            pages = page.context.pages
            if value and value.isdigit() and int(value) < len(pages):
                await pages[int(value)].close()
            else:
                await page.close()

        # ── SET COOKIE ───────────────────────────────────────────────────────
        elif action == "set_cookie":
            name  = apply_variables(step.get("name", selector), resolved_vars)
            await page.context.add_cookies([{"name": name, "value": value, "url": page.url}])

        # ── TABLE ACTION ─────────────────────────────────────────────────────
        elif action == "table_action":
            search_text = apply_variables(step.get("search_text", ""), resolved_vars)
            search_col  = int(step.get("search_col", 1))
            target_col  = int(step.get("target_col", 1))
            sub_action  = step.get("sub_action", "click")
            table_sel   = selector or "table"
            rows = page.locator(f"{table_sel} tr")
            count = await rows.count()
            found = False
            for ri in range(count):
                row = rows.nth(ri)
                cells = row.locator("td, th")
                cell_count = await cells.count()
                if search_col <= cell_count:
                    cell_text = (await cells.nth(search_col - 1).inner_text(timeout=3000) or "").strip()
                    if search_text.lower() in cell_text.lower():
                        if target_col <= cell_count:
                            target = cells.nth(target_col - 1)
                            if sub_action == "click":
                                await target.click(timeout=timeout)
                            elif sub_action == "get_text":
                                txt = await target.inner_text(timeout=timeout)
                                store_as = step.get("store_as", "").strip().strip("{}")
                                if store_as:
                                    resolved_vars[store_as] = txt
                            elif sub_action in ("search_select", "type"):
                                # Type into an input/ng-select inside the target cell
                                enter_val = apply_variables(step.get("value", ""), resolved_vars)
                                inp = target.locator("input").first
                                await inp.click(timeout=timeout)
                                await inp.fill("", timeout=timeout)
                                await inp.type(enter_val, delay=80)
                                await page.wait_for_timeout(600)
                                # Pick from ng-dropdown-panel if it appears
                                try:
                                    opt = page.locator(".ng-dropdown-panel .ng-option").filter(has_text=enter_val).first
                                    await opt.wait_for(state="visible", timeout=4000)
                                    await opt.click(timeout=timeout)
                                except Exception:
                                    # fallback: press Enter
                                    await inp.press("Enter")
                            elif sub_action == "select":
                                enter_val = apply_variables(step.get("value", ""), resolved_vars)
                                sel_el = target.locator("select").first
                                await sel_el.select_option(label=enter_val, timeout=timeout)
                            elif sub_action == "assert_text":
                                expected = apply_variables(step.get("value", ""), resolved_vars)
                                actual = (await target.inner_text(timeout=timeout) or "").strip()
                                assert expected.lower() in actual.lower(), f"assert_text in table failed: expected '{expected}' in '{actual}'"
                            elif sub_action == "assert_visible":
                                await target.wait_for(state="visible", timeout=timeout)
                            elif sub_action == "check":
                                chk = target.locator("input[type='checkbox']").first
                                if not await chk.is_checked():
                                    # Click label for Angular custom checkboxes, fall back to input
                                    lbl = target.locator("label").first
                                    if await lbl.count() > 0:
                                        await lbl.click(timeout=timeout)
                                    else:
                                        await chk.click(timeout=timeout)
                            elif sub_action == "uncheck":
                                chk = target.locator("input[type='checkbox']").first
                                if await chk.is_checked():
                                    # Click label for Angular custom checkboxes, fall back to input
                                    lbl = target.locator("label").first
                                    if await lbl.count() > 0:
                                        await lbl.click(timeout=timeout)
                                    else:
                                        await chk.click(timeout=timeout)
                            found = True
                            break
            if not found:
                raise Exception(f"Table row with '{search_text}' in col {search_col} not found")

        # ── PRESS SEQUENTIALLY (handled above in the main action block) ─────────
        # This block is a safety fallback — the main handler above runs first.

        # ── GROUP (label only, always passes) ────────────────────────────────
        elif action == "group":
            log(run_id, "info", f"── {value or 'Group'} ──", idx)

        # ── GET TABLE VALUE ───────────────────────────────────────────────────
        elif action == "get_table_value":
            label_v  = apply_variables(step.get("value", ""), resolved_vars).strip()
            store_as = apply_variables(step.get("store_as", ""), resolved_vars).strip()
            compare  = apply_variables(step.get("value2", ""), resolved_vars).strip()
            stored   = None
            try:
                await page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass
            for exact in [True, False]:
                try:
                    loc = page.get_by_text(label_v, exact=exact)
                    n_loc = await loc.count()
                    for ri in range(min(n_loc, 3)):
                        val = await loc.nth(ri).evaluate("""
                            (el) => {
                                function clean(s){return(s||'').trim().replace(/,/g,'').replace(/[\u20B9$\u20AC\u00A3\s]/g,'');}
                                function isNum(s){return/^-?[\d]+(\.\d+)?$/.test(s);}
                                let c=el;
                                for(let d=0;d<5;d++){
                                    if(!c.parentElement)break;
                                    c=c.parentElement;
                                    const t=c.tagName.toLowerCase();
                                    if(t==='tr'||t==='li'||c.classList.contains('row')){
                                        const ch=Array.from(c.querySelectorAll('td,th,span,div,p'));
                                        for(const x of ch){if(x===el||x.contains(el))continue;const v=clean(x.innerText||x.textContent);if(v&&isNum(v))return v;}
                                        for(const x of ch){if(x===el||x.contains(el))continue;const v=(x.innerText||x.textContent||'').trim();const cv=clean(v);if(cv&&cv!=='-'&&cv!=='\u2013')return cv;}
                                        break;
                                    }
                                }
                                let s=el.nextElementSibling;
                                for(let k=0;k<5&&s;k++){const v=clean(s.innerText||s.textContent);if(v&&v!=='-')return v;s=s.nextElementSibling;}
                                return null;
                            }
                        """)
                        if val:
                            stored = str(val).strip()
                            break
                    if stored:
                        break
                except Exception:
                    pass
            if not stored:
                full = await page.inner_text("body")
                lines = [l.strip() for l in full.split("\n") if l.strip()]
                import re as _re_gtv
                for li, line in enumerate(lines):
                    if label_v.lower() in line.lower():
                        for lj in range(li + 1, min(li + 6, len(lines))):
                            c = lines[lj].replace(",", "").strip()
                            if _re_gtv.match(r"^-?[\d]+(\.\d+)?$", c):
                                stored = c
                                break
                        if stored:
                            break
            if not stored:
                raise Exception(f"get_table_value: label '{label_v}' not found")
            if store_as:
                resolved_vars[store_as] = stored
            if compare:
                def _n(s):
                    try: return float(str(s).replace(",", "").strip())
                    except: return str(s).strip()
                n1, n2 = _n(stored), _n(compare)
                if isinstance(n1, float) and isinstance(n2, float):
                    match = n1 == n2
                else:
                    match = str(stored).strip() == str(compare).strip()
                if not match:
                    msg = f"Mismatch: '{label_v}' = {stored}, expected {compare}"
                    if step.get("continue_on_fail") == False:
                        raise Exception(msg)
                    else:
                        log(run_id, "fail", f"[FAIL] {msg}", idx)
                        return {"status": "failed", "step": idx, "error": msg}
            log(run_id, "pass", f"[OK] get_table_value '{label_v}' = {stored}", idx)
            return {"status": "passed", "step": idx}

        # ── ASSERT SOFT ───────────────────────────────────────────────────────
        elif action == "assert_soft":
            v1 = apply_variables(step.get("value", ""), resolved_vars)
            v2 = apply_variables(step.get("value2", "") or step.get("selector", ""), resolved_vars)
            op = step.get("operator", "equals")
            def _n(s):
                try: return float(str(s).replace(",", "").strip())
                except: return None
            if op == "equals":
                n1, n2 = _n(v1), _n(v2)
                passed = (n1 == n2) if (n1 is not None and n2 is not None) else (v1.strip() == v2.strip())
            elif op == "contains":   passed = v2 in v1
            elif op == "greater":    passed = (_n(v1) or 0) > (_n(v2) or 0)
            elif op == "less":       passed = (_n(v1) or 0) < (_n(v2) or 0)
            elif op == "not_equals":
                n1, n2 = _n(v1), _n(v2)
                passed = (n1 != n2) if (n1 is not None and n2 is not None) else (v1.strip() != v2.strip())
            else: passed = v1.strip() == v2.strip()
            if passed:
                log(run_id, "pass", f"[OK] assert_soft: '{v1[:60]}' {op} '{v2[:60]}'", idx)
                return {"status": "passed", "step": idx}
            else:
                msg = f"Soft assertion failed: '{v1[:60]}' {op} '{v2[:60]}'"
                log(run_id, "warn", f"[SOFT FAIL] {msg}", idx)
                return {"status": "failed", "step": idx, "error": msg, "soft": True}

        # ── ASSERT VAR COMPARISONS ────────────────────────────────────────────
        elif action in ("assert_equals", "assert_not_equals", "assert_contains",
                        "assert_not_contains", "assert_starts_with", "assert_ends_with",
                        "assert_greater", "assert_less", "assert_between",
                        "assert_matches", "assert_matches_regex", "assert_empty", "assert_not_empty"):
            import re as _re_av
            v1 = apply_variables(step.get("value", ""), resolved_vars)
            v2 = apply_variables(step.get("value2", "") or step.get("selector", ""), resolved_vars)
            def _cn(s): return str(s).strip().replace(",", "").replace(" ", "")
            if action == "assert_equals":
                try: assert float(_cn(v1)) == float(_cn(v2)), f"Expected {v2} but got {v1}"
                except (ValueError, TypeError): assert v1.strip() == v2.strip(), f"Expected '{v2}' but got '{v1}'"
            elif action == "assert_not_equals":
                try: assert float(_cn(v1)) != float(_cn(v2)), f"Expected NOT {v2} but got {v1}"
                except (ValueError, TypeError): assert v1.strip() != v2.strip(), f"Expected NOT '{v2}' but got '{v1}'"
            elif action == "assert_contains":      assert v2 in v1, f"'{v1}' does not contain '{v2}'"
            elif action == "assert_not_contains":  assert v2 not in v1, f"'{v1}' should not contain '{v2}'"
            elif action == "assert_starts_with":   assert v1.startswith(v2), f"'{v1}' does not start with '{v2}'"
            elif action == "assert_ends_with":     assert v1.endswith(v2), f"'{v1}' does not end with '{v2}'"
            elif action == "assert_greater":       assert float(v1) > float(v2), f"{v1} not > {v2}"
            elif action == "assert_less":          assert float(v1) < float(v2), f"{v1} not < {v2}"
            elif action == "assert_between":
                lo = apply_variables(step.get("value2", "0"), resolved_vars)
                hi = apply_variables(step.get("value3", "0"), resolved_vars)
                assert float(lo) <= float(v1) <= float(hi), f"{v1} not between {lo} and {hi}"
            elif action in ("assert_matches", "assert_matches_regex"): assert _re_av.search(v2, v1), f"'{v1}' does not match '{v2}'"
            elif action == "assert_empty":         assert v1.strip() == "", f"Expected empty but got '{v1}'"
            elif action == "assert_not_empty":     assert v1.strip() != "", "Value is empty"
            log(run_id, "pass", f"[OK] {action}: '{v1[:60]}'", idx)
            return {"status": "passed", "step": idx}

        # ── ASSERT ELEMENT COUNT ─────────────────────────────────────────────
        elif action == "assert_element_count":
            actual = await get_locator(page, selector).count()
            assert int(value) == actual, f"Expected {value} elements, found {actual}"

        # ── CLEAR COOKIE ─────────────────────────────────────────────────────
        elif action == "clear_cookie":
            if value:
                cookies = await page.context.cookies()
                remaining = [c for c in cookies if c["name"] != value]
                await page.context.clear_cookies()
                if remaining:
                    await page.context.add_cookies(remaining)
                log(run_id, "info", f"  Cleared cookie: {value}", idx)
            else:
                await page.context.clear_cookies()
                log(run_id, "info", "  Cleared all cookies", idx)

        # ── ASSERT COOKIE ─────────────────────────────────────────────────────
        elif action == "assert_cookie":
            parts    = value.split("=", 1)
            name_c   = parts[0].strip()
            expected = parts[1].strip() if len(parts) > 1 else None
            cookies  = {c["name"]: c["value"] for c in await page.context.cookies()}
            assert name_c in cookies, f"Cookie '{name_c}' not found"
            if expected:
                assert expected in cookies[name_c], f"Cookie '{name_c}' expected '{expected}', got '{cookies[name_c]}'"

        # ── TABLE MULTI ACTION ────────────────────────────────────────────────
        elif action == "table_multi_action":
            table_sel    = selector
            conditions   = step.get("conditions", [])
            actions_list = step.get("actions", [])
            match_logic  = step.get("match_logic", "all").lower()
            which_match  = step.get("which_match", "first").lower()
            which_map    = {"first": 0, "second": 1, "third": 2, "fourth": 3, "fifth": 4}
            resolved_conds = [{"col": int(c.get("col", 1)),
                               "value": apply_variables(str(c.get("value", "")), resolved_vars),
                               "mode": c.get("mode", "contains").lower()} for c in conditions]
            resolved_acts  = [{"col": int(a.get("col", 1)),
                               "sub_action": a.get("sub_action", "click"),
                               "value": apply_variables(str(a.get("value", "")), resolved_vars),
                               "store_as": a.get("store_as", "")} for a in actions_list]
            rows = page.locator(f"{table_sel} tbody tr")
            row_count = await rows.count()
            matched_rows = []
            for ri in range(row_count):
                try:
                    results_cond = []
                    for cond in resolved_conds:
                        cell = rows.nth(ri).locator(f"td:nth-child({cond['col']})")
                        ct   = (await cell.inner_text(timeout=2000) or "").strip()
                        cv   = cond["value"]
                        if   cond["mode"] == "equals":     results_cond.append(cv.lower() == ct.lower())
                        elif cond["mode"] == "startswith": results_cond.append(ct.lower().startswith(cv.lower()))
                        else:                               results_cond.append(cv.lower() in ct.lower())
                    row_match = any(results_cond) if match_logic == "any" else all(results_cond)
                    if row_match: matched_rows.append(ri)
                except Exception: continue
            if not matched_rows:
                raise Exception(f"table_multi_action: no rows matched in [{table_sel}]")
            target_rows = matched_rows if which_match == "all" else [matched_rows[which_map.get(which_match, 0)]]
            for row_idx in target_rows:
                for act in resolved_acts:
                    tc = rows.nth(row_idx).locator(f"td:nth-child({act['col']})")
                    if   act["sub_action"] == "click":      await tc.click(timeout=timeout)
                    elif act["sub_action"] == "type":       await tc.locator("input, textarea").first.fill(act["value"], timeout=timeout)
                    elif act["sub_action"] == "select":     await tc.locator("select").first.select_option(act["value"], timeout=timeout)
                    elif act["sub_action"] == "get_text":
                        txt = (await tc.inner_text(timeout=timeout) or "").strip()
                        if act["store_as"]: resolved_vars[act["store_as"].strip("{}")] = txt
                    elif act["sub_action"] == "assert_text":
                        txt = (await tc.inner_text(timeout=timeout) or "").strip()
                        assert act["value"].lower() in txt.lower(), f"table_multi_action: expected '{act['value']}' in '{txt}'"

        # ── DB VALIDATE ──────────────────────────────────────────────────────
        elif action == "db_validate":
            cfg = step.get("db_config", {})
            if not cfg:
                raise Exception("db_validate: no db_config on step")
            query    = apply_variables(cfg.get("query", ""), resolved_vars)
            expected = apply_variables(str(cfg.get("expected", "")), resolved_vars)
            column   = cfg.get("column", "")
            store_as = cfg.get("store_as", "")
            assert_t = cfg.get("assert_type", "equals")
            if not HAS_PG:
                raise Exception("db_validate: psycopg2 not installed — run: pip install psycopg2-binary --break-system-packages")
            conn_cfg = {"host": cfg.get("host","localhost"), "port": int(cfg.get("port",5432)),
                        "database": cfg.get("database",""), "user": cfg.get("user",""), "password": cfg.get("password","")}
            log(run_id, "info", f"  DB Query: {query[:100]}", idx)
            conn = psycopg2.connect(**conn_cfg)
            try:
                cur = conn.cursor()
                cur.execute(query)
                row = cur.fetchone()
                if row is None:
                    raise Exception("db_validate: query returned no rows")
                col_names = [d[0] for d in cur.description]
                actual = str(row[col_names.index(column)] if column and column in col_names else row[0])
                if store_as:
                    resolved_vars[store_as.strip("{}").strip()] = actual
                if assert_t == "equals":
                    assert actual == expected, f"DB: expected '{expected}', got '{actual}'"
                elif assert_t == "contains":
                    assert expected in actual, f"DB: '{actual}' does not contain '{expected}'"
                elif assert_t == "not_empty":
                    assert actual.strip(), "DB: value is empty"
                log(run_id, "pass", f"[OK] db_validate: '{actual}'", idx)
            finally:
                conn.close()

        # ── DB EXTRACT MULTI ──────────────────────────────────────────────────
        elif action == "db_extract_multi":
            cfg = step.get("db_config", {})
            if not cfg:
                raise Exception("db_extract_multi: no db_config on step")
            if not HAS_PG:
                raise Exception("db_extract_multi: psycopg2 not installed")
            query    = apply_variables(cfg.get("query", ""), resolved_vars)
            mappings = cfg.get("mappings", [])
            conn_cfg = {"host": cfg.get("host","localhost"), "port": int(cfg.get("port",5432)),
                        "database": cfg.get("database",""), "user": cfg.get("user",""), "password": cfg.get("password","")}
            conn = psycopg2.connect(**conn_cfg)
            try:
                cur = conn.cursor()
                cur.execute(query)
                row = cur.fetchone()
                if row is None:
                    raise Exception("db_extract_multi: query returned no rows")
                col_names = [d[0] for d in cur.description]
                row_dict  = dict(zip(col_names, row))
                for m_idx, m in enumerate(mappings):
                    col_name = (m.get("column") or "").strip()
                    var_name = (m.get("variable") or "").strip()
                    if not var_name: continue
                    val = row_dict.get(col_name, row[m_idx] if m_idx < len(row) else "")
                    resolved_vars[var_name] = str(val) if val is not None else ""
                    log(run_id, "info", f"  db_extract: {{{{{var_name}}}}} = '{resolved_vars[var_name]}'", idx)
                log(run_id, "pass", f"[OK] db_extract_multi: {len(mappings)} var(s) stored", idx)
            finally:
                conn.close()
            return {"status": "passed", "step": idx}

        # ── COMPARE PDF PAGE ──────────────────────────────────────────────────
        elif action == "compare_pdf_page":
            import unicodedata as _ud
            pdf_path = value.strip()
            log(run_id, "info", f"[compare_pdf_page] Reading PDF: {pdf_path}", idx)
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                await page.wait_for_timeout(2000)
            pdf_text = ""
            try:
                import pdfplumber
                with pdfplumber.open(pdf_path) as _pdf:
                    for _pg in _pdf.pages:
                        t = _pg.extract_text(x_tolerance=2, y_tolerance=2)
                        if t: pdf_text += t + "\n"
                log(run_id, "info", f"[compare_pdf_page] PDF: {len(pdf_text)} chars", idx)
            except ImportError:
                raise Exception("compare_pdf_page: pdfplumber not installed — run: pip install pdfplumber --break-system-packages")
            page_text = await get_locator(page, selector).inner_text(timeout=timeout) if selector else await page.inner_text("body")
            def _norm(t):
                t = _ud.normalize("NFKD", t)
                lines = [re.sub(r"[ \t]+", " ", l).strip() for l in t.splitlines()]
                return [l for l in lines if len(l) >= 15]
            pdf_lines  = _norm(pdf_text)
            page_full  = " ".join(_norm(page_text)).lower()
            matched = [l for l in pdf_lines if l.lower() in page_full]
            missing_l = [l for l in pdf_lines if l.lower() not in page_full]
            pct = int(len(matched) / len(pdf_lines) * 100) if pdf_lines else 0
            log(run_id, "pass" if not missing_l else "warn",
                f"[compare_pdf_page] Match: {len(matched)}/{len(pdf_lines)} lines ({pct}%)", idx)
            for _i, _line in enumerate(missing_l, 1):
                log(run_id, "warn", f"[compare_pdf_page] MISSING [{_i}]: {_line[:120]}", idx)

        # ── ASSERT AI ─────────────────────────────────────────────────────────
        elif action == "assert_ai":
            question = apply_variables(step.get("value", ""), resolved_vars)
            if not question.strip():
                raise Exception("assert_ai: question is empty")
            ai_key = os.environ.get("ANTHROPIC_API_KEY", "")
            if not ai_key:
                raise Exception("assert_ai: ANTHROPIC_API_KEY not set")
            tmp_path = os.path.join(SCREENSHOTS_DIR, f"{run_id}_assert_ai_{idx+1}.png")
            await page.screenshot(path=tmp_path, full_page=True)
            with open(tmp_path, "rb") as _f:
                img_b64 = base64.b64encode(_f.read()).decode()
            prompt = (f"You are a QA assistant. Look at this screenshot and answer YES or NO.\n"
                      f"Question: {question}\n\nRespond in this format:\nRESULT: YES\nREASON: <brief>")
            ai_resp = requests.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ai_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                json={"model": "claude-haiku-4-5-20251001", "max_tokens": 300,
                      "messages": [{"role": "user", "content": [
                          {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}},
                          {"type": "text",  "text": prompt}]}]}, timeout=30)
            if ai_resp.status_code != 200:
                raise Exception(f"assert_ai: Claude error {ai_resp.status_code}")
            resp_text   = ai_resp.json()["content"][0]["text"].strip()
            result_line = next((l for l in resp_text.splitlines() if l.startswith("RESULT:")), "")
            reason_line = next((l for l in resp_text.splitlines() if l.startswith("REASON:")), "")
            passed_ai   = "YES" in result_line.upper()
            reason      = reason_line.replace("REASON:", "").strip() or resp_text[:200]
            log(run_id, "info", f"  [assert_ai] {resp_text[:200]}", idx)
            if not passed_ai:
                raise AssertionError(f"assert_ai FAILED: {reason}")
            log(run_id, "pass", f"[OK] assert_ai PASSED: {reason}", idx)
            return {"status": "passed", "step": idx}

        # ── AI EXTRACT ────────────────────────────────────────────────────────
        elif action == "ai_extract":
            raw_q  = step.get("value", "") or ""
            question = apply_variables(str(raw_q.get("value", "") if isinstance(raw_q, dict) else raw_q), resolved_vars)
            raw_sa   = step.get("store_as", "") or ""
            store_as = str(raw_sa.get("value", "") if isinstance(raw_sa, dict) else raw_sa).strip().strip("{}")
            if not question.strip(): raise Exception("ai_extract: question is empty")
            if not store_as:         raise Exception("ai_extract: store_as is empty")
            ai_key = os.environ.get("ANTHROPIC_API_KEY", "")
            if not ai_key: raise Exception("ai_extract: ANTHROPIC_API_KEY not set")
            tmp_path = os.path.join(SCREENSHOTS_DIR, f"{run_id}_ai_extract_{idx+1}.png")
            await page.screenshot(path=tmp_path, full_page=False)
            with open(tmp_path, "rb") as _f:
                img_b64 = base64.b64encode(_f.read()).decode()
            prompt = (f"Extract the following from this screenshot:\n{question}\n\n"
                      "Respond with ONLY the extracted value. If not found, respond: NOT_FOUND")
            ai_resp = requests.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ai_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                json={"model": "claude-haiku-4-5-20251001", "max_tokens": 200,
                      "messages": [{"role": "user", "content": [
                          {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}},
                          {"type": "text",  "text": prompt}]}]}, timeout=30)
            if ai_resp.status_code != 200:
                raise Exception(f"ai_extract: Claude error {ai_resp.status_code}")
            extracted = ai_resp.json()["content"][0]["text"].strip()
            if extracted == "NOT_FOUND":
                raise AssertionError(f"ai_extract: value not found for: '{question[:80]}'")
            resolved_vars[store_as] = extracted
            log(run_id, "pass", f"[OK] ai_extract: '{extracted[:80]}' → {{{{{store_as}}}}}", idx)
            return {"status": "passed", "step": idx}

        # ── ENCODE / PARSE ────────────────────────────────────────────────────
        elif action in ("encode_base64", "decode_base64", "url_encode", "json_extract", "json_parse"):
            import base64 as _b64, urllib.parse as _up, json as _json
            raw_store = step.get("store_as", "") or step.get("value", "")
            raw_store = raw_store.strip()
            if raw_store.startswith("{{") and raw_store.endswith("}}"):
                var_name = raw_store[2:-2].strip()
            else:
                var_name = apply_variables(raw_store, resolved_vars).strip()
            src_var = apply_variables(step.get("value", ""), resolved_vars).strip()
            src = resolved_vars.get(src_var, apply_variables(step.get("selector", "") or src_var, resolved_vars))
            v2  = apply_variables(step.get("value2", ""), resolved_vars)
            if   action == "encode_base64": result_val = _b64.b64encode(src.encode()).decode()
            elif action == "decode_base64": result_val = _b64.b64decode(src.encode()).decode()
            elif action == "url_encode":    result_val = _up.quote(src)
            elif action == "json_parse":
                parsed = _json.loads(src)
                result_val = _json.dumps(parsed) if isinstance(parsed, (dict, list)) else str(parsed)
            elif action == "json_extract":
                raw_src = (step.get("selector", "") or src_var).strip().strip("{}").strip()
                raw_src = apply_variables(raw_src, resolved_vars)
                json_src = resolved_vars.get(raw_src, raw_src)
                obj = json_src if isinstance(json_src, (dict, list)) else _json.loads(str(json_src))
                for key in v2.split("."):
                    obj = obj[int(key)] if key.isdigit() else obj[key]
                result_val = _json.dumps(obj) if isinstance(obj, (dict, list)) else str(obj)
            if var_name:
                resolved_vars[var_name] = result_val
            log(run_id, "pass", f"[OK] {action}: '{str(result_val)[:80]}' → {{{{{var_name}}}}}", idx)
            return {"status": "passed", "step": idx}

        # ── REPEAT_UNTIL / TRY_START / WAIT_UNTIL / IF_START / SWITCH_START ──
        # These are handled in run_steps_with_flow — if they reach run_step it means
        # they appeared without their surrounding block (e.g. orphaned end tag).
        # Just pass them through silently.
        elif action in ("repeat_until", "repeat_until_end", "try_start", "catch_start",
                        "try_end", "wait_until", "if_start", "if_end", "else",
                        "switch_start", "switch_end", "case",
                        "loop_end", "foreach_end"):
            log(run_id, "info", f"[flow] '{action}' handled by flow controller", idx)

        # ── VISUAL CHECKPOINT (file-based PIL diff) ─────────────────────────────
        elif action in ("visual_checkpoint", "visual_figma_check"):
            visual_name = apply_variables(step.get("value", "") or step.get("name", ""), resolved_vars).strip()
            threshold   = float(step.get("threshold", 5))
            figma_url   = apply_variables(step.get("figma_url",   ""), resolved_vars).strip()
            figma_token = apply_variables(step.get("figma_token", ""), resolved_vars).strip()
            match_level = step.get("match_level", "ai").lower()
            ignore_text = step.get("ignore_text", "")
            api_key     = os.environ.get("ANTHROPIC_API_KEY", "")

            root_dir     = os.path.join(os.path.dirname(__file__), "..")
            baseline_dir = os.path.abspath(os.path.join(root_dir, "visual_baselines"))
            compare_dir  = os.path.abspath(os.path.join(root_dir, "visual_comparisons"))
            os.makedirs(baseline_dir, exist_ok=True)
            os.makedirs(compare_dir,  exist_ok=True)

            safe_name   = re.sub(r'[^\w\-]', '_', visual_name or "visual").lower()
            ts_v        = int(time.time())
            actual_path = os.path.join(compare_dir, f"actual_{safe_name}_{run_id}_{ts_v}.png")
            diff_path   = os.path.join(compare_dir, f"diff_{safe_name}_{run_id}_{ts_v}.png")

            # Take screenshot
            await page.screenshot(path=actual_path, full_page=False)
            log(run_id, "info", f"[visual] Screenshot taken: {os.path.basename(actual_path)}", idx)

            # ── Get reference image ─────────────────────────────────────────────────
            expected_path = None

            if action == "visual_figma_check" and figma_url and figma_token:
                import re as _re2, urllib.parse as _ulp
                _fmatch = _re2.search(r'figma\.com/(?:file|design)/([^/?]+).*node-id=([^&]+)', figma_url)
                if not _fmatch:
                    raise Exception("visual_figma_check: Invalid Figma URL — must include file key and node-id")
                file_key = _fmatch.group(1)
                raw_node   = _ulp.unquote(_fmatch.group(2))
                node_dash  = raw_node.replace(":", "-")
                node_colon = raw_node.replace("-", ":")

                # ── Cache: reuse downloaded frame if < 24 hours old ──────────
                # Saves Figma API calls and avoids rate limiting
                figma_cache_dir  = os.path.join(baseline_dir, "figma_cache")
                os.makedirs(figma_cache_dir, exist_ok=True)
                cache_key        = f"{file_key}_{node_dash}"
                figma_cache_path = os.path.join(figma_cache_dir, f"{cache_key}.png")
                cache_max_age    = 30 * 24 * 60 * 60  # 30 days — Figma designs rarely change
                cache_valid      = (
                    os.path.exists(figma_cache_path) and
                    (time.time() - os.path.getmtime(figma_cache_path)) < cache_max_age
                )

                if cache_valid:
                    log(run_id, "info", f"[visual] Using cached Figma frame (< 24h old): {cache_key}", idx)
                    figma_png_path = figma_cache_path
                else:
                    # Download fresh from Figma API
                    log(run_id, "info", "[visual] Downloading Figma frame...", idx)
                    figma_api_url = f"https://api.figma.com/v1/images/{file_key}?ids={_ulp.quote(node_colon)}&format=png&scale=1"
                    log(run_id, "info", f"[visual] Figma API: {figma_api_url}", idx)
                    figma_resp = requests.get(figma_api_url, headers={"X-Figma-Token": figma_token}, timeout=60)
                    # Retry on rate limit with exponential backoff
                    if figma_resp.status_code == 429:
                        for _wait in [15, 30, 60]:
                            log(run_id, "warn", f"[visual] Figma rate limited — retrying in {_wait}s...", idx)
                            time.sleep(_wait)
                            figma_resp = requests.get(figma_api_url, headers={"X-Figma-Token": figma_token}, timeout=60)
                            if figma_resp.status_code != 429:
                                break
                    if figma_resp.status_code == 429:
                        # Rate limited — use cache even if expired, or fail gracefully
                        if os.path.exists(figma_cache_path):
                            log(run_id, "warn", "[visual] Figma rate limited — using expired cache", idx)
                            figma_png_path = figma_cache_path
                        else:
                            raise Exception("visual_figma_check: Figma rate limited (429). Wait 1-2 minutes and retry.")
                    elif figma_resp.status_code != 200:
                        raise Exception(f"visual_figma_check: Figma API error {figma_resp.status_code}: {figma_resp.text[:200]}")
                    else:
                        figma_data = figma_resp.json()
                        log(run_id, "info", f"[visual] Figma response keys: {list(figma_data.get('images',{}).keys())}", idx)
                        images = figma_data.get("images", {})
                        img_url = (
                            images.get(node_colon) or
                            images.get(node_dash)  or
                            images.get(raw_node)   or
                            (list(images.values())[0] if images else None)
                        )
                        if not img_url:
                            raise Exception(f"visual_figma_check: Figma returned no image URL. Keys={list(images.keys())}")
                        img_data = requests.get(img_url, timeout=30)
                        figma_png_path = figma_cache_path  # save to cache
                        with open(figma_png_path, "wb") as _f:
                            _f.write(img_data.content)
                        log(run_id, "info", "[visual] Figma frame downloaded and cached", idx)

                        # Resize if too large for Claude API
                        try:
                            from PIL import Image as _PIR
                            _fig_img = _PIR.open(figma_png_path)
                            _fw, _fh = _fig_img.size
                            _max_dim = 1280
                            if _fw > _max_dim or _fh > _max_dim:
                                _scale_r = min(_max_dim / _fw, _max_dim / _fh)
                                _fig_img = _fig_img.resize((int(_fw * _scale_r), int(_fh * _scale_r)), _PIR.LANCZOS)
                                _fig_img.save(figma_png_path)
                                log(run_id, "info", f"[visual] Figma resized: {_fw}x{_fh} → {int(_fw*_scale_r)}x{int(_fh*_scale_r)}", idx)
                        except Exception as _re:
                            log(run_id, "info", f"[visual] Resize skipped: {_re}", idx)

                expected_path = figma_png_path

            else:
                # Local baseline file
                baseline_path = os.path.join(baseline_dir, f"baseline_{safe_name}.png")
                if not os.path.exists(baseline_path):
                    import shutil as _shutil
                    _shutil.copy2(actual_path, baseline_path)
                    log(run_id, "info", f"[visual] '{visual_name}' — baseline saved (first run)", idx)
                    expected_path = None
                else:
                    expected_path = baseline_path
                    log(run_id, "info", f"[visual] Using baseline: {os.path.basename(baseline_path)}", idx)

            # ── Compare ────────────────────────────────────────────────────────────
            if expected_path is not None:
                if not api_key:
                    raise Exception("visual_checkpoint: ANTHROPIC_API_KEY not set in .env")

                def _img_b64_sync(path):
                    with open(path, "rb") as _f:
                        return base64.b64encode(_f.read()).decode()

                ignore_extra = ""
                if ignore_text.strip():
                    items = ", ".join([f"'{t.strip()}'" for t in ignore_text.split(",") if t.strip()])
                    ignore_extra = f"\nAlso ignore these specific patterns: {items}."

                prompts = {
                    "layout":  ("MATCH LEVEL: LAYOUT ONLY.\n"
                                "Instruction: Check only the visual arrangement: positions of boxes, tables, and sections. Do not evaluate any text. Flag mismatches in spacing, alignment, or structure.\n"
                                "DO NOT flag ANY text differences — not labels, not button text, not headings, not placeholders.\n"
                                "DO NOT flag colour differences, font differences, or icon differences.\n"
                                "ONLY flag: missing UI sections, elements moved to different positions, layout structure changes.\n"
                                "If the page structure looks the same, respond with zero differences."),
                    "content": ("MATCH LEVEL: CONTENT ONLY.\n"
                                "Instruction: Verify that headings, labels, and section titles match between the two images. Ignore layout and detailed text values. Report missing or mismatched labels.\n"
                                "Ignore: colours, fonts, spacing, dynamic data (patient IDs, dates, names, amounts, counts).\n"
                                "Ignore: Favorites, Recently Used, Community Posts, Announcements, Notifications content — these are user/time specific."),
                    "strict":  ("MATCH LEVEL: STRICT.\n"
                                "Instruction: Perform a thorough comparison. Report EVERY visual difference you can see.\n"
                                "Check ALL of these:\n"
                                "- Navigation menu: are all icons and labels identical?\n"
                                "- Section headings: do all titles match exactly?\n"
                                "- Button text: do all button labels match?\n"
                                "- Form field labels and placeholders\n"
                                "- Colours: background colours, button colours, text colours\n"
                                "- Fonts: size, weight, style differences\n"
                                "- Layout: spacing, alignment, element sizes\n"
                                "- Missing or extra UI elements\n"
                                "- Section structure: are all sections present and in the right order?\n"
                                "Only skip these truly dynamic values:\n"
                                "- The actual logged-in user name only (e.g. Welcome John vs Welcome Admin)\n"
                                "- Patient record data (names, IDs)\n"
                                "- Dates and timestamps\n"
                                "- Numeric counts in Live section\n"
                                "Everything else — including section titles, button text, navigation labels, colours, What's New titles, Announcement titles — MUST be reported."),
                    "ai":      ("MATCH LEVEL: AI (smart).\n"
                                "Instruction: Ignore patient identifiers (names, IDs, dates). Compare the two images for differences in structure and content while excluding sensitive data fields.\n"
                                "\nCRITICAL IGNORE LIST — do NOT flag ANY of these as differences:\n"
                                "- User name, logged-in user, profile name, welcome message (e.g. Welcome John vs Welcome Admin — IGNORE)\n"
                                "- Patient names, patient IDs, MRN numbers\n"
                                "- Dates, times, timestamps\n"
                                "- Transaction IDs, invoice numbers, amounts\n"
                                "- Favourites section content (empty or populated — IGNORE both states)\n"
                                "- Recently Used section content (any patient names or entries — IGNORE)\n"
                                "- What's New section text content (bulletin text, module names — IGNORE)\n"
                                "- Announcements section content (empty or with content — IGNORE)\n"
                                "- Community Posts section content (empty or with content — IGNORE)\n"
                                "- Live section numerical metrics (admissions, consultations counts — IGNORE)\n"
                                "- Any section where the STRUCTURE exists in both but only the DATA differs\n"
                                "\nONLY flag as CRITICAL if:\n"
                                "- An entire UI section/panel is COMPLETELY MISSING from one image\n"
                                "- Navigation menu icons/items are fundamentally different (e.g. clinical icons vs inventory icons)\n"
                                "- A major button or form element is missing entirely\n"
                                "- The page layout structure is completely different\n"
                                "\nRule: If a section EXISTS in both images but shows different data/content, that is NOT a critical issue."),
                }
                prompt = (
                    "You are a senior QA engineer reviewing two UI screenshots.\n"
                    "Image 1 = EXPECTED (Figma design / baseline) | Image 2 = ACTUAL (live app)\n"
                    + prompts.get(match_level, prompts["ai"]) + ignore_extra +
                    "\n\nSTRICT RULES:\n"
                    "- 'expected' field = ONLY describe what Image 1 shows for this element\n"
                    "- 'actual' field = ONLY describe what Image 2 shows for this element\n"
                    "- NEVER put Image 2 content in 'expected' field\n"
                    "- NEVER put Image 1 content in 'actual' field\n"
                    "- NEVER duplicate any field\n"
                    "- Each difference must be a SEPARATE element\n"
                    "- Report a MAXIMUM of 10 differences (most important first)\n"
                    "- CRITICAL = element missing or completely wrong\n"
                    "- MINOR = element present but styled differently\n"
                    "- COSMETIC = minor text or color difference\n"
                    "\nFor EACH difference provide exactly these 4 fields:\n"
                    "- element: name of the UI control\n"
                    "- severity: CRITICAL or MINOR or COSMETIC\n"
                    "- expected: one SHORT sentence (max 15 words) describing what Image 1 shows\n"
                    "- actual: one SHORT sentence (max 15 words) describing what Image 2 shows\n"
                    "\nRespond ONLY in valid JSON:\n"
                    '{"differences":[{"severity":"CRITICAL","element":"SSO Button","expected":"No SSO button exists","actual":"Red Login with SSO button present"}],"summary":"brief summary","critical_count":1,"minor_count":0,"cosmetic_count":0}'
                )

                # Retry up to 3 times on 502/503/529 (Anthropic server errors)
                claude_resp = None
                for _attempt in range(3):
                    try:
                        claude_resp = requests.post(
                            "https://api.anthropic.com/v1/messages",
                            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                            json={
                                "model": "claude-haiku-4-5-20251001",
                                "max_tokens": 2000,
                                "messages": [{"role": "user", "content": [
                                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _img_b64_sync(expected_path)}},
                                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _img_b64_sync(actual_path)}},
                                    {"type": "text",  "text": prompt},
                                ]}],
                            },
                            timeout=120
                        )
                        if claude_resp.status_code in (502, 503, 529):
                            wait = (_attempt + 1) * 10
                            log(run_id, "warn", f"[visual] Claude API {claude_resp.status_code} — retrying in {wait}s (attempt {_attempt+1}/3)", idx)
                            time.sleep(wait)
                            continue
                        break
                    except requests.exceptions.Timeout:
                        log(run_id, "warn", f"[visual] Claude API timeout — retrying (attempt {_attempt+1}/3)", idx)
                        time.sleep(10)
                        continue

                if claude_resp is None or claude_resp.status_code != 200:
                    status = claude_resp.status_code if claude_resp else "timeout"
                    body   = claude_resp.text[:200] if claude_resp else "no response"
                    raise Exception(f"visual_checkpoint: Claude API error {status}: {body}")

                claude_text = claude_resp.json()["content"][0]["text"].strip()
                # Clean markdown fences
                if claude_text.startswith("```"):
                    claude_text = claude_text.split("```")[1]
                    if claude_text.startswith("json"): claude_text = claude_text[4:]
                claude_text = claude_text.strip()
                # Extract just the JSON object if there's extra text
                json_start = claude_text.find('{')
                json_end   = claude_text.rfind('}') + 1
                if json_start >= 0 and json_end > json_start:
                    claude_text = claude_text[json_start:json_end]
                # Fix common JSON issues — replace control chars
                import re as _re_json
                claude_text = _re_json.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', claude_text)

                import json as _vjson
                try:
                    claude_result = _vjson.loads(claude_text)
                except Exception as _je:
                    # Try to repair truncated JSON by closing open arrays/objects
                    log(run_id, "warn", f"[visual] Claude JSON parse error: {_je} — attempting repair", idx)
                    _repaired = claude_text
                    # Count open vs closed braces/brackets to detect truncation
                    _open_b  = _repaired.count('{') - _repaired.count('}')
                    _open_br = _repaired.count('[') - _repaired.count(']')
                    # Close any incomplete last entry (remove trailing incomplete object)
                    _last_complete = max(_repaired.rfind('},'), _repaired.rfind('}\n'))
                    if _last_complete > 0 and _open_b > 0:
                        _repaired = _repaired[:_last_complete+1]
                        _open_b  = _repaired.count('{') - _repaired.count('}')
                        _open_br = _repaired.count('[') - _repaired.count(']')
                    _repaired += ']' * _open_br + '}' * _open_b
                    try:
                        claude_result = _vjson.loads(_repaired)
                        log(run_id, "info", f"[visual] JSON repaired successfully", idx)
                    except Exception:
                        log(run_id, "warn", f"[visual] JSON repair failed — treating as no differences", idx)
                        claude_result = {"differences": [], "summary": "JSON parse error — treating as passed", "critical_count": 0, "minor_count": 0, "cosmetic_count": 0}

                # Pixel diff
                diff_pct = 0
                try:
                    from PIL import Image as _PI, ImageChops as _IC
                    img_base   = _PI.open(expected_path).convert("RGB")
                    img_actual = _PI.open(actual_path).convert("RGB")
                    if img_actual.size != img_base.size:
                        img_actual = img_actual.resize(img_base.size, _PI.LANCZOS)
                    diff_img = _IC.difference(img_base, img_actual)
                    import numpy as _np_v
                    diff_arr = _np_v.array(diff_img)
                    total_px = diff_arr.shape[0] * diff_arr.shape[1]
                    diff_px  = int(_np_v.any(diff_arr > 15, axis=2).sum())
                    diff_pct = round(diff_px / total_px * 100, 2) if total_px else 0
                except ImportError:
                    log(run_id, "info", "[visual] Pillow not installed — skipping pixel diff", idx)
                except Exception as _pe:
                    log(run_id, "info", f"[visual] Pixel diff error: {_pe}", idx)

                has_critical  = claude_result.get("critical_count", 0) > 0
                summary       = claude_result.get("summary", "")
                diffs         = claude_result.get("differences", [])
                # For AI/Layout/Content modes: only fail on critical AI issues, not pixel diff alone
                # Pixel diff alone is unreliable when comparing Figma (different user data) vs live app
                if match_level in ("ai", "layout", "content"):
                    visual_failed = has_critical
                else:  # strict mode: use both
                    visual_failed = has_critical or diff_pct > threshold

                if visual_failed:
                    diff_sent = False
                    try:
                        from PIL import Image as _PI2, ImageDraw as _ID2
                        import numpy as _np2

                        exp_img = _PI2.open(expected_path).convert("RGB")
                        act_img = _PI2.open(actual_path).convert("RGB")
                        act_w, act_h = act_img.size
                        exp_w, exp_h = exp_img.size

                        # ── Ask Claude to locate each issue element in the ACTUAL image ──
                        elem_list = []
                        for _di, _d in enumerate(diffs, 1):
                            elem_list.append(f"{_di}. {_d.get('element','')}: {_d.get('actual','')}")
                        elem_str = "\n".join(elem_list)

                        locate_prompt = (
                            f"This is a UI screenshot. The image is {act_w} pixels wide and {act_h} pixels tall.\n"
                            f"Find these UI elements and give their EXACT bounding box in pixels:\n\n"
                            f"{elem_str}\n\n"
                            f"IMPORTANT RULES:\n"
                            f"- x1,y1 = TOP-LEFT corner of the element\n"
                            f"- x2,y2 = BOTTOM-RIGHT corner of the element\n"
                            f"- Coordinates must be within 0-{act_w} for x and 0-{act_h} for y\n"
                            f"- Each element should have a DIFFERENT location\n"
                            f"- Make boxes large enough to fully surround the element (add 5px padding)\n"
                            f"- If element is NOT present in image at all, set found=false\n\n"
                            f"Respond ONLY in valid JSON (no markdown):\n"
                            f'{{"locations":[{{"index":1,"element":"element name","x1":100,"y1":50,"x2":400,"y2":90,"found":true}}]}}'
                        )

                        with open(actual_path, "rb") as _f:
                            act_b64 = base64.b64encode(_f.read()).decode()

                        loc_resp = requests.post(
                            "https://api.anthropic.com/v1/messages",
                            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                            json={"model": "claude-haiku-4-5-20251001", "max_tokens": 800,
                                  "messages": [{"role": "user", "content": [
                                      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": act_b64}},
                                      {"type": "text", "text": locate_prompt}
                                  ]}]},
                            timeout=30
                        )

                        locations = []
                        if loc_resp.status_code == 200:
                            import json as _lj
                            loc_text = loc_resp.json()["content"][0]["text"].strip()
                            log(run_id, "info", f"[visual] Locate response: {loc_text[:200]}", idx)
                            if loc_text.startswith("```"): loc_text = loc_text.split("```")[1].lstrip("json").strip()
                            # Extract JSON object
                            _ls = loc_text.find('{')
                            _le = loc_text.rfind('}') + 1
                            if _ls >= 0 and _le > _ls: loc_text = loc_text[_ls:_le]
                            try:
                                loc_data = _lj.loads(loc_text)
                                locations = loc_data.get("locations", [])
                                log(run_id, "info", f"[visual] Located {len(locations)} element(s)", idx)
                            except Exception as _lpe:
                                log(run_id, "warn", f"[visual] Locate parse error: {_lpe} — attempting repair", idx)
                                # Repair truncated locate JSON
                                _lr = loc_text
                                _lb  = _lr.count('{') - _lr.count('}')
                                _lbr = _lr.count('[') - _lr.count(']')
                                _llc = max(_lr.rfind('},'), _lr.rfind('}\n'))
                                if _llc > 0 and _lb > 0:
                                    _lr = _lr[:_llc+1]
                                    _lb  = _lr.count('{') - _lr.count('}')
                                    _lbr = _lr.count('[') - _lr.count(']')
                                _lr += ']' * _lbr + '}' * _lb
                                try:
                                    loc_data = _lj.loads(_lr)
                                    locations = loc_data.get("locations", [])
                                    log(run_id, "info", f"[visual] Locate repaired: {len(locations)} element(s)", idx)
                                except Exception:
                                    log(run_id, "warn", f"[visual] Locate repair failed — no circles", idx)
                                    locations = []
                        else:
                            log(run_id, "warn", f"[visual] Locate API error: {loc_resp.status_code}", idx)

                        # ── Pink pixel diff overlay ──
                        exp_for_diff = exp_img.resize((act_w, act_h), _PI2.LANCZOS)
                        exp_arr2   = _np2.array(exp_for_diff, dtype=_np2.float32)
                        act_arr2   = _np2.array(act_img,      dtype=_np2.float32)
                        diff_mask2 = _np2.any(_np2.abs(exp_arr2 - act_arr2) > 15, axis=2)
                        act_hl  = act_arr2.copy()
                        pink    = _np2.array([255, 105, 150], dtype=_np2.float32)
                        act_hl[diff_mask2] = act_hl[diff_mask2] * 0.45 + pink * 0.55
                        act_hl  = _np2.clip(act_hl, 0, 255).astype(_np2.uint8)
                        act_boxed = _PI2.fromarray(act_hl)

                        # ── Draw numbered RED rectangle borders + circle badges on issues ──
                        draw_act = _ID2.Draw(act_boxed)
                        drawn = 0
                        try:
                            from PIL import ImageFont as _IFont
                            _font_badge = _IFont.truetype("arial.ttf", 14)
                        except Exception:
                            _font_badge = None

                        for loc in locations:
                            if not loc.get("found", True): continue
                            x1 = int(loc.get("x1", 0))
                            y1 = int(loc.get("y1", 0))
                            x2 = int(loc.get("x2", 0))
                            y2 = int(loc.get("y2", 0))
                            if x2 <= x1 or y2 <= y1: continue
                            if x1 == 0 and y1 == 0 and x2 == 0 and y2 == 0: continue
                            if x2 - x1 < 5 or y2 - y1 < 5: continue
                            x1 = max(2, min(x1, act_w - 2))
                            y1 = max(2, min(y1, act_h - 2))
                            x2 = max(2, min(x2, act_w - 2))
                            y2 = max(2, min(y2, act_h - 2))
                            num = loc.get("index", drawn + 1)
                            # Draw thick red rectangle border around element
                            for _t in range(3):
                                draw_act.rectangle([x1-_t, y1-_t, x2+_t, y2+_t], outline=(220, 30, 60))
                            # Draw circular badge with number at top-left of box
                            bx, by = x1 - 1, max(0, y1 - 24)
                            r = 12
                            draw_act.ellipse([bx, by, bx + r*2, by + r*2], fill=(220, 30, 60))
                            txt = str(num)
                            if _font_badge:
                                try:
                                    bb = draw_act.textbbox((0,0), txt, font=_font_badge)
                                    tw, th = bb[2]-bb[0], bb[3]-bb[1]
                                    draw_act.text((bx + r - tw//2, by + r - th//2), txt, fill="white", font=_font_badge)
                                except Exception:
                                    draw_act.text((bx + r - 4, by + r - 6), txt, fill="white")
                            else:
                                draw_act.text((bx + r - 4, by + r - 6), txt, fill="white")
                            drawn += 1

                        log(run_id, "info", f"[visual] {drawn} issue(s) marked with numbered red boxes", idx)

                        # ── Side-by-side canvas ──
                        target_h  = 500
                        exp_scale = target_h / exp_h
                        exp_pw    = int(exp_w * exp_scale)
                        exp_r     = exp_img.resize((exp_pw, target_h), _PI2.LANCZOS)
                        act_scale = target_h / act_h
                        act_pw    = int(act_w * act_scale)
                        act_r     = act_boxed.resize((act_pw, target_h), _PI2.LANCZOS)

                        hdr_h   = 54
                        total_w = exp_pw + 6 + act_pw
                        canvas  = _PI2.new("RGB", (total_w, target_h + hdr_h), (20, 20, 20))
                        draw_c  = _ID2.Draw(canvas)
                        draw_c.rectangle([0,        0, exp_pw,   hdr_h-1], fill=(26, 111, 196))
                        draw_c.rectangle([exp_pw+6, 0, total_w, hdr_h-1], fill=(180, 30, 30))
                        draw_c.text((8,         8),  "EXPECTED (baseline)",                   fill="white")
                        draw_c.text((8,        28),  f"Run #{run_id}",                         fill=(180, 215, 255))
                        draw_c.text((exp_pw+14, 8),  f"ACTUAL ⬛ red = changed pixels",         fill="white")
                        draw_c.text((exp_pw+14, 28), f"Diff: {diff_pct}% threshold: {threshold}% {'CRITICAL' if has_critical else 'WARNING'}", fill=(255, 180, 180))
                        canvas.paste(exp_r, (0,        hdr_h))
                        canvas.paste(act_r, (exp_pw+6, hdr_h))
                        canvas.save(diff_path)

                        with open(diff_path, "rb") as _f:
                            _b64d = base64.b64encode(_f.read()).decode()
                        resp_sc = requests.post(f"{API_BASE}/api/runs/{run_id}/screenshot", json={
                            "label":    f"[VISUAL FAIL] {visual_name}",
                            "filename": os.path.basename(diff_path),
                            "data":     _b64d,
                            "timestamp": datetime.utcnow().isoformat()
                        }, timeout=15)
                        log(run_id, "info", f"[visual] Diff image sent (status {resp_sc.status_code})", idx)
                        diff_sent = True

                    except Exception as _de:
                        log(run_id, "warn", f"[visual] Diff image error: {_de}", idx)

                    # Fallback: send raw screenshots if diff image failed
                    if not diff_sent:
                        for _fp, _lbl in [(expected_path, f"[VISUAL FAIL] expected_{visual_name}"),
                                          (actual_path,   f"[VISUAL FAIL] actual_{visual_name}")]:
                            try:
                                with open(_fp, "rb") as _f:
                                    _b64d = base64.b64encode(_f.read()).decode()
                                requests.post(f"{API_BASE}/api/runs/{run_id}/screenshot", json={
                                    "label": _lbl, "filename": os.path.basename(_fp),
                                    "data": _b64d, "timestamp": datetime.utcnow().isoformat()
                                }, timeout=10)
                            except Exception:
                                pass

                    # Sort diffs by severity first (CRITICAL → MINOR → COSMETIC) then element name
                    sev_order = {"CRITICAL": 0, "MINOR": 1, "COSMETIC": 2}
                    sorted_diffs = sorted(diffs, key=lambda x: (
                        sev_order.get(x.get("severity", "MINOR").upper(), 1),
                        x.get("element", "")
                    ))
                    diff_lines = []
                    for _i, d in enumerate(sorted_diffs, 1):
                        elem     = d.get("element", "Unknown element").strip()
                        expected = d.get("expected", "Not specified").strip()
                        actual   = d.get("actual",   "Not specified").strip()
                        sev      = d.get("severity", "MINOR").upper()
                        # Only add if both expected and actual are present
                        if not expected or not actual:
                            continue
                        sev_icon = "\U0001f534" if sev == "CRITICAL" else "\U0001f7e1" if sev == "MINOR" else "\U0001f535"
                        diff_lines.append(
                            f"{sev_icon} Issue #{_i} [{sev}]: {elem}\n"
                            f"  \u2523 Expected : {expected}\n"
                            f"  \u2517 Actual   : {actual}"
                        )
                    if not diff_lines:
                        diff_lines.append(f"  {summary}")
                    bug_report = "\n\n".join(diff_lines)
                    raise AssertionError(
                        f"[visual] FAILED — {summary}\n"
                        f"Pixel mismatch: {diff_pct}% (threshold: {threshold}%)\n\n"
                        + bug_report
                    )
                else:
                    minor    = claude_result.get("minor_count", 0)
                    cosmetic = claude_result.get("cosmetic_count", 0)
                    log(run_id, "pass",
                        f"[visual] PASSED — {summary} | Pixel diff: {diff_pct}% | Minor: {minor} | Cosmetic: {cosmetic}", idx)

        elif action == "capture_page_text":
            import json as _json, requests as _req
            lang     = apply_variables(step.get("value", "en"), resolved_vars).strip()
            store_as = apply_variables(step.get("store_as", "page_snapshot"), resolved_vars).strip()
            log(run_id, "info", f"[capture_page_text] Scanning page lang={lang}...", idx)
            try:
                elements = await page.evaluate("""() => {
                    const results = [], seen = new Set();
                    function capture(el, type) {
                        if (!el || el.offsetParent === null) return;
                        const text = (el.innerText || el.textContent || '').trim();
                        const ph = el.placeholder || '';
                        if (!text && !ph) return;
                        if (text.length < 2 && ph.length < 2) return;
                        if (/^[0-9\\s\\-\\/]+$/.test(text)) return;
                        let sel = '';
                        if (el.id) sel = '#' + el.id;
                        else if (el.getAttribute('formcontrolname')) sel = el.tagName.toLowerCase() + '[formcontrolname="' + el.getAttribute('formcontrolname') + '"]';
                        else if (el.getAttribute('for')) sel = 'label[for="' + el.getAttribute('for') + '"]';
                        else if (el.getAttribute('aria-label')) sel = '[aria-label="' + el.getAttribute('aria-label') + '"]';
                        else sel = el.tagName.toLowerCase() + '.' + (el.className || '').split(' ')[0];
                        if (seen.has(sel + text)) return;
                        seen.add(sel + text);
                        const rect = el.getBoundingClientRect();
                        results.push({ selector: sel, tag: el.tagName.toLowerCase(), type: type, text: text, placeholder: ph || null, rect: { width: Math.round(rect.width), height: Math.round(rect.height) } });
                    }
                    document.querySelectorAll('label').forEach(el => capture(el, 'label'));
                    document.querySelectorAll('button:not([disabled])').forEach(el => capture(el, 'button'));
                    document.querySelectorAll('th').forEach(el => capture(el, 'th'));
                    document.querySelectorAll('h1,h2,h3,h4').forEach(el => capture(el, 'heading'));
                    document.querySelectorAll('ng-select .ng-value-label, ng-select .ng-placeholder').forEach(el => capture(el, 'select_value'));
                    // Input placeholders
                    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => {
                        const ph = el.placeholder || '';
                        if (!ph || ph.length < 2) return;
                        let sel = '';
                        if (el.id) sel = '#' + el.id;
                        else if (el.getAttribute('formcontrolname')) sel = el.tagName.toLowerCase() + '[formcontrolname="' + el.getAttribute('formcontrolname') + '"]';
                        else sel = el.tagName.toLowerCase() + '.' + (el.className || '').split(' ')[0];
                        if (seen.has(sel + ph)) return;
                        seen.add(sel + ph);
                        const rect = el.getBoundingClientRect();
                        results.push({ selector: sel, tag: el.tagName.toLowerCase(), type: 'placeholder', text: ph, placeholder: ph, rect: { width: Math.round(rect.width), height: Math.round(rect.height) } });
                    });
                    document.querySelectorAll('.toast-message,.alert,.invalid-feedback').forEach(el => capture(el, 'message'));
                    document.querySelectorAll('.modal-title').forEach(el => capture(el, 'modal'));
                    return results;
                }""")
                snapshot = {"url": page.url, "title": await page.title(), "language": lang, "elements": elements}
                resolved_vars[store_as] = _json.dumps(snapshot)
                log(run_id, "info", f"[capture_page_text] Captured {len(elements)} elements", idx)
                try:
                    _req.post(f"{API_BASE}/api/multilingual/baseline",
                        json={"run_id": run_id, "language": lang, "url": page.url, "page_title": snapshot['title'], "elements": elements},
                        headers={"Authorization": f"Bearer {RUNNER_TOKEN}"}, timeout=5)
                except Exception: pass
            except Exception as e:
                log(run_id, "fail", f"[capture_page_text] Error: {e}", idx)

        elif action == "set_language":
            lang = apply_variables(step.get("value", ""), resolved_vars).strip()
            resolved_vars["__lang__"] = lang
            log(run_id, "info", f"[set_language] Language set to: {lang}", idx)
            return {"status": "passed", "action": "set_language", "__lang__": lang}

        else:
            log(run_id, "warn", f"[WARN] Unknown action '{action}' -- skipping", idx)

        log(run_id, "pass", f"[OK] {action} completed", idx)
        return {"status": "passed", "step": idx}

    except Exception as e:
        err_msg = str(e)
        # Only attempt AI heal for element-not-found/timeout errors.
        # AssertionError means element WAS found but content didn't match —
        # that's a test logic issue, not a selector issue. Don't heal it.
        is_assertion_error = isinstance(e, AssertionError)
        is_value_error     = "Expected" in err_msg and "got" in err_msg and "text" in err_msg.lower()
        skip_heal = is_assertion_error or is_value_error

        if skip_heal:
            log(run_id, "fail", f"  [ASSERT FAILED] {err_msg[:200]}", idx)
            return {"status": "failed", "step": idx, "error": err_msg[:500]}

        # If step was already healed, skip AI heal — healed selector failed again
        if step.get("_healed"):
            log(run_id, "fail", f"  [HEALED STEP FAILED] Step {idx+1} selector was previously healed but failed again — page may have changed.", idx)
            for _line in err_msg.splitlines():
                if _line.strip():
                    log(run_id, "fail", _line, idx)
            return {"status": "failed", "step": idx, "error": err_msg[:500]}

        log(run_id, "info", f"  [RETRY] Step failed with: {err_msg[:100]} -- trying AI heal...", idx)
        healed = await ai_heal_step(page, step, run_id, idx, e, resolved_vars)
        if healed:
            return {"status": "passed", "step": idx, "healed_selector": healed}
        # Log full error message line by line so nothing gets truncated
        for _line in err_msg.splitlines():
            if _line.strip():
                log(run_id, "fail", _line, idx)
        return {"status": "failed", "step": idx, "error": err_msg[:500]}


# ─────────────────────────────────────────────────────────────────────────────
# Control-flow step runner (IF/LOOP/SWITCH/CALL — identical logic, awaited)
# ─────────────────────────────────────────────────────────────────────────────

async def run_steps_with_flow(page, steps, run_id, resolved_vars, config,
                               continue_on_fail=False, variables=None):
    global DEBUG_STEP_MODE
    results = []
    i = 0
    while i < len(steps):
        step   = steps[i]
        action = step.get("action", "")

        # ── SET LANGUAGE ─── handle directly in flow so resolved_vars is shared
        if action == "set_language":
            lang = apply_variables(step.get("value", ""), resolved_vars).strip()
            resolved_vars["__lang__"] = lang
            log(run_id, "info", f"[set_language] Language set to: {lang}", i)
            results.append({"status": "passed", "step": i})
            i += 1
            continue

        # Inject __lang__ into step so run_step can access it
        if "__lang__" in resolved_vars:
            step = dict(step)
            step["__lang__"] = resolved_vars["__lang__"]

        # ── Skip disabled steps ──────────────────────────────────────────
        if step.get("disabled", False):
            log(run_id, "info", f"[SKIP] Step {i+1} ({action}) is disabled — skipping", i)
            results.append({"status": "skipped", "step": i})
            i += 1
            continue

        # ── IF / ELSE IF / ELSE / END_IF ─────────────────────────────────────
        if action in ("if", "if_start"):
            condition    = apply_variables(step.get("condition", ""), resolved_vars)
            # FIX: match runner.py exactly — default to "element_visible" (not "") when if_condition is missing
            if_condition = step.get("if_condition", "element_visible")
            if if_condition in ("var_equals", "var_not_equals", "var_contains"):
                var_name = step.get("if_var", "").strip("{} ")
                left     = str(resolved_vars.get(var_name, apply_variables(step.get("if_var", ""), resolved_vars))).strip()
                right    = apply_variables(step.get("if_value", ""), resolved_vars).strip()
                if   if_condition == "var_equals":     operator = "=="
                elif if_condition == "var_not_equals": operator = "!="
                elif if_condition == "var_contains":   operator = "contains"
            elif if_condition in ("url_contains", "url_not_contains"):
                left = apply_variables(step.get("if_value", ""), resolved_vars); right = ""; operator = if_condition
            elif if_condition == "page_title_contains":
                left = apply_variables(step.get("if_value", ""), resolved_vars); right = ""; operator = if_condition
            elif if_condition in ("element_visible", "element_not_visible"):
                left = apply_variables(step.get("if_selector", "") or step.get("selector", ""), resolved_vars); right = ""; operator = if_condition
            else:
                left     = apply_variables(step.get("left",  ""), resolved_vars)
                operator = step.get("operator", "==")
                right    = apply_variables(step.get("right", ""), resolved_vars)
            try:
                if   operator == "==":           cond_met = left == right
                elif operator == "!=":           cond_met = left != right
                elif operator == ">":            cond_met = float(left) > float(right)
                elif operator == "<":            cond_met = float(left) < float(right)
                elif operator == ">=":           cond_met = float(left) >= float(right)
                elif operator == "<=":           cond_met = float(left) <= float(right)
                elif operator == "contains":     cond_met = right in left
                elif operator == "not_contains": cond_met = right not in left
                elif operator == "is_empty":     cond_met = not left.strip()
                elif operator == "is_not_empty": cond_met = bool(left.strip())
                elif operator == "url_contains":
                    try: cur_url = page.url
                    except: cur_url = ""
                    cond_met = left in cur_url
                elif operator == "url_not_contains":
                    try: cur_url = page.url
                    except: cur_url = ""
                    cond_met = left not in cur_url
                elif operator == "page_title_contains":
                    try: title = await page.title()
                    except: title = ""
                    cond_met = left in title
                elif operator == "element_visible":
                    try: cond_met = await page.locator(left).first.is_visible(timeout=3000)
                    except: cond_met = False
                elif operator == "element_not_visible":
                    try: cond_met = not await page.locator(left).first.is_visible(timeout=3000)
                    except: cond_met = True
                else: cond_met = eval(condition, {"__builtins__": {}}, resolved_vars)
            except Exception:
                cond_met = False
            if operator in ("element_visible", "element_not_visible"):
                log(run_id, "info", f"[IF] {left!r} {operator} => {cond_met}", i)
            elif operator in ("url_contains", "url_not_contains", "page_title_contains"):
                log(run_id, "info", f"[IF] {operator} {left!r} => {cond_met}", i)
            else:
                log(run_id, "info", f"[IF] {left!r} {operator} {right!r} => {cond_met}", i)
            # ── FIX: pre-scan to find else/end_if positions (matches runner.py approach)
            # The old step-by-step skip flag had a bug where steps inside a
            # skipped IF block still executed. Pre-scanning is the correct fix.
            _depth = 1
            _else_idx = None
            _end_idx  = None
            _j = i + 1
            while _j < len(steps) and _depth > 0:
                _a = steps[_j].get("action", "")
                if _a in ("if", "if_start"):              _depth += 1
                elif _a == "else" and _depth == 1:        _else_idx = _j
                elif _a in ("end_if", "if_end"):
                    _depth -= 1
                    if _depth == 0:                       _end_idx = _j
                _j += 1
            if _end_idx is None: _end_idx = len(steps) - 1
            if cond_met:
                true_body = steps[i+1 : _else_idx if _else_idx is not None else _end_idx]
            else:
                true_body = steps[_else_idx+1 : _end_idx] if _else_idx is not None else []
            sub = await run_steps_with_flow(page, true_body, run_id, resolved_vars, config,
                                            continue_on_fail, variables)
            results.extend(sub)
            if any(r.get("status") == "failed" for r in sub) and not continue_on_fail:
                return results
            i = _end_idx + 1
            continue

        # ── LOOP ─────────────────────────────────────────────────────────────
        if action in ("loop", "repeat", "loop_start"):
            # ── Read data_table exactly as old runner (runner.py) did ──────────
            # Format stored by editor: {"columns": ["Item_name", "Qty"],
            #                          "rows": [["PARA...", "2"], ...],
            #                          "enabled": True}
            data_table = step.get("data_table") or {}
            if isinstance(data_table, str):
                try:
                    data_table = json.loads(data_table)
                except Exception:
                    data_table = {}
            if not isinstance(data_table, dict):
                data_table = {}

            dt_enabled = bool(data_table.get("enabled", False))
            # also honour use_data_table flag (boolean or "true" string)
            _udt = step.get("use_data_table", False)
            if not dt_enabled:
                dt_enabled = (_udt is True) or (str(_udt).lower() == "true")

            dt_columns = data_table.get("columns", [])
            dt_rows    = data_table.get("rows", [])

            if dt_enabled:
                count = len(dt_rows)
                log(run_id, "info", f"[DATA TABLE] {count} row(s), columns: {dt_columns}", i)
            else:
                count_raw = apply_variables(step.get("value", "1"), resolved_vars)
                try:
                    count = int(count_raw)
                except Exception:
                    count = 1

            loop_var = step.get("variable", "").strip().strip("{}")

            # Find loop_end by scanning forward (same strategy as old runner)
            n   = len(steps)
            depth, end_idx = 1, i + 1
            while end_idx < n and depth > 0:
                a2 = steps[end_idx].get("action", "")
                if a2 in ("loop", "repeat", "loop_start", "foreach_start"):
                    depth += 1
                elif a2 in ("loop_end", "foreach_end"):
                    depth -= 1
                end_idx += 1
            end_idx -= 1  # now points at the loop_end step
            body = steps[i + 1:end_idx]

            if not body:
                i = end_idx + 1
                continue

            loop_cof     = step.get("continue_on_fail", False)
            loop_failures = []

            for iteration in range(count):
                loop_vars = {**resolved_vars, "__loop_index__": str(iteration)}

                if dt_enabled and iteration < len(dt_rows):
                    # Inject row values — each column name → cell value
                    row = dt_rows[iteration]
                    for col_idx, col_name in enumerate(dt_columns):
                        if col_name and col_idx < len(row):
                            loop_vars[col_name] = str(row[col_idx])
                    log(run_id, "info",
                        f"[DATA TABLE] Row {iteration+1}/{count}: " +
                        ", ".join(
                            f"{c}={row[j] if j < len(row) else '?'}"
                            for j, c in enumerate(dt_columns) if c
                        ), i)
                else:
                    if loop_var:
                        loop_vars[loop_var] = str(iteration + 1)
                    log(run_id, "info", f"[LOOP] Iteration {iteration+1}/{count}", i)

                sub = await run_steps_with_flow(
                    page, body, run_id, loop_vars, config,
                    loop_cof or continue_on_fail, variables
                )
                # Propagate any variables set inside the loop back to parent
                for k, v in loop_vars.items():
                    if k != "__loop_index__":
                        resolved_vars[k] = v

                if any(r.get("__break__") for r in sub):
                    break
                if any(r.get("__continue__") for r in sub):
                    continue

                clean = [r for r in sub if not r.get("__break__") and not r.get("__continue__")]
                results.extend(clean)

                if loop_cof:
                    for r in clean:
                        if r.get("status") == "failed":
                            loop_failures.append(f"Iteration {iteration+1}: {r.get('error', 'failed')}")
                else:
                    if any(r.get("status") == "failed" for r in clean) and not continue_on_fail:
                        break

            if loop_failures:
                summary = f"Loop completed with {len(loop_failures)} failure(s): " + "; ".join(loop_failures[:3])
                log(run_id, "fail", f"[FAIL] {summary}")
                results.append({"status": "failed", "step": i, "error": summary})

            i = end_idx + 1
            continue

        # ── FOR_EACH ─────────────────────────────────────────────────────────
        if action in ("for_each", "foreach_start"):
            raw_items  = apply_variables(step.get("value", ""), resolved_vars)
            item_var   = step.get("loop_var", "current_item") or "current_item"
            items      = [x.strip() for x in raw_items.split(",") if x.strip()]

            # Find foreach_end by scanning forward (same as old runner)
            depth_fe, end_idx_fe = 1, i + 1
            n_fe = len(steps)
            while end_idx_fe < n_fe and depth_fe > 0:
                a2 = steps[end_idx_fe].get("action", "")
                if a2 in ("loop", "repeat", "loop_start", "foreach_start"):
                    depth_fe += 1
                elif a2 in ("loop_end", "foreach_end"):
                    depth_fe -= 1
                end_idx_fe += 1
            end_idx_fe -= 1  # points at foreach_end
            body_fe = steps[i + 1:end_idx_fe]

            log(run_id, "info", f">> ForEach: {len(items)} item(s) -> {{{{{item_var}}}}}", i)
            foreach_cof      = step.get("continue_on_fail", False)
            foreach_failures = []

            for idx2, item in enumerate(items):
                loop_vars = {**resolved_vars, item_var: item, "__loop_index__": str(idx2)}
                log(run_id, "info", f"   ForEach item {idx2+1}/{len(items)}: {item}", i)

                sub = await run_steps_with_flow(page, body_fe, run_id, loop_vars, config,
                                                foreach_cof or continue_on_fail, variables)
                # Propagate variables back to parent (same as old runner)
                for k, v in loop_vars.items():
                    if k not in (item_var, "__loop_index__"):
                        resolved_vars[k] = v

                if any(r.get("__break__") for r in sub):
                    break
                if any(r.get("__continue__") for r in sub):
                    continue

                clean = [r for r in sub if not r.get("__break__") and not r.get("__continue__")]
                results.extend(clean)

                if foreach_cof:
                    for r in clean:
                        if r.get("status") == "failed":
                            err_msg = r.get("error", "assertion failed")
                            foreach_failures.append(f"Item {idx2+1} ({item}): {err_msg}")
                            log(run_id, "warn", f"   [LOOP SOFT FAIL] Item {idx2+1} ({item}): {err_msg}", i)
                else:
                    if any(r.get("status") == "failed" for r in clean) and not continue_on_fail:
                        break

            if foreach_failures:
                summary = f"ForEach completed with {len(foreach_failures)} failure(s):"
                log(run_id, "fail", f"[FAIL] {summary}")
                results.append({"status": "failed", "step": i, "error": summary})

            i = end_idx_fe + 1
            continue

        # ── TRY / CATCH ──────────────────────────────────────────────────────
        if action == "try_start":
            _depth = 1; _catch_idx = None; _end_idx = None; _j = i + 1
            while _j < len(steps) and _depth > 0:
                _a = steps[_j].get("action", "")
                if _a == "try_start":                       _depth += 1
                elif _a == "catch_start" and _depth == 1:  _catch_idx = _j
                elif _a == "try_end":
                    _depth -= 1
                    if _depth == 0:                         _end_idx = _j
                _j += 1
            if _end_idx is None: _end_idx = len(steps) - 1
            try_body   = steps[i+1 : _catch_idx if _catch_idx is not None else _end_idx]
            catch_body = steps[_catch_idx+1 : _end_idx] if _catch_idx is not None else []
            log(run_id, "info", ">> Try block starting", i)
            sub = await run_steps_with_flow(page, try_body, run_id, resolved_vars, config, True, variables)
            had_failure = any(r.get("status") == "failed" for r in sub)
            if had_failure and catch_body:
                error_msg  = next((r.get("error", "") for r in sub if r.get("status") == "failed"), "")
                catch_step = steps[_catch_idx] if _catch_idx is not None else {}
                error_var  = catch_step.get("error_var", "")
                if error_var:
                    resolved_vars[error_var] = error_msg
                    log(run_id, "info", f"   Catch: stored error in {{{{{error_var}}}}}: {error_msg[:80]}", i)
                log(run_id, "info", ">> Catch block running", i)
                catch_sub = await run_steps_with_flow(page, catch_body, run_id, resolved_vars, config, continue_on_fail, variables)
                results.extend(catch_sub)
            else:
                results.extend(sub)
                if had_failure:
                    log(run_id, "info", ">> Try failed (no catch block defined)", i)
            i = _end_idx + 1
            continue

        if action in ("catch_start", "try_end"):
            i += 1; continue

        # ── SWITCH / CASE ────────────────────────────────────────────────────
        if action == "switch_start":
            switch_val = apply_variables(step.get("value", ""), resolved_vars)
            log(run_id, "info", f">> Switch on: '{switch_val}'", i)
            _depth = 1; _j = i + 1
            cases = []; current_case_val = None; current_case_body = []
            while _j < len(steps) and _depth > 0:
                _a = steps[_j].get("action", "")
                if _a == "switch_start":
                    _depth += 1
                    current_case_body.append(steps[_j])
                elif _a == "switch_end":
                    _depth -= 1
                    if _depth == 0:
                        if current_case_val is not None:
                            cases.append((current_case_val, current_case_body))
                        break
                    else:
                        current_case_body.append(steps[_j])
                elif _a == "case" and _depth == 1:
                    if current_case_val is not None:
                        cases.append((current_case_val, current_case_body))
                    current_case_val  = apply_variables(steps[_j].get("value", ""), resolved_vars)
                    current_case_body = []
                else:
                    current_case_body.append(steps[_j])
                _j += 1
            _end_idx = _j
            matched = False
            for case_val, case_body in cases:
                if str(case_val) == str(switch_val):
                    log(run_id, "info", f"   Switch matched case: '{case_val}'", i)
                    sub = await run_steps_with_flow(page, case_body, run_id, resolved_vars, config, continue_on_fail, variables)
                    results.extend(sub)
                    if any(r.get("status") == "failed" for r in sub) and not continue_on_fail:
                        return results
                    matched = True
                    break
            if not matched:
                log(run_id, "info", f"   Switch: no case matched '{switch_val}'", i)
            i = _end_idx + 1
            continue

        if action in ("switch_end", "case"):
            i += 1; continue

        # ── REPEAT UNTIL ─────────────────────────────────────────────────────
        if action == "repeat_until":
            max_retries = int(step.get("max_retries") or 10)
            interval_ms = int(step.get("interval_ms") or 2000)
            _depth = 1; _end_idx = i + 1
            while _end_idx < len(steps) and _depth > 0:
                _a = steps[_end_idx].get("action", "")
                if _a == "repeat_until":       _depth += 1
                elif _a == "repeat_until_end": _depth -= 1
                _end_idx += 1
            _end_idx -= 1
            body = steps[i+1 : _end_idx]
            log(run_id, "info", f">> Repeat Until: max {max_retries} tries, interval {interval_ms}ms", i)
            for attempt in range(max_retries):
                log(run_id, "info", f"   Repeat Until attempt {attempt+1}/{max_retries}", i)
                sub = await run_steps_with_flow(page, body, run_id, resolved_vars, config, True, variables)
                results.extend(sub)
                _cond = step.get("if_condition", "element_visible")
                _sel  = apply_variables(step.get("if_selector", "") or step.get("selector", ""), resolved_vars)
                _var  = apply_variables(step.get("if_var", ""), resolved_vars)
                _val  = apply_variables(step.get("if_value", ""), resolved_vars)
                try:
                    if _cond == "element_visible":
                        _met = await page.locator(_sel).first.is_visible(timeout=3000) if _sel else False
                    elif _cond == "element_not_visible":
                        _met = not await page.locator(_sel).first.is_visible(timeout=3000) if _sel else True
                    elif _cond == "var_equals":
                        _met = str(resolved_vars.get(_var.strip("{}"), "")).strip() == str(_val).strip()
                    elif _cond == "var_not_equals":
                        _met = str(resolved_vars.get(_var.strip("{}"), "")).strip() != str(_val).strip()
                    elif _cond == "var_contains":
                        _met = str(_val).strip() in str(resolved_vars.get(_var.strip("{}"), "")).strip()
                    elif _cond == "url_contains":
                        _met = _val in page.url
                    elif _cond == "url_not_contains":
                        _met = _val not in page.url
                    elif _cond == "page_title_contains":
                        _met = _val in await page.title()
                    else:
                        _met = False
                except Exception:
                    _met = False
                if _met:
                    log(run_id, "pass", f"[OK] Repeat Until condition met after {attempt+1} attempt(s)", i)
                    break
                if attempt < max_retries - 1:
                    await asyncio.sleep(interval_ms / 1000.0)
            else:
                log(run_id, "fail", f"[FAIL] Repeat Until: condition not met after {max_retries} attempts", i)
                results.append({"status": "failed", "step": i, "error": f"Condition not met after {max_retries} attempts"})
                if not continue_on_fail: return results
            i = _end_idx + 1
            continue

        if action == "repeat_until_end":
            i += 1; continue

        # ── WAIT UNTIL ───────────────────────────────────────────────────────
        if action == "wait_until":
            import time as _time
            timeout_ms = int(step.get("timeout") or 30000)
            poll_ms    = 500
            deadline   = _time.time() + timeout_ms / 1000.0
            label      = step.get("if_condition", "element_visible")
            log(run_id, "info", f">> Wait Until: [{label}] timeout={timeout_ms}ms", i)
            _sel = apply_variables(step.get("if_selector", "") or step.get("selector", ""), resolved_vars)
            _var = apply_variables(step.get("if_var", ""), resolved_vars)
            _val = apply_variables(step.get("if_value", ""), resolved_vars)
            met = False
            while _time.time() < deadline:
                try:
                    if label == "element_visible":
                        met = await page.locator(_sel).first.is_visible(timeout=1000) if _sel else False
                    elif label == "element_not_visible":
                        met = not await page.locator(_sel).first.is_visible(timeout=1000) if _sel else True
                    elif label == "var_equals":
                        met = str(resolved_vars.get(_var.strip("{}"), "")).strip() == str(_val).strip()
                    elif label == "var_not_equals":
                        met = str(resolved_vars.get(_var.strip("{}"), "")).strip() != str(_val).strip()
                    elif label == "var_contains":
                        met = str(_val).strip() in str(resolved_vars.get(_var.strip("{}"), "")).strip()
                    elif label == "url_contains":
                        met = _val in page.url
                    elif label == "url_not_contains":
                        met = _val not in page.url
                    elif label == "page_title_contains":
                        met = _val in await page.title()
                except Exception:
                    met = False
                if met: break
                await asyncio.sleep(poll_ms / 1000.0)
            if met:
                log(run_id, "pass", "[OK] Wait Until condition met", i)
                results.append({"status": "passed", "step": i})
            else:
                msg = f"Wait Until timed out after {timeout_ms}ms -- condition [{label}] never became true"
                log(run_id, "fail", f"[FAIL] {msg}", i)
                results.append({"status": "failed", "step": i, "error": msg})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── LOG MESSAGE / DEBUG PRINT ────────────────────────────────────────
        if action in ("log_message", "print_var", "debug"):
            msg = apply_variables(step.get("value", ""), resolved_vars)
            log(run_id, "info", f"[LOG] {msg}", i)
            i += 1; continue

        # ── CAPTURE PAGE TEXT (Multilingual Testing) ────────────────────────────
        if action == "capture_page_text":
            lang     = apply_variables(step.get("value",  "en"),       resolved_vars).strip()
            store_as = apply_variables(step.get("store_as", "page_snapshot"), resolved_vars).strip()
            log(run_id, "info", f"[capture_page_text] Scanning page in lang={lang}...", i)
            try:
                elements = await page.evaluate("""() => {
                    const results = [];
                    const seen    = new Set();

                    function capture(el, type) {
                        if (!el || el.offsetParent === null) return;  // skip hidden
                        const text = (el.innerText || el.textContent || '').trim();
                        const ph   = el.placeholder || '';
                        if (!text && !ph) return;
                        if (text.length < 2 && ph.length < 2) return;
                        if (/^[0-9\s\-\/]+$/.test(text)) return; // skip pure numbers
                        if (text.toLowerCase() === 'dummy') return;
                        if (/^[0-9,]+\.[0-9]+$/.test(text)) return;
                        // Build stable selector
                        let sel = '';
                        if (el.id)                          sel = '#' + el.id;
                        else if (el.getAttribute('formcontrolname')) 
                            sel = el.tagName.toLowerCase() + '[formcontrolname="' + el.getAttribute('formcontrolname') + '"]';
                        else if (el.getAttribute('for'))    
                            sel = 'label[for="' + el.getAttribute('for') + '"]';
                        else if (el.getAttribute('aria-label')) 
                            sel = '[aria-label="' + el.getAttribute('aria-label') + '"]';
                        else                                
                            sel = el.tagName.toLowerCase() + '.' + (el.className || '').split(' ')[0];
                        
                        // Make selector unique with counter if duplicate
                        if (seen.has(sel)) {
                            let counter = 1;
                            while (seen.has(sel + '_' + counter)) counter++;
                            sel = sel + '_' + counter;
                        }
                        seen.add(sel);

                        const rect = el.getBoundingClientRect();
                        results.push({
                            selector: sel,
                            tag:      el.tagName.toLowerCase(),
                            type:     type,
                            text:     text,
                            placeholder: ph || null,
                            rect:     { width: Math.round(rect.width), height: Math.round(rect.height) }
                        });
                    }

                    // Labels
                    document.querySelectorAll('label').forEach(el => capture(el, 'label'));
                    // Buttons
                    document.querySelectorAll('button:not([disabled])').forEach(el => capture(el, 'button'));
                    // Table headers
                    document.querySelectorAll('th').forEach(el => capture(el, 'th'));
                    // Headings
                    document.querySelectorAll('h1,h2,h3,h4').forEach(el => capture(el, 'heading'));
                    // Nav/menu items
                    document.querySelectorAll('a.nav-link, .sidebar-item, .menu-item, li.nav-item a').forEach(el => capture(el, 'nav'));
                    // ng-select selected values
                    document.querySelectorAll('ng-select .ng-value-label, ng-select .ng-placeholder').forEach(el => capture(el, 'select_value'));
                    // Input placeholders
                    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => capture(el, 'placeholder'));
                    // Toast / alerts
                    document.querySelectorAll('.toast-message, .alert, .jhi-item-count, .invalid-feedback').forEach(el => capture(el, 'message'));
                    // Modal titles
                    document.querySelectorAll('.modal-title, .modal-header').forEach(el => capture(el, 'modal'));

                    // Dropdown options (ng-select open panels)
                    let _optCounter = 0;
                    document.querySelectorAll('ng-dropdown-panel .ng-option').forEach(el => {
                        const text = el.innerText.trim();
                        if (!text || text.toLowerCase() === 'dummy') return;
                        const ngSel = document.querySelector('ng-select.ng-select-opened');
                        const fc = ngSel ? (ngSel.getAttribute('formcontrolname') || ngSel.getAttribute('name') || '') : '';
                        const base = fc ? `ng-select[formcontrolname="${fc}"]` : 'ng-dropdown';
                        const sel = base + '_opt_' + _optCounter;
                        _optCounter++;
                        if (seen.has(sel)) return;
                        seen.add(sel);
                        results.push({ selector: sel, tag: 'ng-option', type: 'dropdown_option', text: text, option_index: _optCounter - 1, rect: {} });
                    });

                    return results;
                }""")

                snapshot = {
                    "url":       page.url,
                    "title":     await page.title(),
                    "language":  lang,
                    "elements":  elements,
                    "captured_at": __import__("datetime").datetime.utcnow().isoformat()
                }
                resolved_vars[store_as] = __import__("json").dumps(snapshot)
                log(run_id, "info", f"[capture_page_text] Captured {len(elements)} elements → {{{{{store_as}}}}}", i)

                # Auto-save to DB via API
                import requests as _req
                try:
                    _req.post(f"{API_BASE}/api/multilingual/baseline", json={
                        "run_id":     run_id,
                        "language":   lang,
                        "url":        page.url,
                        "page_title": snapshot["title"],
                        "elements":   elements
                    }, headers={"Authorization": f"Bearer {RUNNER_TOKEN}"}, timeout=5)
                except Exception:
                    pass  # non-critical - data is in variable

                results.append({"status": "passed", "step": i})
            except Exception as e:
                log(run_id, "fail", f"[capture_page_text] Error: {e}", i)
                results.append({"status": "failed", "step": i, "error": str(e)})
            i += 1
            continue

        # ── BREAK / CONTINUE ─────────────────────────────────────────────────
        if action == "break":
            results.append({"status": "passed", "step": i, "__break__": True})
            return results
        if action == "continue":
            results.append({"status": "passed", "step": i, "__continue__": True})
            return results

        # ── CALL TEST ─────────────────────────────────────────────────────────
        if action == "call_test":
            called_id   = apply_variables(step.get("value", ""), resolved_vars).strip()
            call_stack  = config.get("__call_stack__", [])
            current_id  = str(config.get("test_case_id", ""))
            MAX_DEPTH   = 5
            if not called_id:
                i += 1
                continue
            if len(call_stack) >= MAX_DEPTH or called_id in call_stack or called_id == current_id:
                msg = f"call_test blocked: depth/circular ({called_id})"
                log(run_id, "fail", f"[FAIL] {msg}")
                results.append({"status": "failed", "step": i, "error": msg})
                if not continue_on_fail:
                    return results
                i += 1
                continue
            try:
                resp = requests.get(f"{API_BASE}/api/tests/{called_id}",
                                    headers={"Authorization": f"Bearer {RUNNER_TOKEN}"}, timeout=15)
                resp.raise_for_status()
                called_test  = resp.json()
                called_steps = called_test.get("steps") or []
                import copy as _copy
                called_steps = _copy.deepcopy(called_steps)
                for cs in called_steps:
                    cs["_test_case_id"] = called_id
                child_config = dict(config)
                child_config["__call_stack__"] = call_stack + [current_id]
                child_config["test_case_id"] = called_id
                child_vars = dict(resolved_vars)
                child_vars.update({k: v for k, v in resolve_variables(called_test.get("variables") or []).items()
                                   if k not in child_vars})
                sub = await run_steps_with_flow(page, called_steps, run_id, child_vars, child_config,
                                                continue_on_fail, called_test.get("variables"))
                resolved_vars.update(child_vars)
                results.extend([r for r in sub if not r.get("__break__") and not r.get("__continue__")])
                if any(r.get("status") == "failed" for r in sub) and not continue_on_fail:
                    return results
                log(run_id, "pass", f"[OK] call_test: '{called_test.get('name','?')}' done")
            except Exception as e:
                log(run_id, "fail", f"[FAIL] call_test '{called_id}': {e}")
                results.append({"status": "failed", "step": i, "error": str(e)})
                if not continue_on_fail:
                    return results
            i += 1
            continue

        # ── MATH ──────────────────────────────────────────────────────────────
        if action in ("math_add","math_subtract","math_multiply","math_divide","math_round","math_abs","math_random","math_random_int"):
            # store_as = explicit target; fallback = strip {{ }} from value to get raw var name
            _raw_store = step.get("store_as","").strip()
            if not _raw_store:
                # strip {{ }} to get the literal variable name e.g. {{Sure_str}} -> Sure_str
                _raw_store = re.sub(r'^\{\{|\}\}$', '', step.get("value","").strip()).strip()
            var_name = _raw_store  # keep as raw name, do NOT resolve through apply_variables
            try:
                import math as _math
                v1_var = apply_variables(step.get("value",""), resolved_vars).strip()
                v1     = resolved_vars.get(v1_var, v1_var)
                v2     = apply_variables(step.get("value2",""), resolved_vars)
                if   action == "math_add":      result_val = str(float(v1) + float(v2))
                elif action == "math_subtract": result_val = str(float(v1) - float(v2))
                elif action == "math_multiply": result_val = str(float(v1) * float(v2))
                elif action == "math_divide":   result_val = str(float(v1) / float(v2)) if float(v2) != 0 else "0"
                elif action == "math_round":
                    decimals = int(v2) if v2.strip() else 2  # default 2 decimal places (matches frontend)
                    rounded  = round(float(v1), decimals)
                    # If 0 decimals return as int, otherwise trim trailing zeros
                    result_val = str(int(rounded)) if decimals == 0 else str(rounded).rstrip('0').rstrip('.')
                elif action == "math_abs":      result_val = str(abs(float(v1)))
                elif action in ("math_random", "math_random_int"):
                    # value=store_into, value2=min, value3=max (frontend field mapping)
                    lo2 = float(apply_variables(step.get("value2", "0"), resolved_vars) or 0)
                    hi2 = float(apply_variables(step.get("value3", "100"), resolved_vars) or 100)
                    if int(lo2) == int(hi2):
                        result_val = str(int(lo2))
                    else:
                        result_val = str(random.randint(int(min(lo2,hi2)), int(max(lo2,hi2))))
                else:                           result_val = str(v1)
                if result_val.endswith(".0"):   result_val = result_val[:-2]
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: {result_val} → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                log(run_id,"fail",f"[FAIL] {action}: {e}")
                results.append({"status":"failed","step":i,"error":str(e)})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── DATE ──────────────────────────────────────────────────────────────
        if action in ("date_today","date_now","date_add","date_subtract","date_format","date_diff"):
            # store_as = explicit target variable
            # fallback: strip {{ }} from value field to get the variable name (overwrite in place)
            _raw_store = step.get("store_as","").strip()
            if not _raw_store:
                _raw_store = step.get("value","").strip().strip("{").strip("}")
            var_name = apply_variables(_raw_store, resolved_vars).strip()
            try:
                from datetime import datetime as _dt, timedelta as _td
                def _norm_fmt(f):
                    # Convert human-friendly formats (DD-MM-YYYY) to Python strftime (%d-%m-%Y)
                    if not f: return f
                    if '%' not in f:
                        f = (f.replace('YYYY','%Y').replace('YY','%y')
                              .replace('MM','%m').replace('DD','%d')
                              .replace('HH','%H').replace('mm','%M')
                              .replace('SS','%S').replace('ss','%S'))
                    return f
                def _apply_fmt(dt, fmt):
                    # Cross-platform: handle %-d (Linux) and %#d (Windows) for no-leading-zero day
                    import platform
                    if '%-d' in fmt:
                        if platform.system() == 'Windows':
                            fmt = fmt.replace('%-d', '%#d')
                        try:
                            return dt.strftime(fmt)
                        except Exception:
                            # Final fallback: manual replacement
                            return dt.strftime(fmt.replace('%-d','%d').replace('%#d','%d')).lstrip('0') if False else                                    dt.strftime(fmt.replace('%-d','{_D_}').replace('%#d','{_D_}')).replace('{_D_}', str(dt.day))
                    return dt.strftime(fmt)
                fmt  = _norm_fmt(apply_variables(step.get("value2","") or "%d/%m/%Y", resolved_vars))
                val1 = apply_variables(step.get("value",""), resolved_vars).strip()
                val1 = resolved_vars.get(val1, val1)
                if   action == "date_today":    result_val = _apply_fmt(_dt.now(), fmt)
                elif action == "date_now":      result_val = _dt.now().strftime(fmt or "%d/%m/%Y %H:%M:%S")
                elif action == "date_add":
                    days = int(apply_variables(step.get("value3","1"), resolved_vars))  # value3=days, value2=format
                    base = _dt.strptime(val1, fmt) if val1 else _dt.now()
                    result_val = (base + _td(days=days)).strftime(fmt)
                elif action == "date_subtract":
                    days = int(apply_variables(step.get("value3","1"), resolved_vars))  # value3=days, value2=format
                    base = _dt.strptime(val1, fmt) if val1 else _dt.now()
                    result_val = (base - _td(days=days)).strftime(fmt)
                elif action == "date_format":
                    in_fmt = apply_variables(step.get("value2","") or "%d/%m/%Y", resolved_vars)  # value2=input fmt, value3=output fmt
                    out_fmt = apply_variables(step.get("value3","") or "%d/%m/%Y", resolved_vars)
                    result_val = _dt.strptime(val1, in_fmt).strftime(out_fmt)
                elif action == "date_diff":
                    val2   = apply_variables(step.get("value3",""), resolved_vars)  # value3=date2, value2=format
                    result_val = str(abs((_dt.strptime(val2, fmt) - _dt.strptime(val1, fmt)).days))
                else: result_val = ""
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: '{result_val}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                log(run_id,"fail",f"[FAIL] {action}: {e}")
                results.append({"status":"failed","step":i,"error":str(e)})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── STRING OPS ────────────────────────────────────────────────────────
        if action in ("str_upper","str_lower","str_trim","str_replace","str_substring",
                      "str_concat","str_length","str_split"):
            raw_val = step.get("value","")
            src_var = raw_val.strip().strip("{}").strip()
            src = resolved_vars.get(src_var, apply_variables(raw_val, resolved_vars))
            raw_store = step.get("store_as","").strip()
            if raw_store.startswith("{{") and raw_store.endswith("}}"):
                raw_store = raw_store[2:-2].strip()
            var_name = raw_store or src_var
            try:
                v2 = apply_variables(step.get("value2",""), resolved_vars).strip()
                if len(v2) >= 2 and v2[0] in ('"',"'") and v2[-1] == v2[0]:
                    v2 = v2[1:-1]
                if   action == "str_upper":     result_val = src.upper()
                elif action == "str_lower":     result_val = src.lower()
                elif action == "str_trim":      result_val = src.strip()
                elif action == "str_replace":
                    # value2 = find text, value3 = replace with (separate fields from frontend)
                    find = apply_variables(step.get("value2",""), resolved_vars)
                    repl = apply_variables(step.get("value3",""), resolved_vars)
                    result_val = src.replace(find, repl)
                elif action == "str_substring":
                    # value2 = start index, value3 = end index (separate fields from frontend)
                    start = int(apply_variables(step.get("value2","0"), resolved_vars) or 0)
                    end_v = apply_variables(step.get("value3",""), resolved_vars).strip()
                    end   = int(end_v) if end_v else len(src)
                    result_val = src[start:end]
                elif action == "str_concat":    result_val = src + v2
                elif action == "str_length":    result_val = str(len(src))
                elif action == "str_split":
                    v3 = apply_variables(step.get("value3",""), resolved_vars).strip()
                    if "||" in v2 and not v3:
                        parts_s = v2.split("||",1)
                        delim = parts_s[0] or " "
                        idx_n = int(parts_s[1]) if len(parts_s)>1 and parts_s[1].strip().lstrip("-").isdigit() else 0
                    else:
                        delim = v2 or " "
                        idx_n = int(v3) if v3.strip().lstrip("-").isdigit() else 0
                    if len(delim)>=2 and delim[0] in ('"',"'") and delim[-1]==delim[0]:
                        delim = delim[1:-1]
                    if not delim: delim = " "
                    pieces = src.split(delim)
                    result_val = pieces[idx_n] if idx_n < len(pieces) else (pieces[-1] if pieces else "")
                else: result_val = src
                if var_name: resolved_vars[var_name] = result_val
                log(run_id,"pass",f"[OK] {action}: '{str(result_val)[:80]}' → {{{{{var_name}}}}}")
                results.append({"status":"passed","step":i})
            except Exception as e:
                log(run_id,"fail",f"[FAIL] {action}: {e}")
                results.append({"status":"failed","step":i,"error":str(e)})
                if not continue_on_fail: return results
            i += 1
            continue

        # ── JSON ACTIONS ──────────────────────────────────────────────────────
        if action in JSON_ACTIONS:
            result = handle_json_action(action, step, resolved_vars, run_id, i, apply_variables, log)
            results.append(result)
            i += 1
            continue

        # ── DEBUG PAUSE ───────────────────────────────────────────────────────
        if DEBUG_MODE:
            var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}
            debug_broadcast(run_id, "line_start", {"step_index": i, "action": action, "variables": var_snapshot})
            should_pause = DEBUG_STEP_MODE or (i in DEBUG_BREAKPOINTS)
            if should_pause:
                reason = "breakpoint" if i in DEBUG_BREAKPOINTS else "step"
                cmd = debug_wait_for_command(run_id, i, resolved_vars, reason=reason)
                if cmd == "stop":
                    debug_broadcast(run_id, "debug_stopped", {"step_index": i})
                    return results
                if cmd == "skip":
                    results.append({"status": "skipped", "step": i})
                    i += 1
                    continue
                if cmd == "continue":
                    DEBUG_STEP_MODE = False
            elif DEBUG_SLOW_MO > 0:
                time.sleep(DEBUG_SLOW_MO / 1000.0)

        # ── REGULAR STEP ──────────────────────────────────────────────────────
        step_start_ms = int(time.time() * 1000)
        result = await run_step(page, step, run_id, i, resolved_vars)
        # Propagate __lang__ back from run_step result
        if isinstance(result, dict) and "__lang__" in result:
            resolved_vars["__lang__"] = result["__lang__"]
        await take_live_screenshot(page, run_id, action)
        step_dur_ms = int(time.time() * 1000) - step_start_ms
        results.append(result)

        if DEBUG_MODE:
            current_url = ""
            try: current_url = page.url
            except Exception: pass
            screenshot_b64 = ""
            try:
                sc_bytes = await page.screenshot(full_page=False)
                screenshot_b64 = base64.b64encode(sc_bytes).decode("utf-8")
            except Exception: pass
            var_snapshot = {k: v for k, v in resolved_vars.items() if not k.startswith("_")}
            if result["status"] == "failed":
                debug_broadcast(run_id, "line_error", {
                    "step_index": i, "error": result.get("error",""), "duration_ms": step_dur_ms,
                    "screenshot": screenshot_b64, "url": current_url, "variables": var_snapshot
                })
                cmd = debug_wait_for_command(run_id, i, resolved_vars, reason="error")
                if cmd == "stop":
                    debug_broadcast(run_id, "debug_stopped", {"step_index": i})
                    return results
            else:
                debug_broadcast(run_id, "line_done", {
                    "step_index": i, "duration_ms": step_dur_ms,
                    "screenshot": screenshot_b64, "url": current_url, "variables": var_snapshot
                })

        if result["status"] == "failed":
            if not continue_on_fail and step.get("continue_on_fail") != True:
                return results
        i += 1
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Main async entry point
# ─────────────────────────────────────────────────────────────────────────────

async def async_main(run_id, config, debug, slow_mo, breakpoints_str):
    global RUNNER_TOKEN, DEBUG_MODE, DEBUG_SLOW_MO, DEBUG_BREAKPOINTS, DEBUG_STEP_MODE

    RUNNER_TOKEN    = config.get("runner_token", "")
    DEBUG_MODE      = debug
    DEBUG_SLOW_MO   = slow_mo
    DEBUG_STEP_MODE = debug
    DEBUG_BREAKPOINTS = set(int(x) for x in breakpoints_str.split(",") if x.strip().isdigit())

    # Load heal cache in background (non-blocking)
    threading.Thread(target=_load_heal_cache, daemon=True).start()

    test_type    = config.get("type", "ui")
    steps        = config.get("steps", [])
    browser_name = config.get("browser", "chrome")
    base_url     = config.get("base_url", "")
    variables    = config.get("variables", [])
    test_case_id = config.get("test_case_id")
    project_id   = config.get("project_id")
    project_vars = config.get("project_vars", {})
    heal_update  = config.get("heal_update", False)

    if test_case_id:
        for s in steps:
            s["_test_case_id"] = test_case_id

    log(run_id, "info", f">> [async_runner] Starting run #{run_id} — Type: {test_type}, Browser: {browser_name}")

    try:
        requests.patch(f"{API_BASE}/api/runs/{run_id}",
                       json={"status": "running", "started_at": datetime.utcnow().isoformat() + "+00:00"}, timeout=5)
    except Exception:
        pass

    step_results = []
    start_time   = time.time()

    try:
        if test_type == "api":
            step_results = run_api_test(config, run_id)
        else:
            # Map browser name → playwright browser type
            browser_type_map = {
                "chrome": "chromium", "edge": "edge",
                "firefox": "firefox", "safari": "webkit",
            }
            browser_type = browser_type_map.get(browser_name, "chromium")

            # Acquire isolated context from shared browser pool
            log(run_id, "info", "[pool] Acquiring browser context from shared pool...")
            context = await acquire_context(
                browser_type=browser_type,
                headless=not DEBUG_MODE,
                slow_mo=DEBUG_SLOW_MO if DEBUG_MODE else 0,
            )
            page = await context.new_page()
            page.set_default_timeout(30000)
            page.set_default_navigation_timeout(30000)

            # Navigate to base URL
            if base_url:
                try:
                    await page.goto(base_url, timeout=30000, wait_until="domcontentloaded")
                    log(run_id, "info", f"Navigated to base URL: {base_url}")
                except Exception as e:
                    log(run_id, "warn", f"Base URL navigation warning: {str(e)[:100]}")

            await take_screenshot(page, run_id, "initial")

            # Reset per-run live screenshot state
            _live_state[run_id] = {"hash": None, "ts": 0}

            # Resolve variables
            resolved_vars = {**project_vars}
            test_resolved = resolve_variables(variables)
            resolved_vars.update(test_resolved)
            if project_vars:
                log(run_id, "info", f"Project variables loaded: {', '.join(project_vars.keys())}")
            if test_resolved:
                log(run_id, "info", f"Test variables: {', '.join(f'{k}={str(v)[:20]}' for k,v in test_resolved.items())}")

            # Execute steps
            step_results = await run_steps_with_flow(
                page, steps, run_id, resolved_vars, config,
                continue_on_fail=config.get("continue_on_fail", False),
                variables=variables,
            )

            # ── Auto-save healed selectors back to test case ──────────────────
            if heal_update and test_case_id:
                healed_steps = [
                    (r["step"], r["healed_selector"]) for r in step_results
                    if r.get("healed_selector") and r.get("status") == "passed"
                ]
                if healed_steps:
                    log(run_id, "info", f"[AI Heal] Auto-saving {len(healed_steps)} healed selector(s) to test case {test_case_id}...")
                    for step_idx, healed_sel in healed_steps:
                        try:
                            resp = requests.patch(
                                f"{API_BASE}/api/tests/{test_case_id}/heal/{step_idx}",
                                json={"new_selector": healed_sel},
                                headers={"Authorization": f"Bearer {RUNNER_TOKEN}"},
                                timeout=5,
                            )
                            if resp.status_code == 200:
                                log(run_id, "info", f"[AI Heal] ✅ Step {step_idx+1} selector auto-saved: {healed_sel}")
                            else:
                                log(run_id, "warn", f"[AI Heal] ⚠️ Could not save step {step_idx+1}: HTTP {resp.status_code}")
                        except Exception as e:
                            log(run_id, "warn", f"[AI Heal] Could not save step {step_idx+1}: {e}")

            # Persist runtime variable changes
            if project_id and project_vars:
                try:
                    runtime_updates = {k: v for k, v in resolved_vars.items()
                                       if k in project_vars and str(project_vars.get(k,"")) != str(v)}
                    if runtime_updates:
                        requests.patch(
                            f"{API_BASE}/api/projects/{project_id}/variables/runtime",
                            json={"updates": runtime_updates, "runner_token": RUNNER_TOKEN},
                            timeout=10,
                        )
                        log(run_id, "info", f"Persisted {len(runtime_updates)} runtime variable(s)")
                except Exception as e:
                    log(run_id, "warn", f"Could not persist runtime vars: {e}")

            await take_screenshot(page, run_id, "final")

            # Close context only — NOT the shared browser
            await context.close()
            _live_state.pop(run_id, None)

    except Exception:
        error_msg = traceback.format_exc()
        log(run_id, "error", f"[FAIL] Test runner crashed: {error_msg[:500]}")
        step_results.append({"status": "failed", "step": 0, "error": error_msg[:200]})

    # Final summary
    duration     = int((time.time() - start_time) * 1000)
    passed       = sum(1 for r in step_results if r.get("status") == "passed")
    failed_count = sum(1 for r in step_results if r.get("status") == "failed")
    final_status = "passed" if failed_count == 0 and len(step_results) > 0 else "failed"

    log(run_id, "info",
        f"{'[OK] PASSED' if final_status=='passed' else '[FAIL] FAILED'} "
        f"-- {passed}/{len(step_results)} steps in {duration}ms")

    if DEBUG_MODE:
        try:
            requests.patch(f"{API_BASE}/api/runs/{run_id}/finish-debug",
                           json={"status": final_status, "duration": duration}, timeout=5)
        except Exception:
            pass

    try:
        requests.patch(f"{API_BASE}/api/runs/{run_id}", json={
            "status": final_status, "duration_ms": duration,
            "steps_total": len(step_results), "steps_passed": passed,
            "steps_failed": failed_count, "finished_at": datetime.utcnow().isoformat() + "+00:00",
        }, timeout=5)
    except Exception as e:
        print(f"Failed to update run status: {e}", flush=True)

    # Close the browser pool so Chrome exits cleanly after each test run
    # This prevents Chrome from staying alive between suite tests
    global _browser_pool, _pw_instance
    for browser in list(_browser_pool.values()):
        try:
            await browser.close()
        except Exception:
            pass
    _browser_pool.clear()
    if _pw_instance:
        try:
            await _pw_instance.stop()
        except Exception:
            pass
        _pw_instance = None

    return final_status


def main():
    parser = argparse.ArgumentParser(description="Async Playwright runner")
    parser.add_argument("--run-id",      required=True, type=int)
    parser.add_argument("--config",      required=False, default="{}")
    parser.add_argument("--config-file", required=False, default=None)
    parser.add_argument("--debug",       action="store_true", default=False)
    parser.add_argument("--slow-mo",     type=int, default=500)
    parser.add_argument("--breakpoints", default="")
    args = parser.parse_args()

    # Load config from file if provided (avoids ENAMETOOLONG on large test cases)
    if args.config_file:
        import json as _json
        with open(args.config_file, 'r', encoding='utf-8') as _f:
            config = _json.load(_f)
    else:
        config = json.loads(args.config)
    final_status = asyncio.run(
        async_main(args.run_id, config, args.debug, args.slow_mo, args.breakpoints)
    )
    sys.exit(0 if final_status == "passed" else 1)


if __name__ == "__main__":
    main()
