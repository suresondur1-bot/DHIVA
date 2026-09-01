"""
ATHMA Visual QA Agent — PERCEPTION (stage 1).

Two perceive functions:
  perceive(page)      — FAST, single DOM pass. Used by the agent loop on every step.
  perceive_full(page) — THOROUGH, full 2-D scroll + sub-containers. Used by Study Screen only.

NO AI here. NO runner code changed.
"""
import io
import json

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

from config import SCREENSHOT_MAX_WIDTH, MASK_REGIONS


# ── The in-page DOM walker ──────────────────────────────────────────────────────
_DOM_SCRIPT = r"""
() => {
  const out = [];
  let counter = 0;

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.bottom < -300 || r.top > vh + 300) return false;
    if (r.right  < -300 || r.left > vw + 300) return false;
    return true;
  };

  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const fc = el.getAttribute && el.getAttribute('formcontrolname');
    if (fc) return el.tagName.toLowerCase() + '[formcontrolname="' + fc + '"]';
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) return el.tagName.toLowerCase() + '[name="' + nm + '"]';
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return el.tagName.toLowerCase() + '[aria-label="' + al + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentNode;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  };

  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + el.id + '"]');
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'));
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const lbl = node.querySelector(':scope > label, :scope > .label, :scope > .field-label');
      if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
    }
    // Table column header lookup
    const td = el.closest('td');
    if (td) {
      const tr = td.parentElement;
      const colIndex = Array.from(tr ? tr.children : []).indexOf(td);
      if (colIndex >= 0) {
        const table = td.closest('table');
        if (table) {
          const ths = Array.from(table.querySelectorAll('thead th, thead td'));
          if (ths[colIndex]) {
            const hdrText = ths[colIndex].innerText.trim()
              .replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
            if (hdrText) return hdrText;
          }
        }
      }
    }
    if (aria) return aria.trim();
    return (el.getAttribute && el.getAttribute('name')) || '';
  };

  const isRequired = (el) => {
    if (el.required) return true;
    if (el.getAttribute && el.getAttribute('aria-required') === 'true') return true;
    return /\*/.test(labelFor(el));
  };

  const inferType = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'ng-select' || el.closest('ng-select') || (el.className && /\bng-select\b/.test(el.className)))
      return 'combobox';
    if (tag === 'select') return 'select';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'date' || /date/i.test(el.getAttribute('placeholder') || '')
        || /dd\/mm\/yyyy/i.test(el.getAttribute('placeholder') || '')) return 'dateinput';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['text','email','tel','number','password','search',''].includes(type)) return 'textbox';
    }
    if (tag === 'button' || role === 'button' || type === 'submit') return 'button';
    if (tag === 'a') return 'link';
    if (role === 'combobox') return 'combobox';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'textbox') return 'textbox';
    return null;
  };

  const sel = 'input, textarea, select, button, a, ng-select, ' +
              '[role=button], [role=combobox], [role=checkbox], [role=textbox], ' +
              '[contenteditable=true]';
  const candidates = Array.from(document.querySelectorAll(sel));

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const tagLc = el.tagName.toLowerCase();
    if (tagLc !== 'ng-select' && el.closest('ng-select')) continue;
    const t = inferType(el);
    if (!t) continue;
    const r = el.getBoundingClientRect();
    const entry = {
      ref: 'e' + (++counter),
      type: t,
      name: labelFor(el),
      selector: cssPath(el),
      required: isRequired(el),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    };
    // Capture extra attributes that tell the agent HOW to interact
    if (el.readOnly || el.getAttribute('readonly') !== null) entry.readonly = true;
    if (el.getAttribute('ngbdatepicker') !== null) entry.widget = 'ngbdatepicker';
    if (el.getAttribute('placeholder')) entry.placeholder = el.getAttribute('placeholder');
    if (el.getAttribute('type')) entry.input_type = el.getAttribute('type');
    // Flag if element has a sibling calendar/picker button
    if (entry.widget === 'ngbdatepicker' || entry.readonly) {
      const parent = el.parentElement;
      const siblingBtn = parent && parent.querySelector('button');
      if (siblingBtn) entry.has_picker_button = true;
    }
    if (t === 'checkbox' || t === 'radio') entry.checked = !!el.checked;
    else if (t === 'textbox' || t === 'dateinput' || t === 'select') entry.value = el.value || '';
    else if (t === 'button' || t === 'link') entry.text = (el.innerText || el.value || '').trim().slice(0, 60);
    out.push(entry);
  }

  const tables = [];
  for (const tbl of Array.from(document.querySelectorAll('table'))) {
    if (!isVisible(tbl)) continue;
    const headers = Array.from(tbl.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim());
    const rows = [];
    for (const tr of Array.from(tbl.querySelectorAll('tbody tr')).slice(0, 50)) {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length || headers.length)
      tables.push({ ref: 'tbl' + (++counter), headers, row_count: rows.length, rows });
  }

  const errSel = [
    '.invalid-feedback', '.error', '.error-message', '.text-danger',
    '.validation-error', '.field-error', 'mat-error', '[role=alert]',
    '.alert-danger', '.toast-error', '.ng-invalid + .error', '.help-block.error',
    '.is-invalid ~ .invalid-feedback'
  ].join(', ');
  const errors = [];
  const seenErr = new Set();
  for (const el of Array.from(document.querySelectorAll(errSel))) {
    if (!isVisible(el)) continue;
    const msg = (el.innerText || '').trim();
    if (!msg || seenErr.has(msg) || msg.length > 200) continue;
    seenErr.add(msg);
    errors.push(msg);
  }

  return {
    url: location.href,
    title: document.title,
    elements: out,
    tables: tables,
    errors: errors,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
"""


