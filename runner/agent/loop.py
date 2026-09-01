"""
ATHMA Visual QA Agent — LOOP (stage 4/5 orchestrator).

Closes the cycle: perceive -> decide (LLM) -> [human gate] -> act -> verify,
repeating until the goal is reached or a safety cap trips. Every verified step
is recorded by the ScriptWriter, so the end product is a replayable runner
script with ZERO AI at replay time.

Safety built in from the start:
  - Human gate: pauses for your y/N before any submit/Register/destructive click.
  - Caps: max steps, max heals per step, no-progress detector, wall clock.
  - Host guard: refuses to run anywhere not in ALLOWED_HOST_SUBSTRINGS.

No runner code changed. Uses the runner's Playwright the same way perception does.
"""
import asyncio
import os
import time
import random as _random

from config import (MAX_STEPS_PER_RUN, MAX_HEALS_PER_STEP, NO_PROGRESS_LIMIT,
                    WALL_CLOCK_SECONDS, ALLOWED_HOST_SUBSTRINGS,
                    HUMAN_GATE_ACTIONS, HUMAN_GATE_TEXT)
from perception import perceive, digest_summary
from llm_client import decide, clear_playbook_cache
from actions import build_step, ActionError
from executor import execute, verify_value, verify_visible
from script_writer import ScriptWriter


async def _scroll_containers_right(page):
    """
    Scroll every horizontally-scrollable sub-container (e.g. wide item-detail
    tables) fully to the right so their off-screen cells appear in the next
    perceive() call. Called once per loop iteration BEFORE perceive so that
    hidden columns like Start Date / End Date / Budget Ref No are always in
    the digest when the agent needs them.
    Safe to call on any page — skips containers with no horizontal overflow.
    """
    try:
        await page.evaluate("""
            () => {
                for (const el of document.querySelectorAll('*')) {
                    if (el === document.body || el === document.documentElement) continue;
                    const s = getComputedStyle(el);
                    if ((s.overflowX === 'auto' || s.overflowX === 'scroll')
                            && el.scrollWidth > el.clientWidth + 5) {
                        el.scrollLeft = el.scrollWidth;  // scroll fully right
                    }
                }
            }
        """)
    except Exception:
        pass  # page may be navigating — safe to ignore


# One random suffix per run, so the agent can make names/IDs unique and avoid
# duplicate-patient errors. Baked into the saved script (not a placeholder) so
# replaying the script also stays unique only at AUTHOR time — see note below.
_RUN_RANDOM = str(_random.randint(1000, 999999))


def _resolve_random(value):
    """Replace {{random}} / {{rand}} in a step value with this run's number."""
    if not isinstance(value, str):
        return value
    return value.replace("{{random}}", _RUN_RANDOM).replace("{{rand}}", _RUN_RANDOM)


def _host_allowed(url: str) -> bool:
    return any(h in (url or "") for h in ALLOWED_HOST_SUBSTRINGS)


def _needs_human_gate(decision: dict, runner_step: dict, digest: dict) -> bool:
    """True if this action is irreversible/submitting and must be confirmed."""
    if decision.get("action") in HUMAN_GATE_ACTIONS:
        return True
    # find the targeted element's label/text and check for destructive words
    ref = decision.get("target_ref")
    label = ""
    for e in digest.get("elements", []):
        if e.get("ref") == ref:
            label = (e.get("name", "") + " " + e.get("text", "")).lower()
            break
    # buttons whose text submits/commits the form
    submitish = ("register", "save", "submit", "confirm", "pay")
    if decision.get("action") == "click" and any(w in label for w in submitish):
        return True
    if any(w in label for w in HUMAN_GATE_TEXT):
        return True
    return False


def _is_submit_click(decision: dict, runner_step: dict, digest: dict) -> bool:
    """True if this click is the final submit/Register/Save action."""
    if decision.get("action") != "click":
        return False
    ref = decision.get("target_ref")
    label = ""
    for e in digest.get("elements", []):
        if e.get("ref") == ref:
            label = (e.get("name", "") + " " + e.get("text", "")).lower()
            break
    return any(w in label for w in ("register", "save", "submit", "confirm"))


async def _submit_succeeded(page) -> bool:
    """After a submit click, look for a success signal (toast/alert) so the agent
    can STOP instead of wandering on the freshly-reset form. Best-effort."""
    try:
        return await page.evaluate(r"""() => {
            const texts = [];
            const sels = ['.toast', '.toast-message', '.toast-success', '.alert-success',
                          '[class*="toast"]', '[class*="success"]', '.mat-snack-bar-container',
                          '.ngx-toastr', '[role="alert"]'];
            for (const s of sels) {
                for (const el of document.querySelectorAll(s)) {
                    const r = el.getBoundingClientRect();
                    if (r.width < 1 || r.height < 1) continue;
                    texts.push((el.innerText||'').toLowerCase());
                }
            }
            const blob = texts.join(' | ');
            return /success|successfully|saved|registered|created|generated|has been/.test(blob);
        }""")
    except Exception:
        return False


