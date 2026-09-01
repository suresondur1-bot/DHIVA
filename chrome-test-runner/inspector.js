// ATHMA Inspector v3 — UNIVERSAL SELECTOR ENGINE
// Automatically generates ALL selector strategies and intelligently scopes duplicates
(function() {
  var old = document.getElementById('__athma_ov__');
  if (old) old.remove();

  window.__athma_inspector_active__ = true;
  window.__athma_focused__ = null;

  document.documentElement.dispatchEvent(new MouseEvent('mousedown', {bubbles:false, cancelable:false}));
  window.focus();

  var ov = document.createElement('div');
  ov.id = '__athma_ov__';
  ov.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #1a56db;border-radius:4px;background:rgba(26,86,219,0.07);display:none;';
  var lbl = document.createElement('div');
  lbl.style.cssText = 'position:absolute;top:-26px;left:0;background:#1a56db;color:#fff;font:bold 11px monospace;padding:3px 8px;border-radius:4px;white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;';
  ov.appendChild(lbl);
  var hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;bottom:-22px;right:0;background:#0f172a;color:#7dd3fc;font:10px monospace;padding:2px 8px;border-radius:4px;white-space:nowrap;';
  hint.textContent = '✨v3 UNIVERSAL ENGINE | Backspace = capture | Esc = stop';
  ov.appendChild(hint);
  document.body.appendChild(ov);

  function highlight(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    var ngSel = el.closest ? el.closest('ng-select') : null;
    if (ngSel && el.tagName.toLowerCase() !== 'ng-select') el = ngSel;
    window.__athma_focused__ = el;
    var r = el.getBoundingClientRect();
    ov.style.display = 'block';
    // Overlay is position:fixed, so use viewport-relative rect values directly.
    // (Do NOT add scrollX/scrollY — that is only for position:absolute and was
    // causing the highlight to drift to the wrong element after scrolling.)
    ov.style.left   = r.left + 'px';
    ov.style.top    = r.top  + 'px';
    ov.style.width  = r.width + 'px';
    ov.style.height = r.height + 'px';
    var tag = el.tagName.toLowerCase();
    var fcn = el.getAttribute('formcontrolname') ? ' [' + el.getAttribute('formcontrolname') + ']' : '';
    var ngTag = (tag === 'ng-select') ? ' 🔍ng-select' : '';
    var txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    lbl.textContent = '<' + tag + (el.id ? '#' + el.id : '') + fcn + ngTag + '>' + (txt ? ' · ' + txt : '');
  }

  document.addEventListener('mousemove', function(e) {
    var el = e.target;
    if (!el || el === ov || ov.contains(el) || el === document.body || el === document.documentElement) return;
    window.__athma_focused__ = el;
    highlight(el);
  }, true);

  function onSpace(e) {
    if (e.code === 'Space' || e.key === 'Backspace') {
      var el = window.__athma_focused__;
      if (el && el.closest) {
        var ngSel = el.closest('ng-select');
        if (ngSel && el.tagName.toLowerCase() !== 'ng-select') el = ngSel;
      }
      console.log('[ATHMA] v3 UNIVERSAL ENGINE capturing:', el ? el.tagName + (el.id ? '#'+el.id : '') : 'NONE');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      ov.style.borderColor = '#22c55e';
      ov.style.background = 'rgba(34,197,94,0.15)';
      
      try {
        var result = buildResult(el);
        console.log('[ATHMA] v3 generated ' + result.selectors.length + ' selectors');
        console.log('[ATHMA] Selectors:', result.selectors.map(function(s){return s.value;}).join(', '));

        // Send result via postMessage to isolated world bridge (background.js handles the API call)
        try {
          window.postMessage({ type: '__athma_inspector_captured__', result: result }, '*');
          console.log('[ATHMA] postMessage sent successfully');
        } catch(msgErr) {
          console.error('[ATHMA] postMessage failed:', msgErr.message);
        }

      } catch(err) {
        console.error('[ATHMA] Error building result:', err);
      }
      
      setTimeout(stop, 500);
    }
    if (e.key === 'Escape') {
      stop();
      window.postMessage({ type: '__athma_inspector_stopped__' }, '*');
    }
  }
  window.addEventListener('keydown', onSpace, true);
  document.addEventListener('keydown', onSpace, {capture:true, passive:false});

  function stop() {
    var o = document.getElementById('__athma_ov__');
    if (o) o.remove();
    window.removeEventListener('keydown', onSpace, true);
    document.removeEventListener('keydown', onSpace, {capture:true, passive:false});
    window.__athma_inspector_active__ = false;
    window.__athma_focused__ = null;
  }
  window.__athma_stop_inspector__ = stop;

  console.log('[ATHMA] Inspector v3 UNIVERSAL ENGINE ready - hover element, press Backspace to capture');

  function buildResult(el) {
    // Icon/span walk-up to interactive parent
    var currentTag = el.tagName.toLowerCase();
    if (currentTag === 'i' || currentTag === 'span' || currentTag === 'svg' || currentTag === 'path') {
      var btn = el.closest('button, a, [role="button"]');
      if (btn) { console.log('[ATHMA] Walked up from <' + currentTag + '> to <' + btn.tagName.toLowerCase() + '>'); el = btn; }
    }
    
    // ng-select walk-up
    if (el && el.closest) {
      var ngSel = el.closest('ng-select');
      if (ngSel && el.tagName.toLowerCase() !== 'ng-select') el = ngSel;
    }
    
    var tag=el.tagName.toLowerCase(), id=el.id||'';
    var text=(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
    // SMART CLEAN: keep numbers in short text (PR numbers, MRN codes etc.)
    var clean;
    if (text.length <= 30) {
      clean = text.slice(0, 80); // short text — keep as-is
    } else {
      clean = text.replace(/\s*\(\d+[^)]*\)\s*$/,'').replace(/\s*\d+\s*$/,'').trim().slice(0,50);
    }
    var fcn=el.getAttribute('formcontrolname')||'';
    var aria=el.getAttribute('aria-label')||'';
    var ph=el.getAttribute('placeholder')||'';
    var name=el.getAttribute('name')||'';
    var itype=el.getAttribute('type')||'';
    var role=el.getAttribute('role')||'';
    var forAttr=el.getAttribute('for')||'';
    var jhi=el.getAttribute('jhitranslate')||el.getAttribute('jhi-translate')||'';
    var href=el.getAttribute('href')||'';
    
    var ta=null;
    ['data-testid','data-cy','data-qa','data-test','data-id'].forEach(function(a){
      if(!ta){var v=el.getAttribute(a);if(v)ta={name:a,value:v};}
    });
    
    var classes = [];
    var allClasses = [];
    el.classList.forEach(function(c) {
      allClasses.push(c);
      // CROSS-SYSTEM: Filter out environment-specific and dynamic classes
      if (c.length > 1 && c.length < 60 &&
          !c.match(/^(ng-tns|ng-star|_ng|__ng|css-|jsx-|sc-|is-|has-|active|selected|hover|open|show|focus|visible|disabled|fade|collapse)/i) &&
          // Additional cross-system filters:
          !c.match(/^(x-|ember-|react-|vue-|svelte-)/i) &&  // Framework prefixes
          !c.match(/^_[0-9a-f]{5,}$/i) &&  // Hash-based classes like _a3b5c
          !c.match(/^[a-z]+-[0-9]+$/i))    // Dynamic classes like col-3, item-123
        classes.push(c);
    });
    
    console.log('[DEBUG] Element classes found:', allClasses.join(', '));
    console.log('[DEBUG] Stable classes after filtering:', classes.join(', '));

    // ── IDENTIFYING vs GENERIC classes ───────────────────────────────────
    // Repeated widgets (icon buttons in table rows, toolbar icons) share a
    // wrapper class like .athma-icon-button/.icon and differ only by ONE
    // semantic class (.cpoe, .patient-transfer, .patient-chart). Building the
    // selector from DOM order alone picks the shared classes and matches every
    // instance on the page, so the identifying class must be ranked first.
    var GENERIC_CLASS = /^(athma-icon-button|athma-pointer|athma-btn[\w-]*|icon|icons|btn|button|link|action|actions|item|items|cell|wrapper|container|content|inner|outer|flex|center|left|right|top|bottom|first|last|small|large|sm|md|lg|xl|border|no-border|clickable|pointer|cursor-pointer|d-block|d-flex|d-none|d-inline[\w-]*|float-left|float-right|w-100|h-100|position-relative|position-absolute|text-center|text-left|text-right|ng-star-inserted|(?:m|p)(?:t|b|s|e|l|r|x|y)?-\d+|(?:row|col)(?:-[\w]+)*)$/i;
    var semanticCls = classes.filter(function(c){ return !GENERIC_CLASS.test(c); });
    var genericCls  = classes.filter(function(c){ return  GENERIC_CLASS.test(c); });
    // Identifying classes first — these are what actually tell siblings apart
    var rankedCls   = semanticCls.concat(genericCls);
    console.log('[DEBUG] Identifying classes:', semanticCls.join(', '), '| generic:', genericCls.join(', '));
    
    var roleMap={button:'button',a:'link',input:'textbox',select:'combobox',textarea:'textbox'};
    if(itype==='checkbox')role='checkbox';
    else if(itype==='radio')role='radio';
    else if(itype==='submit'||itype==='button')role='button';
    var inferRole=role||roleMap[tag]||'';

    // ═══════════════════════════════════════════════════════════════════════
    // UNIVERSAL SELECTOR ENGINE - Generate ALL candidates, test, auto-scope
    // ═══════════════════════════════════════════════════════════════════════

    function generateCandidates() {
      var cand = [];
      
      // Test attributes (highest priority)
      if (ta) cand.push({sel:'['+ta.name+'="'+ta.value+'"]', type:ta.name, stab:100});
      
      // ID
      if (id && !id.match(/^(ng-|ember|react-|vue-|w-node|\d)/i)) {
        // CROSS-SYSTEM FIX: Check if ID contains dynamic numbers
        var hasNumbers = /\d/.test(id);
        if (hasNumbers) {
          // ID might be dynamic (e.g., "patient-123", "order_456")
          var idPattern = id.replace(/\d+/g, '');
          if (idPattern.length > 2) {
            // Use partial match if ID has dynamic parts
            cand.push({sel:'[id^="'+idPattern+'"]', type:'id-prefix', stab:80});
          } else {
            // ID is mostly numbers, less reliable
            cand.push({sel:'#'+id, type:'id', stab:70});
          }
        } else {
          // ID has no numbers, very stable
          cand.push({sel:'#'+id, type:'id', stab:95});
        }
      }
      
      // Angular formControlName
      if (fcn) cand.push({sel:'[formcontrolname="'+fcn+'"]', type:'formControlName', stab:90});
      
      // ARIA label
      if (aria) cand.push({sel:'[aria-label="'+aria+'"]', type:'aria-label', stab:85});
      
      // CROSS-SYSTEM FIX: Normalize aria-label (remove dynamic parts)
      if (aria) {
        var normalizedAria = aria.replace(/\d{2}\/\d{2}\/\d{4}/g, '').replace(/\b\d+\b/g, '').trim();
        if (normalizedAria && normalizedAria !== aria && normalizedAria.length > 3) {
          cand.push({sel:'[aria-label*="'+normalizedAria+'"]', type:'aria-label-partial', stab:75});
        }
      }
      
      // Label for attribute
      if (tag==='label'&&forAttr) {
        cand.push({sel:'label[for="'+forAttr+'"]', type:'label-for', stab:85});
        cand.push({sel:'[for="'+forAttr+'"]', type:'for-attr', stab:80});
      }
      
      // Tag + name
      if (name&&['input','select','textarea','button'].indexOf(tag)>=0) 
        cand.push({sel:tag+'[name="'+name+'"]', type:'tag+name', stab:75});
      
      // Tag + type
      if (itype) {
        cand.push({sel:tag+'[type="'+itype+'"]', type:'tag+type', stab:70});
        cand.push({sel:'input[type="'+itype+'"]', type:'input+type', stab:65});
      }
      
      // Placeholder
      if (ph) cand.push({sel:'[placeholder="'+ph+'"]', type:'placeholder', stab:75});
      
      // Class-based — identifying classes FIRST, never raw DOM order
      for (var i=0; i<Math.min(semanticCls.length,3); i++) {
        cand.push({sel:tag+'.'+semanticCls[i], type:'tag+id-class', stab:78});
        cand.push({sel:'.'+semanticCls[i],     type:'id-class',     stab:72});
      }

      // Shared wrapper class + the one identifying class (e.g. .athma-icon-button.cpoe)
      if (semanticCls.length>0 && genericCls.length>0)
        cand.push({sel:tag+'.'+genericCls[0]+'.'+semanticCls[0], type:'tag+wrapper+id-class', stab:75});

      // Every stable class at once — most specific class-only form
      if (rankedCls.length>=2)
        cand.push({sel:tag+'.'+rankedCls.join('.'), type:'tag+all-classes', stab:70});

      for (var i=0; i<Math.min(rankedCls.length,3); i++) 
        cand.push({sel:'.'+rankedCls[i], type:'class', stab:50});
      
      if (rankedCls.length>0) 
        cand.push({sel:tag+'.'+rankedCls.slice(0,2).join('.'), type:'tag+class', stab:65});
      
      if (rankedCls.length>=2) 
        cand.push({sel:'.'+rankedCls.slice(0,2).join('.'), type:'multi-class', stab:60});
      
      // Playwright semantic
      if (inferRole&&clean&&tag!=='ng-select') 
        cand.push({sel:'get_by_role("'+inferRole+'", name="'+clean+'")', type:'getByRole', stab:70, isPW:true});
      
      if (clean&&clean.length>1&&['a','button','span','li','td','th','label','h1','h2','h3','p'].indexOf(tag)>=0) {
        // Only use get_by_text for stable text — not dynamic values like PR numbers, MRN codes
        var isDynVal = /^[A-Z]{0,5}\d{4,}$/.test(clean) || /^\d+$/.test(clean) || /^[A-Z0-9]{6,}$/.test(clean) || /\d{2}\/\d{2}\/\d{4}/.test(clean);
        if (!isDynVal) {
          cand.push({sel:'get_by_text("'+clean+'")', type:'getByText', stab:50, isPW:true});
        } else {
          // Dynamic value — generate structural XPath by walking up DOM
          var xpParts = [tag];
          var xpAncestor = el.parentElement;
          for (var xw=0; xw<8 && xpAncestor; xw++) {
            var xwTag = xpAncestor.tagName.toLowerCase();
            if (['h1','h2','h3','h4','h5','h6','td','th','li'].indexOf(xwTag) >= 0) {
              xpParts.unshift(xwTag);
            }
            var xwCls = Array.from(xpAncestor.classList||[]).find(function(c){
              return c.length > 4 && c.length < 60 &&
                     !c.match(/^(ng-tns|ng-star|_ng|is-|has-|active|open|show|focus|ng-reflect|d-flex|temp-color|border)/i);
            });
            if (xwCls) {
              var xpBuilt = '.' + '//' + xwTag + '[contains(@class,"' + xwCls + '")]' +
                            xpParts.map(function(p){ return '//' + p; }).join('');
              var xpCount = 0;
              try {
                var xpRes = document.evaluate(xpBuilt, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                xpCount = xpRes.snapshotLength;
              } catch(xe){}
              if (xpCount === 1) {
                cand.push({sel:xpBuilt, type:'xpath-structural', stab:95, isXP:true});
              } else if (xpCount > 1 && xpCount <= 5) {
                cand.push({sel:xpBuilt, type:'xpath-structural', stab:75, isXP:true});
              }
            }
            xpAncestor = xpAncestor.parentElement;
          }
        }
      }
      
      // Angular JHipster
      if (jhi) cand.push({sel:'[jhitranslate="'+jhi+'"]', type:'jhiTranslate', stab:75});

      // XPath — always generate for all elements
      // 1. Absolute XPath by ID
      if (id && !id.match(/^(ng-|ember|react-|vue-|w-node|\d)/i) && !/\d/.test(id)) {
        cand.push({sel:'//*[@id="'+id+'"]', type:'xpath-id', stab:90, isXP:true});
      }
      // 2. XPath by formControlName
      if (fcn) cand.push({sel:'//*[@formcontrolname="'+fcn+'"]', type:'xpath-fcn', stab:85, isXP:true});
      // 3. XPath by aria-label
      if (aria) cand.push({sel:'//*[@aria-label="'+aria+'"]', type:'xpath-aria', stab:80, isXP:true});
      // 4. XPath by placeholder
      if (ph) cand.push({sel:'//'+tag+'[@placeholder="'+ph+'"]', type:'xpath-placeholder', stab:75, isXP:true});
      // 5. XPath by text content (for buttons, links, labels)
      if (clean && clean.length > 1 && clean.length < 80 && ['button','a','span','label','h1','h2','h3','td','th','li'].indexOf(tag) >= 0) {
        cand.push({sel:'//'+tag+'[normalize-space(text())="'+clean+'"]', type:'xpath-text', stab:65, isXP:true});
        cand.push({sel:'//'+tag+'[contains(text(),"'+clean.slice(0,40)+'")]', type:'xpath-contains', stab:55, isXP:true});
      }
      // 6. XPath by walking up to stable parent
      var xpEl = el;
      var xpParent = xpEl.parentElement;
      for (var xd=0; xd<4 && xpParent; xd++) {
        var xpPId = xpParent.id;
        if (xpPId && !xpPId.match(/^(ng-|\d)/i)) {
          var xpSel = '//*[@id="'+xpPId+'"]//' + tag;
          cand.push({sel:xpSel, type:'xpath-parent-id', stab:80, isXP:true});
          break;
        }
        var xpPFcn = xpParent.getAttribute('formcontrolname');
        if (xpPFcn) {
          cand.push({sel:'//*[@formcontrolname="'+xpPFcn+'"]//' + tag, type:'xpath-parent-fcn', stab:75, isXP:true});
          break;
        }
        xpParent = xpParent.parentElement;
      }

      // ── TABLE CELL: dynamic-value CSS + XPath options ───────────────────
      // When element is a td/th, generate stable structural selectors by
      // walking up to the nearest table with a stable class, then using
      // nth-child for the column. These appear alongside all other options.
      if (tag === 'td' || tag === 'th') {
        var tdRow = el.parentElement; // <tr>
        if (tdRow && tdRow.tagName.toLowerCase() === 'tr') {
          var colIdx = Array.from(tdRow.children).indexOf(el) + 1; // 1-based
          var isDynCell = /^[A-Z]{0,5}\d{4,}$/.test(clean) || /^\d+$/.test(clean) || /^[A-Z0-9]{6,}$/.test(clean);

          // ── 1. CSS: walk up to find nearest table with stable class ──────
          var tblEl = el.closest('table');
          if (tblEl) {
            var tblCls = Array.from(tblEl.classList).filter(function(c) {
              return c.length > 3 && c.length < 60 &&
                !c.match(/^(ng-|table$|_ng|is-|has-)/i);
            });
            if (tblCls.length > 0) {
              // Use most specific table class
              var tblSel = 'table.' + tblCls[0];
              // CSS: table.classname tbody tr td:nth-child(N)
              var cssTblNth = tblSel + ' tbody tr ' + tag + ':nth-child(' + colIdx + ')';
              cand.push({sel: cssTblNth, type: 'css-table-nth', stab: 85});
            }
          }

          // ── 2. CSS: walk up to find nearest stable container div ─────────
          var containerEl = el.closest('[class]');
          var walked = 0;
          while (containerEl && walked < 8) {
            var ctag = containerEl.tagName.toLowerCase();
            if (ctag === 'td' || ctag === 'tr' || ctag === 'tbody' || ctag === 'table') {
              containerEl = containerEl.parentElement;
              walked++;
              continue;
            }
            var cCls = Array.from(containerEl.classList).find(function(c) {
              return c.length > 4 && c.length < 60 &&
                !c.match(/^(ng-tns|ng-star|_ng|is-|has-|active|open|show|ps--|d-flex|m-0|p-0|row|col)/i);
            });
            if (cCls) {
              // CSS: .container-class table tbody tr td:nth-child(N)
              var cssContNth = '.' + cCls + ' table tbody tr ' + tag + ':nth-child(' + colIdx + ')';
              var cssContCount = 0;
              try { cssContCount = document.querySelectorAll(cssContNth).length; } catch(e) {}
              cand.push({sel: cssContNth, type: 'css-container-nth', stab: cssContCount === 1 ? 90 : 75});
              break;
            }
            containerEl = containerEl.parentElement;
            walked++;
          }

          // ── 3. XPath: column position (works for any value) ──────────────
          cand.push({sel:'//tr[1]/'+tag+'['+colIdx+']', type:'xpath-col-position', stab:60, isXP:true});
          cand.push({sel:'//'+tag+'['+colIdx+']', type:'xpath-col-index', stab:50, isXP:true});

          // ── 4. XPath: table-class anchored ──────────────────────────────
          if (tblEl) {
            var tblClsXp = Array.from(tblEl.classList).find(function(c) {
              return c.length > 3 && !c.match(/^(ng-|table$|_ng)/i);
            });
            if (tblClsXp) {
              cand.push({sel:'//table[contains(@class,"'+tblClsXp+'")]//tbody//tr[1]/'+tag+'['+colIdx+']', type:'xpath-table-nth', stab:80, isXP:true});
            }
          }

          // ── 5. XPath: sibling-anchored (anchor from stable sibling cell) ─
          var siblings = Array.from(tdRow.children);
          for (var si=0; si<siblings.length; si++) {
            if (siblings[si] === el) continue;
            var sibText = (siblings[si].innerText || siblings[si].textContent || '').trim().replace(/\s+/g,' ');
            var sibIsDyn = /^[A-Z]{0,5}\d{4,}$/.test(sibText) || /^\d+$/.test(sibText) || /^[A-Z0-9]{6,}$/.test(sibText);
            if (sibText && sibText.length > 1 && sibText.length < 60 && !sibIsDyn) {
              var sibIdx = si + 1;
              var anchoredSel = '//tr['+tag+'['+sibIdx+'][normalize-space(text())="'+sibText+'"]]/'+tag+'['+colIdx+']';
              cand.push({sel:anchoredSel, type:'xpath-row-anchor', stab:85, isXP:true});
              break;
            }
          }

          // ── 6. XPath: starts-with prefix (when value has stable prefix) ──
          if (isDynCell) {
            var prefix = clean.replace(/\d+$/, '');
            if (prefix && prefix.length >= 1 && prefix.length < clean.length) {
              cand.push({sel:'//'+tag+'[starts-with(normalize-space(text()),"'+prefix+'")]', type:'xpath-starts-with', stab:70, isXP:true});
            }
            // store-as-variable hint
            cand.push({sel:'store_as_variable: get_text from '+tag+':nth-child('+colIdx+') then use {{variable_name}}', type:'xpath-store-var', stab:80, isPW:true});
          }
        }
      }
      // ── END TABLE CELL ───────────────────────────────────────────────────

      // ── ROW ACTION ELEMENT (icon buttons etc. living inside a <tr>) ──────
      // Every row repeats the same markup, so NO class-only selector can be
      // unique — it will always match once per row and fall back to nth=0
      // (which silently clicks row 1). Anchor on the row instead.
      var rowEl = el.closest ? el.closest('tr') : null;
      if (rowEl && ['tr','td','th'].indexOf(tag) < 0) {
        var actCls = semanticCls.length ? semanticCls[0] : (rankedCls[0] || '');
        var actSel = actCls ? tag + '.' + actCls : tag;

        // Anchor text: first meaningful value in the row (MRN, name, bed no.)
        var rowCells = Array.from(rowEl.children);
        var anchorTxt = '';
        for (var rc = 0; rc < rowCells.length; rc++) {
          var rct = (rowCells[rc].innerText || rowCells[rc].textContent || '').trim().replace(/\s+/g, ' ');
          if (rct && rct.length > 3 && rct.length < 60) { anchorTxt = rct; break; }
        }

        if (anchorTxt) {
          var esc = anchorTxt.replace(/"/g, '\\"');
          var anchorCount = 0;
          Array.from(document.querySelectorAll('tr')).forEach(function (r) {
            if ((r.innerText || '').indexOf(anchorTxt) < 0) return;
            try { anchorCount += r.querySelectorAll(actSel).length; } catch (e) {}
          });
          cand.push({sel:'tr:has-text("' + esc + '") ' + actSel, type:'row-anchored', stab:95, preCount:anchorCount});
          if (actCls) {
            cand.push({sel:'//tr[contains(., "' + esc + '")]//' + tag + '[contains(@class,"' + actCls + '")]',
                       type:'xpath-row-anchored', stab:90, isXP:true});
          }
          cand.push({sel:'tr:has-text("{{row_value}}") ' + actSel,
                     type:'row-anchored-variable', stab:88, preCount:anchorCount});
        }

        // Row by position — use only when the row order is deterministic
        var rowParent = rowEl.parentElement;
        var rowIdx = rowParent ? Array.from(rowParent.children).indexOf(rowEl) + 1 : 0;
        if (rowIdx > 0) {
          var posSel = 'tr:nth-child(' + rowIdx + ') ' + actSel;
          var posCount = 0;
          try { posCount = document.querySelectorAll(posSel).length; } catch (e) {}
          cand.push({sel:posSel, type:'row-position', stab:70, preCount:posCount});
        }
      }

      return cand;
    }

    function testAndScore(c) {
      try {
        var count;
        if (typeof c.preCount === 'number') {
          count = c.preCount;
        } else if (c.isPW) {
          count = 99;
        } else if (c.isXP) {
          try {
            var xpResult = document.evaluate(c.sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            count = xpResult.snapshotLength;
          } catch(xpErr) { return null; }
        } else {
          count = document.querySelectorAll(c.sel).length;
        }
        var isUniq = count === 1;
        var mult = isUniq ? 1.0 : (count===2 ? 0.7 : (count<=5 ? 0.5 : 0.2));
        return {
          selector:c.sel, type:c.type, stability:c.stab,
          matches:count, isUnique:isUniq,
          score:c.stab*mult, isPW:c.isPW||false, isXP:c.isXP||false
        };
      } catch(e) { return null; }
    }

    function autoScope(el, baseSel, origMatches) {
      console.log('[DEBUG] Auto-scoping:', baseSel, 'orig matches:', origMatches);
      var scoped = [];
      var p = el.parentElement;
      var depth = 0;
      
      while (p && depth < 5) {
        var pSels = [];
        
        // Try parent ID
        if (p.id && !p.id.match(/^(ng-|ember|react-|vue-|\d)/i)) {
          console.log('[DEBUG] Parent ID found:', p.id);
          pSels.push('#'+p.id);
          
          // Pattern match for dynamic IDs like "medication-order_7"
          var idMatch = p.id.match(/^([a-zA-Z][a-zA-Z0-9_-]*)_\d+$/);
          if (idMatch) {
            console.log('[DEBUG] Dynamic ID pattern matched! Prefix:', idMatch[1]);
            var dynamicIdSel = '[id^="'+idMatch[1]+'"]';
            pSels.push(dynamicIdSel);
            // IMPORTANT: Also try combining with semantic classes like .no-known-history
            var semanticParent = el;
            for (var k=0; k<depth && semanticParent; k++) {
              semanticParent = semanticParent.parentElement;
              if (semanticParent && semanticParent.classList) {
                var semanticCls = Array.from(semanticParent.classList).find(function(c){
                  return c.match(/no-known|not-required|checkbox-container/i) && c.length>5;
                });
                if (semanticCls) {
                  pSels.push(dynamicIdSel + ' .' + semanticCls);
                  console.log('[DEBUG] Added semantic combo:', dynamicIdSel + ' .' + semanticCls);
                }
              }
            }
          }
        }
        
        // Try parent formControlName
        var pFcn = p.getAttribute('formcontrolname');
        if (pFcn) pSels.push('[formcontrolname="'+pFcn+'"]');
        
        // Try ALL parent classes (up to 5)
        var pCls = Array.from(p.classList).filter(function(c){
          return c.length>2 && c.length<40 && !c.match(/^(ng-tns|ng-star|_ng|is-|has-)/i);
        });
        console.log('[DEBUG] Depth', depth, 'parent classes:', Array.from(p.classList).join(', '));
        console.log('[DEBUG] Depth', depth, 'stable parent classes:', pCls.join(', '));
        for (var j=0; j<Math.min(pCls.length, 5); j++) {
          pSels.push('.'+pCls[j]);
        }
        
        // Try parent tag
        var pTag = p.tagName.toLowerCase();
        if (pTag!=='div' && pTag!=='span' && pTag.length<20) pSels.push(pTag);
        
        // Test each parent + base combo
        console.log('[DEBUG] Depth', depth, '- trying', pSels.length, 'parent selectors');
        for (var i=0; i<pSels.length; i++) {
          var sc = pSels[i] + ' ' + baseSel;
          try {
            var m = document.querySelectorAll(sc).length;
            console.log('[DEBUG]   "' + sc + '" =>', m, 'matches');
            
            if (m===1) {
              // Perfect! Unique scoped selector
              console.log('[DEBUG] ✅ FOUND UNIQUE SCOPED SELECTOR!');
              scoped.push({
                selector:sc, 
                type:'scoped', 
                stability:85, 
                matches:1, 
                isUnique:true, 
                score:90, 
                isPW:false
              });
              // DON'T return yet - collect all unique scoped selectors
            } else if (m>1 && m<origMatches) {
              // Better but not perfect
              console.log('[DEBUG]  ↓ Better but not unique');
              scoped.push({
                selector:sc+' >> nth=0', 
                type:'scoped+nth', 
                stability:70, 
                matches:m, 
                isUnique:false, 
                score:65, 
                isPW:false
              });
            }
          } catch(e) {
            console.log('[DEBUG]  ❌ Invalid selector:', sc);
          }
        }
        
        p = p.parentElement;
        depth++;
      }
      
      return scoped;
    }

    // Generate all candidates
    var cands = generateCandidates();
    var tested = [];
    
    for (var i=0; i<cands.length; i++) {
      var t = testAndScore(cands[i]);
      if (t) tested.push(t);
    }

    // Auto-scope non-unique selectors
    console.log('[DEBUG] Total tested selectors:', tested.length);
    tested.forEach(function(t, idx) {
      console.log('[DEBUG] Selector', idx+':', t.selector, '- matches:', t.matches, 'isUnique:', t.isUnique, 'isPW:', t.isPW, 'score:', t.score.toFixed(1));
    });
    
    var toScope = tested.filter(function(t){
      // was <=20 — a table with 100+ repeated widgets never got scoped at all
      return !t.isUnique && !t.isPW && t.matches<=400;
    });
    
    console.log('[DEBUG] Selectors needing scoping:', toScope.length);
    
    for (var i=0; i<toScope.length; i++) {
      var sc = autoScope(el, toScope[i].selector, toScope[i].matches);
      tested = tested.concat(sc);
    }

    // Add nth=0 fallback for remaining non-unique
    for (var i=0; i<tested.length; i++) {
      if (!tested[i].isUnique && !tested[i].isPW && tested[i].selector.indexOf('nth=')<0) {
        tested.push({
          selector:tested[i].selector+' >> nth=0',
          type:tested[i].type+'+first',
          stability:tested[i].stability-10,
          matches:tested[i].matches,
          isUnique:false,
          score:tested[i].score-20,
          isPW:false
        });
      }
    }

    // Sort by score (highest first)
    tested.sort(function(a,b){return b.score-a.score;});

    // DEDUP: remove exact duplicate selectors
    var seenSel = {};
    tested = tested.filter(function(t){
      if (seenSel[t.selector]) return false;
      seenSel[t.selector] = true;
      return true;
    });

    // EMERGENCY FALLBACK: If NO selectors generated, use tag name
    if (tested.length === 0) {
      console.log('[DEBUG] ⚠️ NO SELECTORS GENERATED! Adding fallback tag selector');
      tested.push({
        selector: tag,
        type: 'tag-only',
        stability: 20,
        matches: 999,
        isUnique: false,
        score: 20,
        isPW: false
      });
      // Also try tag with nth=0
      tested.push({
        selector: tag + ' >> nth=0',
        type: 'tag-first',
        stability: 25,
        matches: 999,
        isUnique: false,
        score: 25,
        isPW: false
      });
    }

    // Balanced output — CSS + Playwright + XPath all shown
    var sels = [];
    var cssOnes = tested.filter(function(t){ return !t.isPW && !t.isXP; });
    var pwOnes  = tested.filter(function(t){ return t.isPW; });
    var xpOnes  = tested.filter(function(t){ return t.isXP; });
    var combined = [];
    for (var i=0; i<Math.min(cssOnes.length,8); i++) combined.push(cssOnes[i]);
    for (var i=0; i<Math.min(pwOnes.length,4);  i++) combined.push(pwOnes[i]);
    for (var i=0; i<Math.min(xpOnes.length,8);  i++) combined.push(xpOnes[i]);
    if (combined.length === 0) combined = tested.slice(0, 10);
    combined.sort(function(a,b){ return b.score-a.score; });
    // Final dedup
    var seenFinal = {};
    combined = combined.filter(function(t){
      if (seenFinal[t.selector]) return false;
      seenFinal[t.selector] = true;
      return true;
    });
    for (var i=0; i<combined.length; i++) {
      var t = combined[i];
      var stars = t.score>=80 ? 3 : (t.score>=60 ? 2 : 1);
      var starsDisplay = stars===3 ? '★★★' : (stars===2 ? '★★☆' : '★☆☆');
      var hint = t.isUnique ?
        (t.type==='scoped' ? 'Scoped to unique parent' : t.isXP ? 'XPath — unique on page' : 'Unique on page') :
        ((t.isXP ? 'XPath — ' : '') + 'Matches '+t.matches+' elements'+(t.selector.indexOf('nth=')>=0?' — using first':''));
      var label = t.isXP ? 'XPATH: '+t.type.replace('xpath-','').toUpperCase() : t.type.toUpperCase();
      sels.push({ type:label, stars:stars, starsDisplay:starsDisplay, value:t.selector, hint:hint, isXPath:t.isXP||false });
    }
    if (sels.length === 0) {
      sels.push({ type:'TAG', stars:1, starsDisplay:'★☆☆', value:tag, hint:'Tag only — fragile', isXPath:false });
    }

    return {
      selectors:sels, 
      element:{
        tag:tag, 
        id:id, 
        text:clean, 
        ariaLabel:aria, 
        placeholder:ph, 
        role:inferRole, 
        formControlName:fcn
      }
    };
  }
})();
