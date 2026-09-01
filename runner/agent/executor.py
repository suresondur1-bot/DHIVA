"""
ATHMA Visual QA Agent — executor (stage 4a).

Performs ONE built step on a live Playwright page. This is the agent's "hands".
It deliberately handles the same control types perception detects, including
ng-select (open -> type -> pick option), the way the existing runner's
search_select does. Self-contained: uses only the Playwright `page`, imports
no runner code, changes no runner code.

The emitted SCRIPT (script_writer) uses the SAME action names as the runner, so
replay goes through async_runner.py, not through this file. This executor exists
only for the live authoring loop.
"""
from playwright.async_api import TimeoutError as PWTimeout

# Module-level store for date variables set by date_today action
_date_vars = {}


async def execute(page, step: dict, timeout: int = 8000):
    """Run one runner-style step dict on the page. Raises on hard failure."""
    action = step.get("action")
    selector = step.get("selector")
    value = step.get("value")

    # Interpolate date variables in selector (e.g. {{today_aria_e34}} -> actual date string)
    if selector and "{{" in selector:
        for var, val in _date_vars.items():
            selector = selector.replace("{{" + var + "}}", val)

    if action == "navigate":
        await page.goto(value, wait_until="domcontentloaded", timeout=30000)

    elif action == "type":
        el = page.locator(selector).first
        await el.scroll_into_view_if_needed(timeout=timeout)
        await el.click(timeout=timeout)
        await el.fill("")            # clear first
        await el.fill(str(value), timeout=timeout)
        # Commit the value: many Angular forms only fire change/blur handlers
        # when focus LEAVES the field (e.g. Pincode auto-fills City/District/
        # State on blur). Press Tab so dependent cascades actually run.
        try:
            await el.press("Tab", timeout=2000)
        except Exception:
            pass
        await page.wait_for_timeout(300)  # let any cascade fire

    elif action == "clear":
        await page.locator(selector).first.fill("", timeout=timeout)

    elif action == "click":
        el = page.locator(selector).first
        await el.scroll_into_view_if_needed(timeout=timeout)
        await el.click(timeout=timeout)

    elif action == "double_click":
        await page.locator(selector).first.dblclick(timeout=timeout)

    elif action == "select":  # native <select>
        await page.locator(selector).first.select_option(label=str(value), timeout=timeout)

    elif action == "search_select":  # ng-select: open, type to filter, pick option
        await _ng_select(page, selector, str(value), timeout)

    elif action == "pick_first":  # open a popup/dropdown and pick the FIRST option
        await _pick_first(page, selector, timeout)

    elif action == "check":
        await page.locator(selector).first.check(timeout=timeout)

    elif action == "uncheck":
        await page.locator(selector).first.uncheck(timeout=timeout)

    elif action == "press":
        await page.locator(selector).first.press(str(value), timeout=timeout)

    elif action == "hover":
        await page.locator(selector).first.hover(timeout=timeout)

    elif action == "scroll":
        # A targeted scroll brings an element into view; a null-selector scroll
        # should scroll the PAGE (the agent sometimes emits scroll with no ref).
        if selector and selector != "None":
            await page.locator(selector).first.scroll_into_view_if_needed(timeout=timeout)
        else:
            direction = (str(value or "down")).lower()
            dy = -600 if "up" in direction else 600
            await page.evaluate("(dy) => window.scrollBy(0, dy)", dy)
            await page.wait_for_timeout(300)

    elif action == "date_today":
        from datetime import datetime
        fmt = step.get("value2") or "%d/%m/%Y"
        store_as = step.get("value") or "today"
        # Store in page context via evaluate so subsequent steps can use it
        # We also store in a module-level dict for selector interpolation
        val = datetime.now().strftime(fmt)
        _date_vars[store_as] = val
        print(f"  [date_today] {store_as} = {val}")

    elif action == "wait":
        try:
            await page.wait_for_timeout(int(value or 1000))
        except (ValueError, TypeError):
            await page.wait_for_timeout(1000)

    elif action == "wait_for_selector":
        await page.wait_for_selector(selector, timeout=timeout)

    else:
        raise ValueError(f"executor: unsupported action '{action}'")