async def _screenshot(page, full_page=False) -> bytes:
    """Take a screenshot. full_page=True for Study Screen, False for agent loop."""
    raw = await page.screenshot(full_page=full_page, type="png")
    if not HAS_PIL:
        return raw
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if MASK_REGIONS:
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for (x, y, w, h) in MASK_REGIONS:
            draw.rectangle([x, y, x + w, y + h], fill=(40, 40, 40))
    if img.width > SCREENSHOT_MAX_WIDTH:
        ratio = SCREENSHOT_MAX_WIDTH / img.width
        img = img.resize((SCREENSHOT_MAX_WIDTH, int(img.height * ratio)))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def perceive(page):
    """
    FAST perceive — used by the agent loop on every step.
    Single DOM pass at the current scroll position. No scrolling.
    Returns: (digest_dict, screenshot_bytes)
    """
    digest = await page.evaluate(_DOM_SCRIPT)
    shot   = await _screenshot(page, full_page=False)
    return digest, shot


async def perceive_full(page):
    """
    THOROUGH perceive — used by Study Screen ONCE per screen.
    Scrolls the full 2-D extent of the page AND every scrollable sub-container
    so ALL controls are captured regardless of scroll position.
    Returns: (digest_dict, screenshot_bytes)
    """
    dims = await page.evaluate("""
        () => ({
            scrollW: document.body.scrollWidth,
            scrollH: document.body.scrollHeight,
            vw: window.innerWidth,
            vh: window.innerHeight,
        })
    """)
    total_w, total_h = dims["scrollW"], dims["scrollH"]
    vw,      vh      = dims["vw"],      dims["vh"]

    step_y = max(int(vh * 0.8), 200)
    step_x = max(int(vw * 0.8), 200)
    ys = list(range(0, total_h, step_y))
    if ys and total_h - ys[-1] > 50: ys.append(total_h)
    xs = list(range(0, total_w, step_x))
    if xs and total_w - xs[-1] > 50: xs.append(total_w)

    seen_selectors = {}
    last_digest    = {}

    async def _collect():
        nonlocal last_digest
        chunk = await page.evaluate(_DOM_SCRIPT)
        last_digest = chunk
        for el in chunk.get("elements", []):
            if el["selector"] not in seen_selectors:
                seen_selectors[el["selector"]] = el

    # Pass 1 — window scroll grid
    for sy in ys:
        for sx in xs:
            await page.evaluate(f"window.scrollTo({sx}, {sy})")
            await page.wait_for_timeout(250)
            await _collect()

    # Pass 2 — scrollable sub-containers (e.g. wide tables with own scrollbar)
    containers = await page.evaluate("""
        () => {
            const out = [];
            for (const el of document.querySelectorAll('*')) {
                const s = getComputedStyle(el);
                const canX = (s.overflowX==='auto'||s.overflowX==='scroll') && el.scrollWidth>el.clientWidth+5;
                const canY = (s.overflowY==='auto'||s.overflowY==='scroll') && el.scrollHeight>el.clientHeight+5;
                if (!canX && !canY) continue;
                if (el===document.body||el===document.documentElement) continue;
                const r = el.getBoundingClientRect();
                if (r.width<10||r.height<10) continue;
                out.push({
                    selector: el.id ? '#'+el.id
                              : el.className ? '.'+el.className.trim().split(/\\s+/)[0]
                              : el.tagName.toLowerCase(),
                    scrollW: el.scrollWidth, scrollH: el.scrollHeight,
                    clientW: el.clientWidth, clientH: el.clientHeight,
                    canX, canY
                });
            }
            return out;
        }
    """)

    for c in containers:
        sel  = c["selector"]
        c_xs = list(range(0, c["scrollW"], max(int(c["clientW"]*0.8),100))) + [c["scrollW"]] if c["canX"] else [0]
        c_ys = list(range(0, c["scrollH"], max(int(c["clientH"]*0.8),100))) + [c["scrollH"]] if c["canY"] else [0]
        for cy in c_ys:
            for cx in c_xs:
                try:
                    await page.evaluate(
                        f"()=>{{const e=document.querySelector({repr(sel)});if(e)e.scrollTo({cx},{cy})}}"
                    )
                    await page.wait_for_timeout(200)
                    await _collect()
                except Exception:
                    pass
        try:
            await page.evaluate(
                f"()=>{{const e=document.querySelector({repr(sel)});if(e)e.scrollTo(0,0)}}"
            )
        except Exception:
            pass

    await page.evaluate("window.scrollTo(0,0)")
    await page.wait_for_timeout(250)
    top_chunk = await page.evaluate(_DOM_SCRIPT)

    seen_tbls, seen_errs = {}, {}
    for chunk in [top_chunk, last_digest]:
        for t in chunk.get("tables", []):
            key = tuple(t.get("headers") or [])
            if key not in seen_tbls: seen_tbls[key] = t
        for msg in chunk.get("errors", []):
            if msg not in seen_errs: seen_errs[msg] = msg

    elements = list(seen_selectors.values())
    for idx, el in enumerate(elements, 1): el["ref"] = f"e{idx}"
    for idx, t  in enumerate(seen_tbls.values(), len(elements)+1): t["ref"] = f"tbl{idx}"

    digest = {
        "url":           top_chunk.get("url", ""),
        "title":         top_chunk.get("title", ""),
        "elements":      elements,
        "tables":        list(seen_tbls.values()),
        "errors":        list(seen_errs.values()),
        "viewport":      top_chunk.get("viewport", {"w": vw, "h": vh}),
        "_scroll_passes": len(ys) * len(xs) + len(containers),
    }
    shot = await _screenshot(page, full_page=True)
    return digest, shot


