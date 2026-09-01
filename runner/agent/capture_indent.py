"""
Capture the INDENT screens' perception digests. The indent flow has TWO screens:
  Stage 1: select Requesting Store + Issue Store
  Stage 2: the indent screen — select Item + Quantity

So capture TWICE, naming each stage:
  python capture_indent.py stores     -> writes indent_stores.json
  python capture_indent.py items      -> writes indent_items.json

Reuses perception.perceive() — the exact digest the agent sees. Does NOT
overwrite the registration sample.

Flow each time:
  1. A Chrome window opens at the Athma login page.
  2. YOU log in (admin/admin) and navigate to the screen for THIS stage.
  3. Come back to the terminal and press Enter.
  4. It writes indent_<stage>.json (and .png) and prints a summary.
"""
import asyncio
import json
import sys
from playwright.async_api import async_playwright

from perception import perceive, digest_summary

START_URL = "https://sqa.narayanahealth.org/"


async def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else "stage"
    out_json = f"indent_{stage}.json"
    out_png  = f"indent_{stage}.png"

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto(START_URL, wait_until="domcontentloaded")

        print("\n" + "=" * 70)
        print(f" CAPTURING STAGE: {stage}")
        print(" A Chrome window is open.")
        print(" 1. Log in (admin/admin).")
        if stage == "stores":
            print(" 2. Open the indent flow's FIRST screen (Requesting Store /")
            print("    Issue Store selection). Get the store dropdowns visible.")
        elif stage == "items":
            print(" 2. Proceed to the INDENT screen (item + quantity). Get at")
            print("    least one item row / the item selector visible.")
        else:
            print(" 2. Navigate to the screen you want to capture.")
        print(" 3. Come back HERE and press Enter to capture.")
        print("=" * 70)
        await asyncio.get_event_loop().run_in_executor(
            None, input, f"\nPress Enter when the '{stage}' screen is on screen... ")

        digest, shot = await perceive(page)
        print("\n" + digest_summary(digest))
        with open(out_png, "wb") as f:
            f.write(shot)
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(digest, f, indent=2)
        print(f"\nWrote {out_png} and {out_json}")
        print("Browser closes in 3s.")
        await page.wait_for_timeout(3000)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
