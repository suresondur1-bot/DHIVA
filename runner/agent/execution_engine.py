"""
ATHMA Smart Author -- Execution Engine (Layer 3)

Deterministic execution using widget patterns. NO AI here.
Supports multi-screen flows with runtime variable substitution.
"""
import os

from knowledge_base import get_widget_pattern, ScreenKnowledge, WIDGET_PATTERNS
from executor import execute
from script_writer import ScriptWriter


async def run_smart_author(
    page,
    goal: str,
    field_value_list: list,
    knowledge: ScreenKnowledge,
    login_user: str = "admin",
    login_password: str = "admin",
) -> str:
    writer       = ScriptWriter(goal, start_url=page.url)
    date_vars    = {}  # date_today variables: ref -> var_name
    runtime_vars = {}  # captured at authoring time: SAIPR -> DRAFT-643

    def resolve(v):
        """Replace {{VAR}} with values captured during this authoring run."""
        if not isinstance(v, str):
            return v
        for var, val in runtime_vars.items():
            v = v.replace("{{" + var + "}}", val)
        return v

    # -- Set up network interceptor to capture PR number from API response --
    import re as _re
    captured_doc_numbers = {}  # store_as -> doc number

    async def _on_response(response):
        """Intercept API responses to capture document numbers before toast disappears."""
        try:
            if response.status not in (200, 201):
                return
            url = response.url
            if not any(x in url for x in ["purchase-requisition", "indent", "stock-correction", "patient"]):
                return
            # Only POST/PUT responses (saves)
            if response.request.method not in ("POST", "PUT"):
                return
            body = await response.json()
            # Look for document number in common response fields
            doc_no = (
                body.get("documentNo") or body.get("prNumber") or
                body.get("docNumber") or body.get("indentNo") or
                body.get("documentNumber") or ""
            )
            if not doc_no:
                # Try nested structures
                data = body.get("data") or body.get("result") or {}
                if isinstance(data, dict):
                    doc_no = data.get("documentNo") or data.get("prNumber") or ""
            if doc_no:
                # Store in all pending store_text variables
                for fi in field_value_list:
                    if fi.get("action_hint") == "store_text" and fi.get("store_as"):
                        rv = fi["store_as"]
                        if rv not in runtime_vars:
                            runtime_vars[rv] = str(doc_no)
                            print(f"  [api-capture] {url} -> {rv} = '{doc_no}'")
        except Exception:
            pass

    page.on("response", _on_response)

    # -- Dismiss any lingering modal before starting ----------------------
    try:
        modal = await page.query_selector("ngb-modal-window")
        if modal:
            print("  [init] modal detected -- dismissing before starting")
            closed = await page.evaluate("""
                () => {
                    const modal = document.querySelector('ngb-modal-window');
                    if (!modal) return false;
                    const btn = modal.querySelector(
                        '.close, button[aria-label="Close"], button[aria-label="close"], '
                        + '.btn-secondary, button.athma-btn-outline'
                    );
                    if (btn) { btn.click(); return true; }
                    return false;
                }
            """)
            if not closed:
                await page.keyboard.press("Escape")
            await page.wait_for_timeout(1000)
            print("  [init] modal dismissed")
    except Exception:
        pass

    for item in field_value_list:
        field_name  = item.get("field", "")
        value       = resolve(item.get("value"))   # resolved for execution
        orig_value  = item.get("value")             # original with {{VAR}} for script
        action_hint = item.get("action_hint", "")
        store_as    = item.get("store_as")

        print(f"\n[smart-author] Field: '{field_name}' | Value: {value!r} | Hint: {action_hint}")

        # -- wait ----------------------------------------------------------
        if action_hint == "wait":
            try:
                ms = int(value or 1000)
                step = {"action": "wait", "value": str(ms)}
                await execute(page, step)
                writer.add(step, note=f"wait {ms}ms")
            except (ValueError, TypeError):
                print(f"  [skip] wait with non-numeric value '{value}'")
            continue

        # -- store_text ----------------------------------------------------
        if action_hint == "store_text":
            var_name      = store_as or "result"
            full_var      = f"{var_name}_full"
            confirmed_sel = "ngb-alert:has-text('saved')"

            # Write replay steps -- runner will capture the toast at replay time
            writer.add({"action": "wait", "value": "500"}, note="wait for confirmation")
            writer.add({"action": "wait_for_selector", "selector": confirmed_sel},
                       note="wait for save confirmation")
            writer.add({"action": "store_text", "selector": confirmed_sel, "store_as": full_var},
                       note="store confirmation text")
            writer.add({"action": "str_split", "value": full_var, "value2": " ",
                        "value3": "0", "store_as": var_name},
                       note=f"extract document number into {var_name}")

            # Try to capture at authoring time for {{VAR}} substitution in later steps
            # But don't block if it fails -- the replay script handles it correctly
            if var_name not in runtime_vars:
                try:
                    await page.wait_for_selector(confirmed_sel, timeout=5000)
                    txt = await page.locator(confirmed_sel).first.inner_text(timeout=2000)
                    pr_number = txt.strip().split()[0]
                    runtime_vars[var_name] = pr_number
                    print(f"  [store] {var_name} = '{pr_number}'")
                except Exception:
                    print(f"  [store] toast not captured at authoring time -- OK, replay will handle it")
            continue

        # -- navigate ------------------------------------------------------
        if action_hint == "navigate":
            url  = resolve(str(value or ""))
            step = {"action": "navigate", "value": url}
            await execute(page, step)
            await page.wait_for_timeout(2000)
            writer.add(step, note=f"navigate to {url}")
            if url:
                from knowledge_base import load_screen_knowledge
                new_kb = load_screen_knowledge(url)
                if new_kb:
                    knowledge = new_kb
                    print(f"  [nav] loaded knowledge: {new_kb.slug}")
            # After navigating to list page, the store_text step handles capture
            continue

        # -- find_record ---------------------------------------------------
        if action_hint == "find_record":
            record_id = resolve(str(value or ""))  # resolved for authoring-time click
            orig_value = str(item.get("value") or "")  # original {{SAIPR}} for script
            print(f"  [find] clicking result '{record_id}' on screen")
            # Write steps using ORIGINAL variable reference so replay substitutes correctly
            writer.add({"action": "wait", "value": "2000"}, note="wait for search results")
            writer.add({"action": "click", "selector": f"text='{orig_value}'"}, note=f"open {orig_value}")
            writer.add({"action": "wait_for_selector", "selector": "#prDescription"}, note="wait for form")
            writer.add({"action": "wait", "value": "1000"}, note="wait for form to settle")
            # Try at authoring time with resolved value
            try:
                await page.wait_for_timeout(2000)
                await page.get_by_text(record_id, exact=True).first.click(timeout=10000)
                await page.wait_for_timeout(1000)
                await page.wait_for_selector("#prDescription", timeout=15000)
                await page.wait_for_timeout(1000)
                print(f"  [find] opened {record_id} successfully")
            except Exception as e:
                print(f"  [find] authoring-time click failed (OK, replay will handle): {e}")
            continue

        # -- Find the element in knowledge base ----------------------------
        direct_selector = resolve(item.get("selector") or "")
        # Use original value for script writing if it contains {{VAR}}
        script_value = orig_value if (orig_value and "{{" in str(orig_value)) else value
        if direct_selector:
            element = dict(knowledge.find_element(field_name) or {})
            element["selector"] = direct_selector
            if not element.get("type"):
                if action_hint == "search_select":  element["type"] = "combobox"
                elif action_hint == "type":          element["type"] = "textbox"
                elif action_hint == "click":         element["type"] = "button"
                elif action_hint == "date_picker":   element["type"] = "dateinput"
            print(f"  [direct] using selector: {direct_selector}")
        else:
            element = knowledge.find_element(field_name)

        if not element:
            print(f"  [warn] '{field_name}' not found -- skipping")
            continue

        selector = element.get("selector") or ""
        print(f"  [match] '{element.get('name')}' | selector: {selector}")

        # -- Get widget pattern --------------------------------------------
        if action_hint == "date_picker":
            idx = field_value_list.index(item) if item in field_value_list else -1
            calendar_already_opened = any(
                "calendar" in (field_value_list[i].get("field", "")).lower()
                for i in range(max(0, idx - 1), idx)
            )
            if calendar_already_opened:
                pattern = {
                    "description": "Date picker -- calendar already open",
                    "match": lambda el: False,
                    "steps": [
                        {"action": "date_today", "value": "__today_aria__", "value2": "%A, %B %#d, %Y"},
                        {"action": "wait", "value": "500"},
                        {"action": "click", "selector": "[aria-label='__today_aria_val__']"},
                        {"action": "wait", "value": "300"},
                    ],
                    "supports_value": False,
                }
            else:
                pattern = WIDGET_PATTERNS["ngbdatepicker"]
        elif action_hint == "type":         pattern = WIDGET_PATTERNS["textbox"]
        elif action_hint == "click":        pattern = WIDGET_PATTERNS["button"]
        elif action_hint == "search_select": pattern = WIDGET_PATTERNS["ng-select"]
        else:                               pattern = get_widget_pattern(element)

        if pattern is None:
            print(f"  [warn] no widget pattern for '{field_name}' -- skipping")
            continue

        if pattern["steps"] == []:
            print(f"  [skip] '{field_name}' is auto-populated/readonly")
            continue

        # -- Execute each step in the pattern ------------------------------
        for step_template in pattern["steps"]:
            step = _resolve_step(step_template, element, value, knowledge, date_vars, store_as)
            if step is None:
                continue

            print(f"  [exec] {step}")
            try:
                await execute(page, step)
                await page.wait_for_timeout(400)

                if step.get("action") == "click" and "btnNext" in (step.get("selector") or ""):
                    print("  [wait] waiting for form to load after Continue...")
                    await page.wait_for_timeout(2000)
                    try:
                        await page.wait_for_selector("#prDescription", timeout=10000)
                        print("  [wait] form loaded -- #prDescription visible")
                    except Exception:
                        print("  [warn] #prDescription not found after Continue")

                # For script writing, preserve {{VAR}} references
                write_step = dict(step)
                if script_value and "{{" in str(script_value) and write_step.get("value") == str(value):
                    write_step["value"] = str(script_value)
                writer.add(write_step, note=str(field_name))
            except Exception as e:
                print(f"  [error] {e} -- continuing")

        if action_hint == "search_select" and _is_item_selector(selector):
            print(f"  [wait] auto-populate after item selection")
            await page.wait_for_timeout(1500)
            writer.add({"action": "wait", "value": "1500"}, note="wait for auto-populate")

    out_dir = os.path.join(os.path.dirname(__file__), "output")
    path = writer.save(out_dir=out_dir, user=login_user, password=login_password)
    print(f"\n[smart-author] Script saved: {path} ({len(writer.steps)} steps)")
    return path