async def _pick_first(page, selector, timeout):
    """
    Open a control that shows a popup (e.g. the Slot picker) and click the FIRST
    selectable option in it. Tuned for the Athma slot picker, which:
      - is a READONLY input (#slot) whose own click is intercepted by a sibling
        addon/clock icon (input-group-addon-bordered) -> we must click the ADDON
        (or use a JS click) to open it, not the input.
      - opens a MODAL (ngb-modal-window) that loads slots ASYNCHRONOUSLY -> we
        POLL until a slot appears.
      - leaves the modal open afterwards -> we WAIT for it to close so the next
        step's clicks aren't intercepted.
    No typing.
    """
    await _open_slot_popup(page, selector, timeout)

    # Slot options live inside the modal as:
    #   <span class="slot-time-container available">          <- clickable
    #   <span class="slot-time-container not-available">      <- disabled
    #   <span class="slot-time-container available selected-slot"> <- already chosen
    # So target an AVAILABLE slot that is NOT already selected, preferring the modal scope.
    candidates = [
        ".modal-body span.slot-time-container.available:not(.selected-slot):not(.not-available)",
        "ngb-modal-window span.slot-time-container.available:not(.selected-slot):not(.not-available)",
        "span.slot-time-container.available:not(.selected-slot):not(.not-available)",
        # fall back to any available slot (even if it reads as selected)
        ".modal-body span.slot-time-container.available",
        "span.slot-time-container.available",
    ]

    # Poll up to ~12s: slots load after a network call, so keep re-checking.
    deadline_ms = 12000
    waited = 0
    step = 500
    while waited < deadline_ms:
        for sel in candidates:
            loc = page.locator(sel)
            try:
                n = await loc.count()
            except Exception:
                n = 0
            for i in range(min(n, 20)):
                item = loc.nth(i)
                try:
                    if not await item.is_visible():
                        continue
                    # The modal intercepts normal pointer events, so click the
                    # slot via JavaScript dispatch which ignores overlays.
                    await item.evaluate("""el => {
                        el.scrollIntoView({block:'center'});
                        el.click();
                        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
                    }""")
                    await page.wait_for_timeout(500)
                    # confirm/close the modal if a button is needed
                    await _confirm_slot_modal(page)
                    await _wait_modal_closed(page)
                    if not await _modal_open(page):
                        return   # slot picked AND modal closed
                except Exception:
                    continue
        await page.wait_for_timeout(step)
        waited += step

    # If we got here the modal may still be open — try once more to close it so
    # the rest of the form is reachable, then report the situation.
    await _confirm_slot_modal(page)
    await _wait_modal_closed(page)
    if await _modal_open(page):
        raise RuntimeError("pick_first: a slot was targeted but the slot modal "
                           "would not close (no Select/confirm button matched). "
                           "The modal is still intercepting clicks.")


async def _open_slot_popup(page, selector, timeout):
    """Open the slot popup, working around the addon/overlay that intercepts clicks."""
    # 1) Prefer clicking the addon/clock trigger that sits next to the input.
    #    From the page: <div ... class="input-group-addon-bordered athma-pointer">
    addon_candidates = [
        ".input-group-addon-bordered",
        f"{selector} ~ .input-group-addon-bordered",
        f"{selector} + * .input-group-addon-bordered",
    ]
    for asel in addon_candidates:
        try:
            addon = page.locator(asel).first
            if await addon.count() and await addon.is_visible():
                await addon.scroll_into_view_if_needed(timeout=timeout)
                await addon.click(timeout=3000)
                await page.wait_for_timeout(600)
                if await _modal_open(page):
                    return
        except Exception:
            continue

    # 2) Fallback: JS click directly on the field, bypassing any overlay.
    try:
        el = page.locator(selector).first
        await el.scroll_into_view_if_needed(timeout=timeout)
        await el.evaluate("e => e.click()")
        await page.wait_for_timeout(600)
        if await _modal_open(page):
            return
    except Exception:
        pass

    # 3) Last resort: a forced normal click on the field.
    try:
        await page.locator(selector).first.click(timeout=3000, force=True)
        await page.wait_for_timeout(600)
    except Exception:
        pass


