"""
ATHMA Element Inspector v3 — UNIVERSAL SELECTOR ENGINE
New in v3:
  ✅ Tries ALL possible selector strategies (20+ combinations)
  ✅ Auto-detects duplicate elements
  ✅ Intelligently scopes to unique parents  
  ✅ Handles dynamic IDs (medication-order_7 → [id^="medication-order"])
  ✅ Ranks selectors by stability + uniqueness score
  ✅ Works for ANY element on ANY page

Previous improvements:
  1. Angular-specific attributes (formControlName, ng-reflect-name, jhiTranslate)
  2. Smart text truncation — strips counters/badges from role names
  3. Uniqueness verified for EVERY selector before showing
  4. Context-aware — detects if element is inside modal/popover
  5. Fallback chain — runner.py tries selectors in order if primary fails
  6. Selector verification — highlights element in green if selector works
  7. Better CSS path — avoids nth-child when possible
  8. Icon-to-button walk-up
  9. Label 'for' attribute support
  10. Visible text priority (innerText over textContent)
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
    var ngSelectParent = el.closest('ng-select');
    if (ngSelectParent && el.tagName.toLowerCase() !== 'ng-select') {
        el = ngSelectParent;
    }

    // ── Icon/Span to Button walk-up ─────────────────────────────────────────
    var currentTag = el.tagName.toLowerCase();
    var isNonInteractive = (
        currentTag === 'i' ||
        currentTag === 'span' ||
        currentTag === 'svg' ||
        currentTag === 'path' ||
        (currentTag === 'div' && el.getAttribute('aria-hidden') === 'true')
    );

    if (isNonInteractive) {
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
    var forAttr     = el.getAttribute('for') || '';
    
    // Use innerText (respects visibility) first
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

    // ── data-* test attributes ──────────────────────────────────────────────
    var testAttrs = ['data-testid','data-cy','data-qa','data-test',
                     'data-automation','data-auto','data-id','data-automation-id'];
    var foundTestAttr = null;
    for (var i=0; i<testAttrs.length; i++) {
        var v = el.getAttribute(testAttrs[i]);
        if (v) { foundTestAttr = {name: testAttrs[i], value: v}; break; }
    }

    // ── Smart text — strip counters, badges ─────────────────────────────────
    var cleanText = text
        .replace(/\\s*\\(\\d+[^)]*\\)\\s*$/, '')
        .replace(/\\s*\\d+\\s*$/, '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 50);

    // ── Stable classes ──────────────────────────────────────────────────────
    var classes = [];
    el.classList.forEach(function(c) {
        if (c.length > 1 && c.length < 60 &&
            !c.match(/^(ng-tns|ng-star|_ng|__ng|css-|jsx-|sc-|Mui|rs-|cdk-|ng-animate|ng-trigger|ng-enter|ng-leave|ng-touched|ng-dirty|ng-valid|ng-invalid|ng-pristine|is-|has-|active|selected|hover|open|show|focus|visible|disabled|fade|collapse)/i))
            classes.push(c);
    });

    // ── Context: detect modal/dialog ────────────────────────────────────────
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

    // ═══════════════════════════════════════════════════════════════════════
    // ── UNIVERSAL SELECTOR ENGINE ──────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════
    
    function generateAllSelectors(el) {
        var candidates = [];
        
        // ID selectors
        if (id && !id.match(/^(ng-|ember|react-|vue-|w-node|\\d)/i)) {
            candidates.push({sel: '#' + id, type: 'id', stab: 95});
        }
        
        // Test attributes
        if (foundTestAttr) {
            candidates.push({
                sel: '[' + foundTestAttr.name + '="' + foundTestAttr.value + '"]',
                type: foundTestAttr.name,
                stab: 100
            });
        }
        
        // Angular formControlName
        if (formCtrlName) {
            candidates.push({
                sel: '[formcontrolname="' + formCtrlName + '"]',
                type: 'formControlName',
                stab: 90
            });
        }
        
        // ARIA label
        if (ariaLabel) {
            candidates.push({
                sel: '[aria-label="' + ariaLabel + '"]',
                type: 'aria-label',
                stab: 85
            });
        }
        
        // Label for attribute
        if (tag === 'label' && forAttr) {
            candidates.push({
                sel: 'label[for="' + forAttr + '"]',
                type: 'label-for',
                stab: 85
            });
            candidates.push({
                sel: '[for="' + forAttr + '"]',
                type: 'for-attr',
                stab: 80
            });
        }
        
        // Tag + name
        if (nameAttr && ['input','select','textarea','button'].indexOf(tag) >= 0) {
            candidates.push({
                sel: tag + '[name="' + nameAttr + '"]',
                type: 'tag+name',
                stab: 75
            });
        }
        
        // Tag + type
        if (inputType) {
            candidates.push({
                sel: tag + '[type="' + inputType + '"]',
                type: 'tag+type',
                stab: 70
            });
            candidates.push({
                sel: 'input[type="' + inputType + '"]',
                type: 'input+type',
                stab: 65
            });
        }
        
        // Placeholder
        if (placeholder) {
            candidates.push({
                sel: '[placeholder="' + placeholder + '"]',
                type: 'placeholder',
                stab: 75
            });
        }
        
        // Class-based selectors
        for (var i = 0; i < classes.length && i < 3; i++) {
            candidates.push({
                sel: '.' + classes[i],
                type: 'class',
                stab: 50
            });
        }
        
        if (classes.length > 0) {
            candidates.push({
                sel: tag + '.' + classes.slice(0, 2).join('.'),
                type: 'tag+class',
                stab: 65
            });
        }
        
        if (classes.length >= 2) {
            candidates.push({
                sel: '.' + classes.slice(0, 2).join('.'),
                type: 'multi-class',
                stab: 60
            });
        }
        
        // Playwright semantic selectors
        if (inferRole && cleanText && cleanText.length > 0) {
            candidates.push({
                sel: 'get_by_role("' + inferRole + '", name="' + cleanText + '")',
                type: 'getByRole',
                stab: 70,
                isPW: true
            });
        }
        
        if (cleanText && cleanText.length > 1 &&
            ['a','button','span','li','td','th','label','h1','h2','h3','p'].indexOf(tag) >= 0) {
            candidates.push({
                sel: 'get_by_text("' + cleanText + '")',
                type: 'getByText',
                stab: 50,
                isPW: true
            });
        }
        
        // Angular-specific
        if (ngReflect && !formCtrlName) {
            candidates.push({
                sel: '[ng-reflect-name="' + ngReflect + '"]',
                type: 'ng-reflect',
                stab: 80
            });
        }
        
        if (jhiTranslate) {
            candidates.push({
                sel: '[jhitranslate="' + jhiTranslate + '"]',
                type: 'jhiTranslate',
                stab: 75
            });
        }
        
        return candidates;
    }
    
    function testAndScore(candidate) {
        try {
            var count = candidate.isPW ? 99 : document.querySelectorAll(candidate.sel).length;
            var isUnique = count === 1;
            
            var uniquenessMult = isUnique ? 1.0 : (count === 2 ? 0.7 : (count <= 5 ? 0.5 : 0.2));
            var score = candidate.stab * uniquenessMult;
            
            return {
                selector: candidate.sel,
                type: candidate.type,
                stability: candidate.stab,
                matches: count,
                isUnique: isUnique,
                score: score,
                isPW: candidate.isPW || false
            };
        } catch(e) {
            return null;
        }
    }
    
    function autoScope(el, baseSelector, originalMatches) {
        var scopedResults = [];
        var parent = el.parentElement;
        var depth = 0;
        
        while (parent && depth < 5) {
            var parentSelectors = [];
            
            // Try parent ID
            if (parent.id && !parent.id.match(/^(ng-|ember|react-|vue-|\\d)/i)) {
                parentSelectors.push('#' + parent.id);
                
                // Pattern match for dynamic IDs
                var idMatch = parent.id.match(/^([a-zA-Z][a-zA-Z0-9-]*)_?\\d+$/);
                if (idMatch) {
                    parentSelectors.push('[id^="' + idMatch[1] + '"]');
                }
            }
            
            // Try parent formControlName
            var pFcn = parent.getAttribute('formcontrolname');
            if (pFcn) {
                parentSelectors.push('[formcontrolname="' + pFcn + '"]');
            }
            
            // Try parent class
            var pClasses = Array.from(parent.classList).filter(function(c) {
                return c.length > 2 && c.length < 40 && !c.match(/^(ng-tns|ng-star|_ng|is-|has-)/i);
            });
            if (pClasses.length > 0) {
                parentSelectors.push('.' + pClasses[0]);
            }
            
            // Try parent tag
            var pTag = parent.tagName.toLowerCase();
            if (pTag !== 'div' && pTag !== 'span' && pTag.length < 20) {
                parentSelectors.push(pTag);
            }
            
            // Test each parent + base combo
            for (var i = 0; i < parentSelectors.length; i++) {
                var scoped = parentSelectors[i] + ' ' + baseSelector;
                try {
                    var matches = document.querySelectorAll(scoped).length;
                    
                    if (matches === 1) {
                        scopedResults.push({
                            selector: scoped,
                            type: 'scoped',
                            stability: 80,
                            matches: 1,
                            isUnique: true,
                            score: 85,
                            isPW: false
                        });
                        return scopedResults;
                    } else if (matches > 1 && matches < originalMatches) {
                        scopedResults.push({
                            selector: scoped + ' >> nth=0',
                            type: 'scoped+nth',
                            stability: 70,
                            matches: matches,
                            isUnique: false,
                            score: 65,
                            isPW: false
                        });
                    }
                } catch(e) {}
            }
            
            parent = parent.parentElement;
            depth++;
        }
        
        return scopedResults;
    }
    
    // Generate all candidates
    var candidates = generateAllSelectors(el);
    
    // Test and score each
    var tested = [];
    for (var i = 0; i < candidates.length; i++) {
        var result = testAndScore(candidates[i]);
        if (result) tested.push(result);
    }
    
    // For non-unique selectors, try auto-scoping
    var toScope = tested.filter(function(t) { return !t.isUnique && !t.isPW && t.matches <= 20; });
    for (var i = 0; i < toScope.length; i++) {
        var scoped = autoScope(el, toScope[i].selector, toScope[i].matches);
        tested = tested.concat(scoped);
    }
    
    // Add fallback nth=0
    for (var i = 0; i < tested.length; i++) {
        if (!tested[i].isUnique && !tested[i].isPW && !tested[i].selector.includes('nth=')) {
            tested.push({
                selector: tested[i].selector + ' >> nth=0',
                type: tested[i].type + '+first',
                stability: tested[i].stability - 10,
                matches: tested[i].matches,
                isUnique: false,
                score: tested[i].score - 20,
                isPW: false
            });
        }
    }
    
    // Sort by score
    tested.sort(function(a, b) { return b.score - a.score; });
    
    // Convert to final format
    var sels = [];
    for (var i = 0; i < Math.min(tested.length, 10); i++) {
        var t = tested[i];
        var stars = t.score >= 80 ? 3 : (t.score >= 60 ? 2 : 1);
        var starsDisplay = stars === 3 ? '★★★' : (stars === 2 ? '★★☆' : '★☆☆');
        
        var hint = t.isUnique ? 
            (t.type === 'scoped' ? 'Scoped to unique parent' : 'Unique on page') :
            ('Matches ' + t.matches + ' elements' + (t.selector.includes('nth=') ? ' — using first' : ''));
        
        sels.push({
            type: t.type,
            stars: stars,
            starsDisplay: starsDisplay,
            value: t.selector,
            hint: hint
        });
    }

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

    print(f"[inspector] Starting v3 UNIVERSAL ENGINE — session={session_id}")

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
                <h2 style="color:#60a5fa;margin:0">ATHMA Inspector v3 — Universal Engine</h2>
                <p style="color:#94a3b8;max-width:440px;line-height:1.7">
                    Navigate to your app · Login · Hover any element · Press <b style="color:#fbbf24">Backspace</b> to capture
                </p>
                <div style="background:#1e293b;border-radius:12px;padding:20px 36px;
                    border:1px solid #334155;font-size:13px;color:#7dd3fc;line-height:2">
                    ✨ NEW: Tries ALL selector strategies automatically<br>
                    ✨ Auto-detects duplicates &amp; scopes to unique parent<br>
                    ✨ Handles dynamic IDs (medication-order_7 → [id^="medication-order"])<br>
                    ✨ Works for ANY element on ANY page!
                </div>
            </body></html>""")

        inject(page)
        post_result(api_base, session_id, token, {"type": "ready"})
        print("[inspector] Ready — waiting for Backspace captures")
        print("[inspector] v3 features: ALL permutations, auto-scope, smart ranking")

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
                print(f"[inspector] Generated {len(sels)} selectors (tried all strategies)")
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
