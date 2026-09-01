"""
Diagnostic probe for the Stock Correction screen.

Goal: find out what the "Select Store" step ACTUALLY looks like in the DOM on a
fresh navigation (the same way the runner replays), so we stop guessing.

It logs in, navigates to stock-correction-new, waits, and then dumps:
  - whether #storeInput exists / is visible, and when
  - ALL input elements on the page (id, name, placeholder, type, visible)
  - any modal / dialog containers present
  - all buttons (text + id)

Run on the Windows machine (same env as the runner):
  cd C:\\Users\\337799\\Automation\\runner
  python agent\\probe_correction.py
  # optional: add --headful is the DEFAULT here so you can watch it.
  # to run headless like the runner:  python agent\\probe_correction.py --headless

Login defaults to admin/admin; override with --user / --password if needed.
"""
import argparse
import asyncio
from playwright.async_api import async_playwright

LOGIN_URL  = "https://sqa.narayanahealth.org/"
TARGET_URL = "https://sqa.narayanahealth.org/phrweb/stock-correction-new"

SEL_USER   = "#username"
SEL_PASS   = "#password"
SEL_SIGNIN = 'div > div > form:nth-of-type(1) > div:nth-of-type(3) > button'

DUMP_JS = r"""
() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none'
        && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const inputs = Array.from(document.querySelectorAll('input, textarea')).map(el => ({
    id: el.id || '',
    name: el.getAttribute('name') || '',
    fc: el.getAttribute('formcontrolname') || '',
    placeholder: el.getAttribute('placeholder') || '',
    type: el.getAttribute('type') || el.tagName.toLowerCase(),
    visible: vis(el),
    cls: (el.className || '').slice(0, 80),
  }));
  const buttons = Array.from(document.querySelectorAll('button, [role=button]')).map(el => ({
    id: el.id || '',
    text: (el.innerText || el.value || '').trim().slice(0, 40),
    visible: vis(el),
  })).filter(b => b.text || b.id);
  // modal / dialog containers
  const modalSel = '.modal, [role=dialog], .modal-content, .modal-dialog, ngb-modal-window, .cdk-overlay-container, .mat-dialog-container';
  const modals = Array.from(document.querySelectorAll(modalSel)).map(el => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className || '').slice(0, 100),
    visible: vis(el),
    text: (el.innerText || '').trim().slice(0, 120),
  }));
  const storeInput = document.querySelector('#storeInput');
  return {
    url: location.href,
    title: document.title,
    storeInput_exists: !!storeInput,
    storeInput_visible: storeInput ? vis(storeInput) : false,
    input_count: inputs.length,
    inputs: inputs,
    buttons: buttons,
    modals: modals,
  };
}
"""


async def dump(page, label):
    print("\n" + "=" * 70)
    print(f" SNAPSHOT: {label}")
    print("=" * 70)
    data = await page.evaluate(DUMP_JS)
    print(f"URL: {data['url']}")
    print(f"Title: {data['title']}")
    print(f"#storeInput exists={data['storeInput_exists']} visible={data['storeInput_visible']}")
    print(f"\n-- INPUTS ({data['input_count']}) --")
    for i in data["inputs"]:
        print(f"  id={i['id']!r:24} name={i['name']!r:16} fc={i['fc']!r:16} "
              f"ph={i['placeholder']!r:30} type={i['type']:10} vis={i['visible']} cls={i['cls']!r}")
    print(f"\n-- BUTTONS ({len(data['buttons'])}) --")
    for b in data["buttons"]:
        print(f"  id={b['id']!r:24} vis={b['visible']} text={b['text']!r}")
    print(f"\n-- MODALS / DIALOGS ({len(data['modals'])}) --")
    if not data["modals"]:
        print("  (none found)")
    for m in data["modals"]:
        print(f"  <{m['tag']}> vis={m['visible']} cls={m['cls']!r}")
        print(f"        text={m['text']!r}")
    return data


async def main_async(args):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=args.headless)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 720},
                                        ignore_https_errors=True)
        page = await ctx.new_page()

        print(f"[probe] login: {LOGIN_URL}")
        await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_selector(SEL_USER, timeout=15000)
        await page.fill(SEL_USER, args.user)
        await page.fill(SEL_PASS, args.password)
        await page.click(SEL_SIGNIN)
        await page.wait_for_timeout(3000)

        print(f"[probe] navigate: {TARGET_URL}")
        await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30000)

        # The Select Store modal is TRANSIENT — present at ~1.5s but gone by
        # ~10s. So act on it IMMEDIATELY: snapshot once, then type into
        # #storeInput right away while it's still open, and dump the suggestion
        # container that appears.
        await page.wait_for_timeout(1500)
        await dump(page, "t+1.5s after navigate")

        target = None
        for cand in ("#storeInput", "input[placeholder*='Store' i]",
                     "input[placeholder*='store' i]"):
            try:
                loc = page.locator(cand).first
                if await loc.is_visible(timeout=1000):
                    target = cand
                    break
            except Exception:
                continue

        if target:
            print(f"\n[probe] typing '157-IP1' into {target} to reveal suggestions...")
            try:
                loc = page.locator(target).first
                await loc.click(timeout=5000)
                await loc.fill("", timeout=5000)
                await loc.press_sequentially("157-IP1", delay=80)
                await page.wait_for_timeout(1800)
                sugg = await page.evaluate(r"""
                () => {
                  const vis = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    return r.width>1 && r.height>1 && s.display!=='none' && s.visibility!=='hidden';
                  };
                  // capture anything that looks like a dropdown list item now visible
                  const sels = ['ngb-typeahead-window','.dropdown-menu','.dropdown-item',
                    '[role=option]','ng-dropdown-panel','.ng-option','.autocomplete-result',
                    '.typeahead','ul li','.tt-suggestion','.search-result-item'];
                  const out = [];
                  for (const s of sels) {
                    document.querySelectorAll(s).forEach(el => {
                      if (!vis(el)) return;
                      const t = (el.innerText||'').trim().slice(0,60);
                      if (t) out.push({sel:s, tag:el.tagName.toLowerCase(),
                        cls:(el.className||'').slice(0,80), text:t});
                    });
                  }
                  return out.slice(0, 40);
                }
                """)
                print(f"\n-- VISIBLE SUGGESTION-LIKE ELEMENTS AFTER TYPING ({len(sugg)}) --")
                if not sugg:
                    print("  (none — suggestions may not have appeared, or use a different container)")
                for s in sugg:
                    print(f"  sel={s['sel']!r:24} <{s['tag']}> cls={s['cls']!r}")
                    print(f"        text={s['text']!r}")
            except Exception as e:
                print(f"[probe] typing failed: {e}")
        else:
            print("\n[probe] No store input found under #storeInput or placeholder match.")
            print("        The Select Store step may need a click first, or the modal")
            print("        opens from a button. Check the BUTTONS list above.")

        print("\n[probe] Leaving browser open 20s so you can inspect manually...")
        await page.wait_for_timeout(20000)
        await browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--headless", action="store_true",
                    help="run headless like the runner (default: visible)")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