async def _modal_open(page) -> bool:
    try:
        return await page.locator("ngb-modal-window, .modal-body").first.is_visible(timeout=1000)
    except Exception:
        return False


async def _confirm_slot_modal(page):
    """Try to confirm/close the slot modal. The modal auto-selects a slot, so the
    job is mainly to dismiss it. Tries, in order: a footer Select/OK/Done button,
    then a header close (×), then the Escape key — all via JS where possible so
    pointer interception doesn't block us. Optional: failure is tolerated."""
    btn_texts = ["select", "confirm", "ok", "done", "save", "apply", "proceed", "add", "continue"]
    try:
        # 1) text-matched footer/body button via JS click
        clicked = await page.evaluate("""(texts) => {
            const scope = document.querySelector('ngb-modal-window');
            if (!scope) return false;
            const btns = Array.from(scope.querySelectorAll('button'));
            for (const b of btns) {
                const t = (b.innerText||'').trim().toLowerCase();
                if (!t) continue;
                if (texts.some(x => t === x || t.includes(x)) && !b.disabled) {
                    b.click(); return true;
                }
            }
            return false;
        }""", btn_texts)
        if clicked:
            await page.wait_for_timeout(400)
            return
        # 2) header close button (×) via JS
        closed = await page.evaluate("""() => {
            const scope = document.querySelector('ngb-modal-window');
            if (!scope) return false;
            const x = scope.querySelector('.close, .modal-header button, [aria-label=\"Close\"], [aria-label=\"close\"]');
            if (x) { x.click(); return true; }
            return false;
        }""")
        if closed:
            await page.wait_for_timeout(400)
            return
        # 3) Escape key as last resort
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
    except Exception:
        pass


async def _wait_modal_closed(page, deadline_ms: int = 5000):
    """After picking a slot, wait for the modal to dismiss so later clicks land."""
    waited = 0
    while waited < deadline_ms:
        if not await _modal_open(page):
            return
        await page.wait_for_timeout(300)
        waited += 300


async def _ng_select(page, selector, value, timeout):
    """Type-to-search picker. Handles TWO widget families:
      A) ng-select (registration: Sex, Consultant, City) -> inner input + .ng-option
      B) plain textbox autocomplete (indent: #indentStoreInput, #issueStoreInput,
         #itemInput) -> type into the field itself, pick from a typeahead dropdown.
    Tries ng-select first; if this isn't an ng-select, falls back to the generic
    autocomplete path. Always tries to PICK a suggestion (these fields usually do
    not register on type+blur alone).
    """
    box = page.locator(selector).first
    await box.scroll_into_view_if_needed(timeout=timeout)

    # Is this an ng-select wrapper, or a plain input?
    is_ng = False
    try:
        tag = (await box.evaluate("e => e.tagName.toLowerCase()")) or ""
        cls = (await box.evaluate("e => e.className || ''")) or ""
        is_ng = tag == "ng-select" or "ng-select" in cls
    except Exception:
        pass

    if is_ng:
        await box.click(timeout=timeout)
        try:
            inp = box.locator("input[type=text]").first
            await inp.fill(value, timeout=2000)
        except PWTimeout:
            try:
                await page.locator("ng-dropdown-panel input, .ng-input input").first.fill(value, timeout=2000)
            except PWTimeout:
                pass
        # Wait for the filtered option to actually RENDER before clicking. The
        # batch dropdown loads its list after a network/debounce delay, so a
        # fixed 500ms wait used to fire before KILLA12 appeared -> 3-4 retries.
        # Poll up to ~4s for a matching (or any) option, then pick. Cuts the
        # batch pick to a single attempt in the normal case.
        option = page.locator(".ng-option, ng-dropdown-panel .ng-option").filter(has_text=value).first
        try:
            await option.wait_for(state="visible", timeout=4000)
        except PWTimeout:
            # value-specific option didn't show; wait for ANY option to be ready
            try:
                await page.locator(".ng-option, ng-dropdown-panel .ng-option").first.wait_for(
                    state="visible", timeout=2000)
            except PWTimeout:
                pass
        try:
            await option.click(timeout=3000)
        except PWTimeout:
            await page.locator(".ng-option").first.click(timeout=3000)
        return

    # ── Plain textbox autocomplete (indent store/issue/item) ──────────────────
    await _autocomplete_pick(page, box, value, timeout)