async def _confirm(prompt: str) -> bool:
    ans = await asyncio.get_event_loop().run_in_executor(None, input, prompt)
    return ans.strip().lower() in ("y", "yes")


async def _verify(page, decision: dict, runner_step: dict) -> bool:
    """Cheap rule-based verify. Returns True if the expected change looks satisfied."""
    a = decision.get("action")
    sel = runner_step.get("selector")
    val = runner_step.get("value")
    if a in ("type", "set_date") and sel and val is not None:
        # Exact/contains match is the normal case.
        if await verify_value(page, sel, val):
            return True
        # Autocomplete tolerance: typing into a typeahead (e.g. the store/item
        # search) often REPLACES the typed code with the resolved NAME once a
        # suggestion is picked — so the field no longer literally contains what
        # was typed. That used to read as "type failed", making the agent redo
        # the same field forever (it "keeps selecting the store only"). Treat a
        # now-NON-EMPTY field as success: something was committed. Empty field
        # still (correctly) fails.
        try:
            cur = await page.locator(sel).first.input_value(timeout=2000)
            if (cur or "").strip():
                return True
        except Exception:
            pass
        return False
    if a in ("click", "search_select", "select", "check", "uncheck", "navigate"):
        # for these, "no exception during execute" + screen still alive is enough;
        # the next perceive will reveal the real new state to the model.
        return True
    if a == "assert_visible" and sel:
        return await verify_visible(page, sel)
    return True


