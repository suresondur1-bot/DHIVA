"""
ATHMA Smart Author -- Main Entry Point (Multi-Screen)

Orchestrates the three-layer Smart Author flow across MULTIPLE screens:

  Layer 1 -- Knowledge Base  : loads screen controls + playbook per URL
  Layer 2 -- Field Mapper    : ONE Claude call per screen segment
  Layer 3 -- Execution Engine: deterministic execution using widget patterns

The goal can span multiple screens. The system detects URL changes via
navigate hints and loads the correct knowledge base for each screen.

Usage:
  python smart_author.py \\
    --url "https://sqa.narayanahealth.org/spmweb/service-purchase-requisition-new" \\
    --goal "Create SPR ... save as SAIPR. Then find {{SAIPR}} and Send for Approval" \\
    --user admin --password admin
"""
import argparse
import asyncio
import os
import sys

from playwright.async_api import async_playwright

from knowledge_base import load_screen_knowledge
from field_mapper import map_goal_to_fields_multi
from execution_engine import run_smart_author
from script_writer import ScriptWriter

LOGIN_URL  = "https://sqa.narayanahealth.org/"
SEL_USER   = "#username"
SEL_PASS   = "#password"
SEL_SIGNIN = "div > div > form:nth-of-type(1) > div:nth-of-type(3) > button"


async def main(args):
    print(f"[smart-author] Goal: {args.goal}")
    print(f"[smart-author] URL:  {args.url}")

    # ── Layer 1: Load knowledge for starting screen ────────────────────────
    print("\n[smart-author] Layer 1: Loading screen knowledge...")
    knowledge = load_screen_knowledge(args.url)
    if knowledge is None:
        print(f"[smart-author] ERROR: No knowledge base for URL: {args.url}")
        sys.exit(1)
    print(f"[smart-author] Loaded {len(knowledge.controls)} controls | Playbook: {len(knowledge.playbook)} chars")

    # ── Layer 2: Map full goal to field-value list (one AI call) ──────────
    # The field mapper now understands multi-screen goals and emits
    # navigate hints when the flow moves to a different screen.
    print("\n[smart-author] Layer 2: Mapping goal to fields (one AI call)...")
    try:
        field_value_list = map_goal_to_fields_multi(args.goal, knowledge, args.url)
    except Exception as e:
        print(f"[smart-author] ERROR: Field mapping failed: {e}")
        sys.exit(1)

    print(f"[smart-author] Mapped {len(field_value_list)} steps:")
    for item in field_value_list:
        print(f"  {item.get('field'):<35} = {str(item.get('value') or ''):<20} [{item.get('action_hint')}]")

    # ── Layer 3: Execute on live browser ──────────────────────────────────
    print("\n[smart-author] Layer 3: Executing on live browser...")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 720})
        page    = await context.new_page()

        try:
            # Login
            print(f"[smart-author] Logging in as {args.user}...")
            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_selector(SEL_USER, timeout=10000)
            await page.fill(SEL_USER, args.user)
            await page.fill(SEL_PASS, args.password)
            await page.click(SEL_SIGNIN)
            await page.wait_for_timeout(3000)

            # Navigate to starting URL
            print(f"[smart-author] Navigating to {args.url}...")
            await page.goto(args.url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # Execute -- knowledge may be swapped mid-run when navigating
            script_path = await run_smart_author(
                page=page,
                goal=args.goal,
                field_value_list=field_value_list,
                knowledge=knowledge,
                login_user=args.user,
                login_password=args.password,
            )

            print(f"\nSCRIPT_PATH={script_path}", flush=True)

        except Exception as e:
            print(f"[smart-author] ERROR: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url",      required=True)
    parser.add_argument("--goal",     required=True)
    parser.add_argument("--user",     default="admin")
    parser.add_argument("--password", default="admin")
    parser.add_argument("--test-id",  default=None)
    args = parser.parse_args()
    asyncio.run(main(args))