async def _autocomplete_pick(page, box, value, timeout):
    """Type into a plain input and pick a suggestion from the typeahead dropdown.

    Key behaviour (learned on the indent store/item fields): the user often types
    a CODE that does NOT appear verbatim in the suggestion LABEL (the label shows
    the store/item *name*). So text-matching the typed value against the label
    fails. The reliable rule: after typing, look at how many suggestions are
    showing. If exactly ONE, pick it (the search already disambiguated). If
    several, prefer a label that contains the value, else the first. Pick ONCE
    and stop — never re-select.
    """
    await box.click(timeout=timeout)
    await box.fill("", timeout=timeout)
    # Type character-by-character so the typeahead's keyup/search fires.
    await box.type(str(value), delay=40, timeout=timeout)

    # Suggestion containers seen across Angular typeaheads / ngb-typeahead / lists.
    option_sels = [
        "ngb-typeahead-window button",
        "ngb-typeahead-window .dropdown-item",
        ".dropdown-menu.show .dropdown-item",
        ".dropdown-menu .dropdown-item",
        "[role=option]",
        ".autocomplete-items div",
        ".typeahead .item, .typeahead li",
        "ul.dropdown-menu li",
        ".suggestions li, .suggestion-list li",
        ".ng-option",
    ]

    # Poll for suggestions to RENDER instead of a single fixed wait. The store
    # search round-trips to the server, so options can take ~1-2s; a flat wait
    # was either too short (missed them -> retries -> slow) or wastefully long.
    # Return as soon as a container has a visible row; cap ~3.5s.
    active_sel = None
    count = 0
    waited = 0
    while waited < 3500:
        for sel in option_sels:
            try:
                loc = page.locator(sel)
                n = await loc.count()
                if not n:
                    continue
                vis = 0
                for i in range(min(n, 30)):
                    try:
                        if await loc.nth(i).is_visible():
                            vis += 1
                    except Exception:
                        pass
                if vis:
                    active_sel = sel
                    count = vis
                    break
            except Exception:
                continue
        if active_sel:
            break
        await page.wait_for_timeout(200)
        waited += 200

    if not active_sel:
        # No dropdown rendered — keyboard fallback (highlight first + Enter).
        try:
            await box.press("ArrowDown", timeout=1500)
            await page.wait_for_timeout(200)
            await box.press("Enter", timeout=1500)
            await page.wait_for_timeout(300)
        except Exception:
            pass
        return

    loc = page.locator(active_sel)

    # CASE 1 — exactly one suggestion: the search disambiguated it; pick it. This
    # is the normal case when the user typed a specific code.
    if count == 1:
        try:
            await _click_first_visible(loc)
            await page.wait_for_timeout(300)
        except Exception:
            pass
        return

    # CASE 2 — several suggestions: prefer one whose label contains the typed value
    # (handles plain name searches), else just take the first visible one.
    needle = str(value).strip()
    try:
        match = loc.filter(has_text=needle).first
        if await match.count() and await match.is_visible():
            await match.click(timeout=2500)
            await page.wait_for_timeout(300)
            return
    except Exception:
        pass
    try:
        await _click_first_visible(loc)
        await page.wait_for_timeout(300)
    except Exception:
        pass


async def _click_first_visible(loc):
    """Click the first visible element in a locator set."""
    n = await loc.count()
    for i in range(min(n, 30)):
        item = loc.nth(i)
        try:
            if await item.is_visible():
                await item.click(timeout=2500)
                return
        except Exception:
            continue


# ── Verify helpers (cheap rule checks; the loop calls LLM verify only if needed)
async def verify_value(page, selector, expected) -> bool:
    try:
        v = await page.locator(selector).first.input_value(timeout=3000)
        return str(expected).lower() in (v or "").lower()
    except Exception:
        return False


async def verify_visible(page, selector) -> bool:
    try:
        return await page.locator(selector).first.is_visible(timeout=3000)
    except Exception:
        return False
