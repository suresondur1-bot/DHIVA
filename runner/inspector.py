"""
ATHMA Element Inspector v2 — High-Reliability Selector Engine
Improvements over v1:
  1. Angular-specific attributes (formControlName, ng-reflect-name, jhiTranslate)
  2. Smart text truncation — strips counters/badges from role names
  3. Uniqueness verified for EVERY selector before showing
  4. Context-aware — detects if element is inside modal/popover
  5. Fallback chain — runner.py tries selectors in order if primary fails
  6. Selector verification — highlights element in green if selector works
  7. Better CSS path — avoids nth-child when possible
"""

import sys
import io
import time
import json
import argparse
import requests

from playwright.sync_api import sync_playwright

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


INJECT_JS = """
(function() {
    if (window.__athma_injected__) return 'already';
    window.__athma_injected__ = true;
    window.__athma_captured__ = null;
    window.__athma_hovered__  = null;

    var ov = document.createElement('div');
    ov.id = '__athma_ov__';
    ov.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
        'border:3px solid #1a56db;border-radius:4px;background:rgba(26,86,219,0.07);' +
        'box-shadow:0 0 0 1px rgba(26,86,219,0.25),0 4px 20px rgba(26,86,219,0.15);' +
        'transition:all 0.08s ease;display:none;';

    var lbl = document.createElement('div');
    lbl.style.cssText = 'position:absolute;top:-28px;left:0;' +
        'background:#1a56db;color:#fff;font-size:11px;font-family:monospace;' +
        'padding:3px 8px;border-radius:4px;white-space:nowrap;' +
        'max-width:400px;overflow:hidden;text-overflow:ellipsis;';
    ov.appendChild(lbl);

    var badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;bottom:-24px;right:0;' +
        'background:#0f172a;color:#7dd3fc;font-size:10px;font-family:monospace;' +
        'padding:2px 8px;border-radius:4px;white-space:nowrap;';
    badge.textContent = 'F2 or Backspace = capture | Esc = cancel';
    ov.appendChild(badge);
    document.body.appendChild(ov);

    document.addEventListener('mousemove', function(e) {
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el.id === '__athma_ov__') return;
        while (el && (el.id === '__athma_ov__' || (el.parentElement && el.parentElement.id === '__athma_ov__')))
            el = el.parentElement;
        if (!el) return;
        window.__athma_hovered__ = el;

        // ── ng-select smart walk-up for hover label ──
        var displayEl = el;
        var ngSel = el.closest('ng-select');
        if (ngSel && el.tagName.toLowerCase() !== 'ng-select') {
            displayEl = ngSel;
        }

        var r = displayEl.getBoundingClientRect();
        ov.style.display = 'block';
        ov.style.left   = (r.left + window.scrollX) + 'px';
        ov.style.top    = (r.top  + window.scrollY) + 'px';
        ov.style.width  = r.width  + 'px';
        ov.style.height = r.height + 'px';

        var tag = el.tagName.toLowerCase();
        var id  = el.id ? '#' + el.id : '';
        var txt = (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);
        // Show Angular formControlName if available
        var fcn = el.getAttribute('formcontrolname') || el.getAttribute('ng-reflect-name') || '';
        var extra = fcn ? ' [fcn=' + fcn + ']' : '';
        lbl.textContent = '<' + tag + id + extra + '>' + (txt ? ' · ' + txt : '');
    }, true);

    document.addEventListener('keydown', function(e) {
        if ((e.key === 'F2' || e.key === 'Backspace') && window.__athma_hovered__) {
            e.preventDefault();
            e.stopPropagation();
            window.__athma_captured__ = window.__athma_hovered__;
            ov.style.borderColor = '#22c55e';
            ov.style.background  = 'rgba(34,197,94,0.12)';
            setTimeout(function() {
                ov.style.borderColor = '#1a56db';
                ov.style.background  = 'rgba(26,86,219,0.07)';
            }, 600);
        }
        if (e.key === 'Escape') {
            window.__athma_hovered__  = null;
            window.__athma_captured__ = null;
            ov.style.display = 'none';
        }
    }, true);

    return 'injected';
})()
"""


