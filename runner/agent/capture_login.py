"""
One-off: capture the LOGIN page selectors (do NOT log in).
Opens the Athma login page, waits for you to press Enter WITHOUT logging in,
then writes login_perception.json so we can read the username/password/button
selectors and build a self-contained login prelude for replay scripts.
"""
import asyncio, json
from playwright.async_api import async_playwright
from perception import perceive, digest_summary

LOGIN_URL = "https://sqa.narayanahealth.org/"

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto(LOGIN_URL, wait_until="domcontentloaded")
        print("\n" + "=" * 70)
        print(" DO NOT LOG IN. The login page should be on screen.")
        print(" Just press Enter here to capture the LOGIN page elements.")
        print("=" * 70)
        await asyncio.get_event_loop().run_in_executor(None, input, "\nPress Enter (without logging in)... ")
        digest, shot = await perceive(page)
        print("\n" + digest_summary(digest))
        with open("login_perception.json", "w", encoding="utf-8") as f:
            json.dump(digest, f, indent=2)
        print("\nWrote login_perception.json")
        await page.wait_for_timeout(2000)
        await browser.close()

asyncio.run(main())
