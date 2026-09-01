"""
Capture the SLOT popup's real HTML so we can pin pick_first exactly.

Flow:
  1. Opens a browser to the login page.
  2. YOU log in, select Consultant 'Sunil', and CLICK THE SLOT FIELD so the
     slot popup is OPEN on screen.
  3. Come back to the terminal and press Enter.
  4. It dumps the open popup/modal HTML to slot_popup.html and prints a summary.
"""
import asyncio
from playwright.async_api import async_playwright

START = "https://sqa.narayanahealth.org/"

JS_DUMP = r"""
() => {
  // Find the most likely popup/modal container currently visible.
  const sels = ['ngb-modal-window', '.modal-body', '.cdk-overlay-container',
                '[class*="slot"]', '.modal', '[role=dialog]'];
  const seen = new Set();
  const out = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const html = el.outerHTML.slice(0, 4000);
      if (seen.has(html)) continue;
      seen.add(html);
      out.push({ sel, tag: el.tagName.toLowerCase(),
                 cls: el.className, html });
    }
  }
  return out;
}
"""

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto(START, wait_until="domcontentloaded")
        print("\n" + "=" * 70)
        print(" 1. Log in (admin/admin).")
        print(" 2. Go to Patient Registration, select Consultant 'Sunil'.")
        print(" 3. CLICK THE SLOT FIELD so the slot popup is OPEN on screen.")
        print(" 4. Then come here and press Enter (leave the popup open).")
        print("=" * 70)
        await asyncio.get_event_loop().run_in_executor(None, input, "\nPress Enter with the slot popup OPEN... ")
        data = await page.evaluate(JS_DUMP)
        with open("slot_popup.html", "w", encoding="utf-8") as f:
            for d in data:
                f.write(f"\n<!-- matched by: {d['sel']} | tag={d['tag']} | class={d['cls']} -->\n")
                f.write(d["html"] + "\n")
        print(f"\nCaptured {len(data)} popup container(s). Wrote slot_popup.html")
        for d in data:
            print(f"  - {d['sel']:24} tag={d['tag']:18} class={str(d['cls'])[:60]}")
        await page.wait_for_timeout(1500)
        await browser.close()

asyncio.run(main())