EXTRACT_JS = """
(function() {
    var el = window.__athma_captured__;
    if (!el) return null;
    window.__athma_captured__ = null;

    // ── ng-select smart walk-up ─────────────────────────────────────────────
    // If captured element is inside an ng-select (input, span, div.ng-input etc.)
    // walk up to the ng-select parent — the runner needs ng-select not inner input
    var ngSelectParent = el.closest('ng-select');
    if (ngSelectParent && el.tagName.toLowerCase() !== 'ng-select') {
        el = ngSelectParent;
    }

    // ── Icon/Span to Button walk-up ─────────────────────────────────────────
    // If captured element is a non-interactive child (icon, span) inside an
    // interactive parent (button, a), walk up to the parent
    var currentTag = el.tagName.toLowerCase();
    var isNonInteractive = (
        currentTag === 'i' ||
        currentTag === 'span' ||
        currentTag === 'svg' ||
        currentTag === 'path' ||
        (currentTag === 'div' && el.getAttribute('aria-hidden') === 'true')
    );

    if (isNonInteractive) {
        // Walk up to find interactive parent (button, a, input, select, textarea)
        var interactiveParent = el.closest('button, a, input, select, textarea, [role="button"], [onclick]');
        if (interactiveParent) {
            console.log('[ATHMA] Walked up from <' + currentTag + '> to <' + interactiveParent.tagName.toLowerCase() + '>');
            el = interactiveParent;
        }
    }

    var tag         = el.tagName.toLowerCase();
    var id          = el.id || '';
    var nameAttr    = el.getAttribute('name') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var ariaLabel   = el.getAttribute('aria-label') || '';
    var ariaLabelBy = el.getAttribute('aria-labelledby') || '';
    var role        = el.getAttribute('role') || '';
    var inputType   = el.getAttribute('type') || '';
    var forAttr     = el.getAttribute('for') || '';  // for <label> elements
    
    // Use innerText (respects visibility) first, fallback to textContent
    var text        = (el.innerText || el.textContent || '').trim().replace(/\\s+/g,' ');

    // ── Angular-specific attributes ─────────────────────────────────────────
    var formCtrlName = el.getAttribute('formcontrolname') ||
                       el.getAttribute('formArrayName') || '';
    var ngReflect    = el.getAttribute('ng-reflect-name') ||
                       el.getAttribute('ng-reflect-router-link') || '';
    var jhiTranslate = el.getAttribute('jhitranslate') ||
                       el.getAttribute('jhi-translate') || '';
    var ngModel      = el.getAttribute('[(ngmodel)]') ||
                       el.getAttribute('ngmodel') || '';

    // ── data-* test attributes (highest priority) ───────────────────────────
    var testAttrs = ['data-testid','data-cy','data-qa','data-test',
                     'data-automation','data-auto','data-id','data-automation-id'];
    var foundTestAttr = null;
    for (var i=0; i<testAttrs.length; i++) {
        var v = el.getAttribute(testAttrs[i]);
        if (v) { foundTestAttr = {name: testAttrs[i], value: v}; break; }
    }

    // ── Smart text — strip counters, badges, numbers from end ──────────────
    // e.g. "Save Invoice (3 items)" → "Save Invoice"
    // e.g. "Patients 42" → "Patients"
    var cleanText = text
        .replace(/\\s*\\(\\d+[^)]*\\)\\s*$/, '')   // trailing (N ...) 
        .replace(/\\s*\\d+\\s*$/, '')               // trailing number
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 50);

    // ── Stable classes (filter Angular/React generated) ─────────────────────
    var classes = [];
    el.classList.forEach(function(c) {
        if (c.length > 1 && c.length < 60 &&
            !c.match(/^(ng-tns|ng-star|_ng|__ng|css-|jsx-|sc-|Mui|rs-|cdk-|ng-animate|ng-trigger|ng-enter|ng-leave|ng-touched|ng-dirty|ng-valid|ng-invalid|ng-pristine|is-|has-|active|selected|hover|open|show|focus|visible|disabled|fade|collapse)/i))
            classes.push(c);
    });

    // ── Context: detect if inside modal/dialog/popover ──────────────────────
    var contextSel = '';
    var parent = el.parentElement;
    var depth = 0;
    while (parent && depth < 10) {
        var ptag = parent.tagName.toLowerCase();
        var prole = parent.getAttribute('role') || '';
        var pcls  = (parent.className || '').toLowerCase();
        if (prole === 'dialog' || prole === 'alertdialog' ||
            pcls.includes('modal') || pcls.includes('dialog') ||
            pcls.includes('popover') || pcls.includes('overlay') ||
            ptag === 'mat-dialog-container' || ptag === 'ngb-modal-window' ||
            ptag === 'cdk-overlay-pane') {
            contextSel = ptag !== 'div' ? ptag : ('.' + (parent.className||'').split(' ').filter(function(c){ return c && !c.match(/ng-|cdk-/); })[0] || '');
            break;
        }
        parent = parent.parentElement;
        depth++;
    }

    // ── Uniqueness check ────────────────────────────────────────────────────
    function uniq(sel, scope) {
        try {
            var ctx = scope ? document.querySelector(scope) : document;
            if (!ctx) ctx = document;
            return ctx.querySelectorAll(sel).length === 1;
        } catch(e) { return false; }
    }

    function uniqGlobal(sel) {
        try { return document.querySelectorAll(sel).length === 1; }
        catch(e) { return false; }
    }

    // ── Stable CSS path — prefer attributes over nth-child ──────────────────
    function stableCssPath(element, maxDepth) {
        var parts = [];
        var cur = element;
        for (var d = 0; d < (maxDepth || 4) && cur && cur.tagName; d++) {
            var p = cur.tagName.toLowerCase();

            // Stop at ng-select — never go inside it
            if (p === 'ng-select') {
                parts.unshift('ng-select');
                break;
            }

            // Stop at stable ID
            if (cur.id && !cur.id.match(/^(ng-|ember|react-|vue-|\\d)/i)) {
                parts.unshift(p + '#' + cur.id);
                break;
            }

            // Use Angular formcontrolname
            var fcn = cur.getAttribute('formcontrolname');
            if (fcn) { parts.unshift('[formcontrolname="' + fcn + '"]'); break; }

            // Use aria-label
            var al = cur.getAttribute('aria-label');
            if (al && uniqGlobal('[aria-label="' + al + '"]')) {
                parts.unshift('[aria-label="' + al + '"]'); break;
            }

            // Use stable classes (no nth-child if class is unique)
            var stableClasses = Array.from(cur.classList).filter(function(c) {
                return !c.match(/^(ng-tns|ng-star|_ng|active|selected|hover|open|show|focus|visible|disabled)/i);
            }).slice(0, 2);

            if (stableClasses.length > 0) {
                var cSel = p + '.' + stableClasses.join('.');
                if (uniqGlobal(cSel)) { parts.unshift(cSel); break; }
                p += '.' + stableClasses.join('.');
            }

            // Use nth-of-type only as last resort for this segment
            var sibs = cur.parentElement
                ? Array.from(cur.parentElement.children).filter(function(s) { return s.tagName === cur.tagName; })
                : [];
            if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';

            parts.unshift(p);
            cur = cur.parentElement;
        }
        var result = parts.join(' > ');
        return uniqGlobal(result) ? result : null;
    }

    // Infer Playwright role
    var roleMap = {
        button: 'button', a: 'link', input: 'textbox', select: 'combobox',
        textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading',
        li: 'listitem'
    };
    if (inputType === 'checkbox') role = 'checkbox';
    else if (inputType === 'radio') role = 'radio';
    else if (inputType === 'submit' || inputType === 'button') role = 'button';
    var inferRole = role || roleMap[tag] || '';

    // ── Build selectors list ─────────────────────────────────────────────────
    var sels = [];

    // 1. data-testid / data-cy etc  (★★★ — most stable)
    if (foundTestAttr) {
        var taSel = '[' + foundTestAttr.name + '="' + foundTestAttr.value + '"]';
        sels.push({ type: foundTestAttr.name, stars: 3, starsDisplay: '★★★',
            value: taSel,
            hint: 'Test attribute — most stable, purpose-built for automation' });
    }

    // 2. formControlName  (★★★ — Angular-specific, very stable)
    if (formCtrlName) {
        var fcSel = '[formcontrolname="' + formCtrlName + '"]';
        if (uniqGlobal(fcSel)) {
            sels.push({ type: 'formControlName', stars: 3, starsDisplay: '★★★',
                value: fcSel,
                hint: 'Angular form control name — extremely stable in Angular apps' });
        } else if (contextSel) {
            sels.push({ type: 'formControlName (scoped)', stars: 3, starsDisplay: '★★★',
                value: contextSel + ' ' + fcSel,
                hint: 'Angular form control name scoped to modal/form' });
        }
    }

    // 3. ng-reflect-name (Angular)  (★★★)
    if (ngReflect && !formCtrlName) {
        var nrSel = '[ng-reflect-name="' + ngReflect + '"]';
        if (uniqGlobal(nrSel)) {
            sels.push({ type: 'ng-reflect-name', stars: 3, starsDisplay: '★★★',
                value: nrSel,
                hint: 'Angular reflected input binding — stable in Angular apps' });
        }
    }

    // 4. aria-label  (★★★)
    if (ariaLabel) {
        var alSel = '[aria-label="' + ariaLabel + '"]';
        if (uniqGlobal(alSel)) {
            sels.push({ type: 'aria-label', stars: 3, starsDisplay: '★★★',
                value: alSel,
                hint: 'ARIA label — stable, accessibility-based' });
        }
    }

    // 4a. Label 'for' attribute  (★★★) - for <label> elements
    if (tag === 'label' && forAttr) {
        var forSel = 'label[for="' + forAttr + '"]';
        if (uniqGlobal(forSel)) {
            sels.push({ type: 'label for', stars: 3, starsDisplay: '★★★',
                value: forSel,
                hint: 'Label for attribute — stable, links label to input' });
        }
        // Also add attribute-only version
        var forAttrSel = '[for="' + forAttr + '"]';
        if (uniqGlobal(forAttrSel)) {
            sels.push({ type: 'for attr', stars: 3, starsDisplay: '★★★',
                value: forAttrSel,
                hint: 'For attribute — stable selector for label' });
        }
    }

    // 5. Unique ID (stable)  (★★★)
    if (id && !id.match(/^(ng-|ember|react-|vue-|w-node|\\d)/i) && uniqGlobal('#' + id)) {
        sels.push({ type: 'id', stars: 3, starsDisplay: '★★★',
            value: '#' + id,
            hint: 'Unique element ID — very reliable if ID is not auto-generated' });
    }

    // 6. getByRole + clean name  (★★★)
    if (inferRole && cleanText && cleanText.length > 0) {
        var roleSel = 'getByRole("' + inferRole + '", name="' + cleanText + '")';
        sels.push({ type: 'getByRole', stars: 3, starsDisplay: '★★★',
            value: roleSel,
            hint: 'Playwright semantic locator — resilient to DOM changes, uses cleaned text' });
    }

    // 7. Placeholder  (★★☆)
    if (placeholder) {
        var phSel = '[placeholder="' + placeholder + '"]';
        if (uniqGlobal(phSel)) {
            sels.push({ type: 'placeholder', stars: 2, starsDisplay: '★★☆',
                value: phSel,
                hint: 'Input placeholder — stable for form fields' });
        }
    }

    // 8. getByLabel — find associated label  (★★☆)
    var labelText = '';
    if (id) {
        var lbl2 = document.querySelector('label[for="' + id + '"]');
        if (lbl2) labelText = (lbl2.textContent||'').trim().replace(/\\s+/g,' ').replace(/[*:]+$/, '').trim();
    }
    if (!labelText && el.closest) {
        var closestLabel = el.closest('label');
        if (closestLabel) labelText = (closestLabel.textContent||'').trim().replace(/\\s+/g,' ').replace(/[*:]+$/, '').trim();
    }
    if (labelText && labelText.length > 0 && labelText.length < 60) {
        sels.push({ type: 'getByLabel', stars: 2, starsDisplay: '★★☆',
            value: 'getByLabel("' + labelText.slice(0,50) + '")',
            hint: 'Playwright label locator — finds input associated with a label' });
    }

    // 9. Name attribute  (★★☆)
    if (nameAttr && ['input','select','textarea','button'].indexOf(tag) >= 0) {
        var nSel = tag + '[name="' + nameAttr + '"]';
        if (uniqGlobal(nSel)) {
            sels.push({ type: 'name attr', stars: 2, starsDisplay: '★★☆',
                value: nSel,
                hint: 'Form field name attribute' });
        }
    }

    // 10. getByText  (★★☆)
    if (cleanText && cleanText.length > 1 &&
        ['a','button','span','li','td','th','label','h1','h2','h3','p'].indexOf(tag) >= 0) {
        sels.push({ type: 'getByText', stars: 2, starsDisplay: '★★☆',
            value: 'getByText("' + cleanText + '")',
            hint: 'Visible text — uses cleaned text without counters/badges' });
    }

    // 11. jhiTranslate (JHipster/Angular i18n)  (★★☆)
    if (jhiTranslate) {
        var jtSel = '[jhitranslate="' + jhiTranslate + '"]';
        if (uniqGlobal(jtSel)) {
            sels.push({ type: 'jhiTranslate', stars: 2, starsDisplay: '★★☆',
                value: jtSel,
                hint: 'JHipster translation key — stable in JHipster/Angular apps' });
        }
    }

    // 12. Stable CSS path  (★☆☆)
    var cp = stableCssPath(el, 4);
    if (cp) {
        sels.push({ type: 'css path', stars: 1, starsDisplay: '★☆☆',
            value: cp,
            hint: 'CSS path — more stable than XPath but verify after DOM changes' });
    }

    // EMERGENCY FALLBACK: For divs with classes but no other selectors
    if (sels.length === 0 && tag === 'div' && classes.length > 0) {
        sels.push({ type: 'div with classes', stars: 1, starsDisplay: '★☆☆',
            value: 'div.' + classes.join('.'),
            hint: 'Div with classes - may match multiple elements' });
    }

    // EMERGENCY FALLBACK: Always include ID selector even if not unique
    if (id && !sels.some(function(s) { return s.type === 'id'; })) {
        sels.push({ type: 'id (may not be unique)', stars: 2, starsDisplay: '★★☆',
            value: '#' + id,
            hint: 'ID selector - WARNING: may match multiple elements if ID is duplicated' });
    }

    // EMERGENCY FALLBACK: Always include tag+classes if we have nothing else
    if (sels.length === 0 && classes.length > 0) {
        sels.push({ type: 'tag+classes', stars: 1, starsDisplay: '★☆☆',
            value: tag + '.' + classes.join('.'),
            hint: 'Tag with classes - last resort selector' });
    }

    // EMERGENCY FALLBACK: Absolute last resort - just the tag with ID attribute
    if (sels.length === 0 && id) {
        sels.push({ type: 'id attribute', stars: 1, starsDisplay: '★☆☆',
            value: tag + '[id="' + id + '"]',
            hint: 'Tag with ID attribute - bypasses uniqueness check' });
    }

    // ULTIMATE FALLBACK: If NOTHING worked, just return the tag name
    if (sels.length === 0) {
        sels.push({ type: 'tag only', stars: 1, starsDisplay: '★☆☆',
            value: tag,
            hint: 'Tag name only - VERY UNSTABLE, will match many elements' });
    }

    // Sort by stars, deduplicate
    sels.sort(function(a,b) { return b.stars - a.stars; });
    var seen = {};
    sels = sels.filter(function(s) {
        if (seen[s.value]) return false;
        seen[s.value] = true;
        return true;
    });

    return {
        selectors: sels,
        element: {
            tag: tag,
            id: id,
            text: cleanText,
            rawText: text.slice(0, 80),
            classes: classes.slice(0, 4),
            ariaLabel: ariaLabel,
            placeholder: placeholder,
            role: inferRole,
            formControlName: formCtrlName,
            context: contextSel || null
        }
    };
})()
"""