def digest_summary(digest: dict) -> str:
    lines = [f"URL: {digest.get('url')}", f"Title: {digest.get('title')}",
             f"{len(digest.get('elements', []))} interactable elements:"]
    for e in digest.get("elements", []):
        req   = " *" if e.get("required") else ""
        dis   = " [disabled]" if e.get("disabled") else ""
        state = f" checked={e['checked']}" if "checked" in e else (f" value='{e['value']}'" if e.get("value") else "")
        lines.append(f"  {e['ref']:>5}  {e['type']:<10} {e.get('name','')[:30]:<32}{req}{dis}{state}  -> {e['selector']}")
    for t in digest.get("tables", []):
        lines.append(f"  {t['ref']}  table  headers={t.get('headers')}  rows={t.get('row_count')}")
    errs = digest.get("errors", [])
    if errs:
        lines.append(f"  {len(errs)} validation error(s) on screen:")
        for m in errs: lines.append(f"     ! {m}")
    return "\n".join(lines)


if __name__ == "__main__":
    import asyncio
    from playwright.async_api import async_playwright

    async def main():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=False)
            page    = await browser.new_page()
            await page.goto("https://sqa.narayanahealth.org/", wait_until="domcontentloaded")
            print("\nLog in and navigate to the target screen, then press Enter.")
            await asyncio.get_event_loop().run_in_executor(None, input, "\nPress Enter... ")
            digest, shot = await perceive_full(page)
            print("\n" + digest_summary(digest))
            with open("perception_sample.png", "wb") as f: f.write(shot)
            with open("perception_sample.json", "w", encoding="utf-8") as f: json.dump(digest, f, indent=2)
            print("\nWrote perception_sample.png and perception_sample.json")
            await page.wait_for_timeout(3000)
            await browser.close()

    asyncio.run(main())