def _resolve_step(template, element, value, knowledge, date_vars, store_as):
    step     = dict(template)
    selector = element.get("selector") or ""

    if step.get("selector") == "__selector__":
        step["selector"] = selector

    if step.get("value") == "__value__":
        if value is None:
            return None
        step["value"] = str(value)

    if step.get("selector") == "__picker_button__":
        picker_sel = knowledge.get_picker_button_selector(element)
        if not picker_sel:
            print(f"  [warn] no picker button for {selector}")
            return None
        step["selector"] = picker_sel

    if step.get("action") == "date_today" and step.get("value") == "__today_aria__":
        var_name = f"today_aria_{element.get('ref', 'dt')}"
        step["value"] = var_name
        date_vars[element.get("ref", "dt")] = var_name

    if step.get("action") == "click" and "__today_aria_val__" in (step.get("selector") or ""):
        ref      = element.get("ref", "dt")
        var_name = date_vars.get(ref, "today_aria")
        step["selector"] = step["selector"].replace(
            "__today_aria_val__", "{{" + var_name + "}}"
        )

    if step.get("action") == "store_text" and store_as:
        step["store_as"] = store_as

    return step


def _is_item_selector(selector: str) -> bool:
    return any(x in (selector or "").lower()
               for x in ["iteminput", "item", "product", "service", "code"])