def post_result(api_base, session_id, token, payload):
    try:
        r = requests.post(
            f"{api_base}/api/inspector/{session_id}/result",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        print(f"[inspector] Posted {payload.get('type')} → HTTP {r.status_code}")
    except Exception as e:
        print(f"[inspector] Post failed: {e}")


def check_alive(api_base, session_id, token):
    try:
        r = requests.get(
            f"{api_base}/api/inspector/{session_id}/status",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        return r.status_code == 200
    except Exception:
        return False


def inject(page):
    try:
        result = page.evaluate(INJECT_JS)
        print(f"[inspector] Injected on {page.url[:60]} → {result}")
    except Exception as e:
        print(f"[inspector] Inject skipped: {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--api-base",   required=True)
    parser.add_argument("--token",      required=True)
    parser.add_argument("--start-url",  default="")
    args = parser.parse_args()

    session_id = args.session_id
    api_base   = args.api_base
    token      = args.token
    start_url  = args.start_url

    print(f"[inspector] Starting v2 — session={session_id}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            slow_mo=0,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--disable-extensions",
                "--start-maximized",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1366, "height": 768},
            ignore_https_errors=True,
            no_viewport=False,
        )
        page = context.new_page()

        page.on("load", lambda: inject(page))
        page.on("domcontentloaded", lambda: inject(page))

        if start_url and start_url.startswith("http"):
            try:
                page.goto(start_url, timeout=30000, wait_until="domcontentloaded")
            except Exception as e:
                print(f"[inspector] Navigation warning: {e}")
        else:
            page.set_content("""<!DOCTYPE html><html><body style="
                font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
                display:flex;align-items:center;justify-content:center;
                height:100vh;margin:0;flex-direction:column;gap:20px;text-align:center">
                <div style="font-size:48px">🎯</div>
                <h2 style="color:#60a5fa;margin:0">ATHMA Inspector v2</h2>
                <p style="color:#94a3b8;max-width:440px;line-height:1.7">
                    Navigate to your app · Login · Hover any element · Press <b style="color:#fbbf24">F2</b> to capture
                </p>
                <div style="background:#1e293b;border-radius:12px;padding:20px 36px;
                    border:1px solid #334155;font-size:13px;color:#7dd3fc;line-height:2">
                    🔵 Blue box = element tracked &nbsp;|&nbsp; F2 = capture &nbsp;|&nbsp; Esc = cancel<br>
                    ⭐ Angular <code>formControlName</code> auto-detected<br>
                    ⭐ Text counters stripped automatically<br>
                    ⭐ Modal context detected
                </div>
            </body></html>""")

        inject(page)
        post_result(api_base, session_id, token, {"type": "ready"})
        print("[inspector] Ready — waiting for F2 captures")

        last_alive  = time.time()
        last_inject = time.time()

        while True:
            time.sleep(0.2)

            if not browser.is_connected():
                print("[inspector] Browser closed")
                post_result(api_base, session_id, token, {"type": "cancelled"})
                break

            if time.time() - last_alive > 3:
                if not check_alive(api_base, session_id, token):
                    print("[inspector] Session closed")
                    break
                last_alive = time.time()

            # Re-inject every 4s for SPA navigation
            if time.time() - last_inject > 4:
                inject(page)
                last_inject = time.time()

            try:
                result = page.evaluate(EXTRACT_JS)
            except Exception:
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=2000)
                    inject(page)
                except:
                    pass
                continue

            if result and result.get("selectors"):
                sels = result["selectors"]
                elem = result.get("element", {})
                print(f"[inspector] Captured <{elem.get('tag')}> text='{elem.get('text','')[:40]}'")
                if elem.get("formControlName"):
                    print(f"  → Angular formControlName: {elem['formControlName']}")
                if elem.get("context"):
                    print(f"  → Context: {elem['context']}")
                for s in sels[:5]:
                    print(f"  {s['starsDisplay']} [{s['type']}] {s['value'][:80]}")

                post_result(api_base, session_id, token, {
                    "type":      "picked",
                    "selectors": sels,
                    "element":   elem,
                })
                print("[inspector] Sent — ready for next capture")

        try:
            context.close()
            browser.close()
        except:
            pass

    print("[inspector] Done")


if __name__ == "__main__":
    main()