async def run_agent(page, goal: str, auto_confirm: bool = True, gate_submit_off: bool = False,
                    login_user: str = "admin", login_password: str = "admin"):
    """
    Drive `page` toward `goal`. `page` should already be logged in and on the
    starting screen. Returns the path to the written script.

    auto_confirm=True (default): the agent accepts its OWN assumed values for
    required fields the goal didn't specify and proceeds without pausing. It
    STILL pauses before a submit/Register/destructive click unless you also pass
    gate_submit=False. Set auto_confirm=False to approve each assumed field.
    """
    url0 = page.url
    if not _host_allowed(url0):
        raise RuntimeError(f"Host not allowed: {url0}. Add it to ALLOWED_HOST_SUBSTRINGS to proceed.")

    # Clear playbook cache so any updated .md files are loaded fresh this run
    clear_playbook_cache()

    writer = ScriptWriter(goal, start_url=url0)
    memory = []
    started = time.time()
    no_progress = 0
    last_signature = None

    for step_no in range(1, MAX_STEPS_PER_RUN + 1):
        if page.is_closed():
            print("[stop] browser/page was closed — ending run and saving what we have.")
            break
        if time.time() - started > WALL_CLOCK_SECONDS:
            print(f"[stop] wall-clock budget ({WALL_CLOCK_SECONDS}s) reached.")
            break

        # Scroll all horizontally-scrollable containers right so hidden columns
        # (e.g. Start Date, End Date, Budget Ref No in wide tables) appear in
        # the digest and the agent can interact with them.
        await _scroll_containers_right(page)

        digest, shot = await perceive(page)

        # no-progress detector: a single long form keeps the SAME url + element
        # Progress = anything about the filled state changed.
        filled_sig = tuple(
            (e.get("ref"), e.get("value", ""), e.get("checked"))
            for e in digest.get("elements", [])
        )
        signature = (digest.get("url"), len(digest.get("elements", [])), filled_sig,
                     tuple(digest.get("errors", [])))
        if signature == last_signature:
            no_progress += 1
        else:
            no_progress = 0
        last_signature = signature
        if no_progress >= NO_PROGRESS_LIMIT:
            print(f"[stop] no screen progress for {NO_PROGRESS_LIMIT} steps.")
            break

        # decide
        try:
            decision = decide(goal, digest, shot, memory)
        except Exception as e:
            print(f"[stop] decide failed: {e}")
            break

        print(f"\n[step {step_no}] {decision.get('action')} ref={decision.get('target_ref')} "
              f"value={decision.get('value')!r}")
        print(f"          thought: {decision.get('thought','')}")

        if decision.get("action") == "finish":
            print(f"[done] {decision.get('reason') or decision.get('thought','goal reached')}")
            break

        # build runner step from decision (resolves ref -> selector)
        try:
            runner_step = build_step(decision, digest)
        except ActionError as e:
            memory.append(f"INVALID action skipped: {e}")
            print(f"  [skip] {e}")
            continue

        # Resolve {{random}} in the value to this run's number, so names are
        # unique (avoids duplicate-patient errors) and the SAVED script carries
        # the actual value.
        if "value" in runner_step:
            runner_step["value"] = _resolve_random(runner_step["value"])

        # human gate for submit/destructive actions (kept ON even in auto mode,
        # because Register/Save actually commits a patient).
        if _needs_human_gate(decision, runner_step, digest) and not gate_submit_off:
            ok = await _confirm(f"  >>> CONFIRM this action? {runner_step}  [y/N] ")
            if not ok:
                print("  [gate] declined by user — stopping before the irreversible action.")
                break

        # per-field gate: the agent chose a value for a required field the goal
        # did not specify. Show it; let the user accept (Enter), override (type a
        # value), or skip (s).
        if decision.get("assumed") and not auto_confirm:
            ref = decision.get("target_ref")
            fname = next((e.get("name", ref) for e in digest.get("elements", []) if e.get("ref") == ref), ref)
            ans = await asyncio.get_event_loop().run_in_executor(
                None, input,
                f"  >>> '{fname}' not in goal. Agent proposes: {runner_step.get('value')!r}. "
                f"[Enter=accept / type a value / s=skip] ")
            ans = (ans or "").strip()
            if ans.lower() == "s":
                memory.append(f"user skipped required field {fname}")
                print("  [field] skipped by user.")
                continue
            if ans:
                runner_step["value"] = ans
                print(f"  [field] overridden to {ans!r}")

        # act, with a small heal loop
        submit_click = _is_submit_click(decision, runner_step, digest)
        submitted_ok = False
        try:
            for attempt in range(MAX_HEALS_PER_STEP + 1):
                try:
                    await execute(page, runner_step)
                    await page.wait_for_timeout(500)
                    if await _verify(page, decision, runner_step):
                        writer.add(runner_step, note=decision.get("expect", ""))
                        memory.append(f"{decision['action']} {runner_step.get('selector','')} "
                                      f"= {runner_step.get('value','')} -> ok")
                        # If this was the final submit, check for a success toast
                        # and STOP — prevents post-submit wandering on the reset form.
                        if submit_click:
                            await page.wait_for_timeout(1200)  # let the toast render
                            if await _submit_succeeded(page):
                                submitted_ok = True
                        break
                    else:
                        print(f"  [verify failed] attempt {attempt+1}; expected: {decision.get('expect')}")
                except Exception as e:
                    if "closed" in str(e).lower():
                        raise
                    print(f"  [act failed] attempt {attempt+1}: {e}")
                if attempt < MAX_HEALS_PER_STEP:
                    await page.wait_for_timeout(800)
            else:
                memory.append(f"{decision['action']} {runner_step.get('selector','')} -> FAILED after heals")
                print("  [give up on this step] continuing to re-perceive.")
        except Exception as e:
            if "closed" in str(e).lower() or page.is_closed():
                print("[stop] browser/page closed mid-step — saving what we have.")
                break
            raise

        # Stop the whole run if the submit succeeded — the goal is done.
        if submitted_ok:
            print("[done] submit succeeded (success message detected) — stopping.")
            break

    path = writer.save(out_dir=os.path.join(os.path.dirname(__file__), "output"),
                       user=login_user, password=login_password)
    print(f"\n[script] wrote {path} ({len(writer.steps)} steps). Replay it through async_runner with NO AI.")
    return path


# ── Standalone run: log in by hand, then the agent drives toward the goal ───────
#   python agent/loop.py "Register a new patient: First Name Test, Sex Male, Age 30 years"
if __name__ == "__main__":
    import sys
    from playwright.async_api import async_playwright

    args = [a for a in sys.argv[1:]]
    # Optional flag: --auto-submit lets the agent click Register WITHOUT the y/N
    # prompt (use only when you trust the run, e.g. dummy data on SQA).
    auto_submit = "--auto-submit" in args
    args = [a for a in args if a != "--auto-submit"]
    GOAL = args[0] if args else \
        "Register a new patient: First Name Test, Last Name Patient, Sex Male, Age 30 years"
    START = "https://sqa.narayanahealth.org/"

    async def main():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=False)
            page = await browser.new_page()
            await page.goto(START, wait_until="domcontentloaded")
            print("\n" + "=" * 70)
            print(" Log in (admin/admin) and navigate to Patient Registration,")
            print(" then press Enter here to let the agent take over.")
            if auto_submit:
                print(" AUTO-SUBMIT is ON — the agent WILL click Register by itself.")
            else:
                print(" It will PAUSE for your y/N before clicking Register/Save.")
            print("=" * 70)
            await asyncio.get_event_loop().run_in_executor(None, input, "\nPress Enter when ready... ")
            await run_agent(page, GOAL, gate_submit_off=auto_submit)
            print("\nDone. Browser closes in 5s.")
            await page.wait_for_timeout(5000)
            await browser.close()

    asyncio.run(main())
