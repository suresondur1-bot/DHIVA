"""
ATHMA Visual QA Agent — HEADLESS AUTHOR (server-side authoring).

Runs the agent NON-INTERACTIVELY so the backend can spawn it from a UI button:
  - logs itself in (no manual login),
  - navigates to the target page,
  - drives toward the goal with NO human prompts,
  - clicks Register itself (gate_submit_off=True),
  - saves the script to agent/output/ and prints the path.

This is SEPARATE from loop.py's interactive __main__ (which stays as-is for
hands-on authoring with a visible browser and the human gate). Use this only on
SQA with dummy data: it submits without human confirmation.

Usage (the backend calls it like this):
  python agent/headless_author.py \
    --goal "Register a new patient: First Name Test{{random}}, ... Consultant Sunil, ..." \
    --login-url https://sqa.narayanahealth.org/ \
    --target-url https://sqa.narayanahealth.org/ambweb/patient-registration-new \
    --user admin --password admin \
    [--headful]   # show the browser (default headless)
"""
import os
import sys
import asyncio
import argparse
from playwright.async_api import async_playwright

# import the orchestrator + login selectors
from loop import run_agent

LOGIN_SEL_USER   = "#username"
LOGIN_SEL_PASS   = "#password"
LOGIN_SEL_SIGNIN = 'div > div > form:nth-of-type(1) > div:nth-of-type(3) > button'


async def _login_and_navigate(page, login_url, user, password, target_url):
    """Log in and land on the target page — the human steps, done automatically."""
    print(f"[author] navigating to login: {login_url}")
    await page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_selector(LOGIN_SEL_USER, timeout=15000)
    # NOTE: Angular reactive forms often ignore Playwright's fill() because it
    # sets the DOM value without firing the keystroke 'input' events the form
    # model listens for -- the model stays empty and the server falls back to a
    # default user (admin). Clear, then type() so real input events fire, and
    # blur so Angular commits the value before submit.
    for sel, val in ((LOGIN_SEL_USER, user), (LOGIN_SEL_PASS, password)):
        await page.click(sel)
        await page.fill(sel, "")
        await page.type(sel, val, delay=30)
        await page.dispatch_event(sel, "input")
        await page.dispatch_event(sel, "change")
        await page.dispatch_event(sel, "blur")
    await page.click(LOGIN_SEL_SIGNIN)
    await page.wait_for_timeout(3000)
    print(f"[author] navigating to target: {target_url}")
    await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_timeout(3000)


async def main_async(args):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=not args.headful)
        page = await browser.new_page()
        try:
            await _login_and_navigate(page, args.login_url, args.user, args.password, args.target_url)
            # Author with NO human prompts and auto-submit ON.
            path = await run_agent(page, args.goal, auto_confirm=True, gate_submit_off=True,
                                    login_user=args.user, login_password=args.password)
            # Print on its own line with NO prefix so the backend regex
            # /SCRIPT_PATH=(.+\.json)\s*$/m matches it correctly.
            print(f"SCRIPT_PATH={path}", flush=True)
        finally:
            await page.wait_for_timeout(1500)
            await browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", required=True)
    ap.add_argument("--login-url", default="https://sqa.narayanahealth.org/")
    ap.add_argument("--target-url", required=True)
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--headful", action="store_true", help="show the browser (default: headless)")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
