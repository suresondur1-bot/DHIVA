// ATHMA Smart Study Recorder
// Captures user actions via DOM events and sends directly to background
// Runs in MAIN world, uses postMessage to bridge to ISOLATED world

(function () {
  if (window.__athmaSmartStudyActive) return;
  window.__athmaSmartStudyActive = true;

  const SESSION = window.__athmaSmartStudySessionId || '';
  if (!SESSION) { console.warn('[SmartStudy] No sessionId'); return; }

  let seq = window.__athmaSmartStudyStartSeq || 0;

  function send(ev) {
    ev.seq = ++seq;
    ev.ts  = ev.ts || Date.now();
    ev.url = ev.url || location.href;
    ev.pageTitle = ev.pageTitle || document.title;
    // Store locally (survives if postMessage fails)
    if (!window.__athmaSmartStudyLocalEvents) window.__athmaSmartStudyLocalEvents = [];
    window.__athmaSmartStudyLocalEvents.push(ev);
    // Send via postMessage to isolated bridge
    try {
      window.postMessage({
        __athmaSmartStudy: { type: 'smart_study_events', sessionId: SESSION, events: [ev] }
      }, '*');
    } catch(e) {}
    console.log('[SR]', ev.action, ev.label || ev.selector, ev.value || '');
  }

  // ── Selector ──────────────────────────────────────────────────────────────
  function sel(el) {
    if (!el) return '';
    for (const a of ['data-testid','data-cy','data-qa'])
      if (el.getAttribute?.(a)) return `[${a}="${el.getAttribute(a)}"]`;
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !/^ng-/.test(el.id)) return '#' + el.id;
    const ng = el.tagName === 'NG-SELECT' ? el : el.closest?.('ng-select');
    if (ng) {
      // Priority 1: formcontrolname on ng-select itself
      const f = ng.getAttribute('formcontrolname');
      if (f) return `ng-select[formcontrolname="${f}"]`;
      // Priority 2: ng-reflect-name (Angular sets this at runtime)
      const rn = ng.getAttribute('ng-reflect-name');
      if (rn) return `ng-select[ng-reflect-name="${rn}"]`;
      // Priority 3: aria-label or placeholder on ng-select
      const aria = ng.getAttribute('aria-label') || ng.getAttribute('placeholder');
      if (aria) return `ng-select[aria-label="${aria}"]`;
      // Priority 4: formcontrolname on parent form element
      let node = ng.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node) break;
        const pf = node.getAttribute?.('formcontrolname') || node.getAttribute?.('ng-reflect-name');
        if (pf) {
          // Find index of this ng-select among siblings with same parent
          const siblings = Array.from(node.querySelectorAll(':scope > ng-select, :scope ng-select'));
          const idx = siblings.indexOf(ng);
          if (idx >= 0 && siblings.length > 1) return `[formcontrolname="${pf}"] ng-select:nth-of-type(${idx+1})`;
          return `[formcontrolname="${pf}"] ng-select`;
        }
        node = node.parentElement;
      }
      // Priority 5: nth-of-type based on position in the page
      const allNg = Array.from(document.querySelectorAll('ng-select'));
      const ngIdx = allNg.indexOf(ng);
      if (ngIdx >= 0) return `ng-select:nth-of-type(${ngIdx + 1})`;
      return 'ng-select';
    }
    const fcn = el.getAttribute?.('formcontrolname'); if (fcn) return `[formcontrolname="${fcn}"]`;
    const aria = el.getAttribute?.('aria-label'); if (aria) return `[aria-label="${aria}"]`;
    if (el.name && ['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    const ph = el.getAttribute?.('placeholder'); if (ph) return `[placeholder="${ph}"]`;
    const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g,' ').slice(0,40);
    if (el.tagName === 'BUTTON' && txt) return `button:has-text("${txt}")`;
    if (el.tagName === 'A' && el.id) return `#${el.id}`;
    const cls = Array.from(el.classList||[]).filter(c=>c.length>2&&!/^(ng-|_ng|d-|m-|p-|col-)/.test(c)).slice(0,2).join('.');
    return el.tagName.toLowerCase() + (cls ? '.'+cls : '');
  }

  // ── Label ─────────────────────────────────────────────────────────────────
  function lbl(el) {
    if (!el) return '';
    const aria = el.getAttribute?.('aria-label') || el.getAttribute?.('title');
    if (aria) return aria.trim();
    if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.innerText.replace('*','').trim(); }
    const fcn = el.getAttribute?.('formcontrolname'); if (fcn) return fcn.replace(/([A-Z])/g,' $1').replace(/_/g,' ').trim();
    const ph = el.getAttribute?.('placeholder'); if (ph) return ph.trim();
    let node = el;
    for (let i = 0; i < 6; i++) {
      node = node?.parentElement; if (!node) break;
      const l = node.querySelector?.('label,.label,.field-label,.form-label,.col-form-label');
      if (l && !l.contains(el)) return l.innerText.replace('*','').trim();
    }
    return (el.innerText||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
  }

  // ── INPUT events (username, password, text fields) ────────────────────────
  // Track per-selector: only send when user stops typing (on blur)
  const typing = new Map(); // selector → { value, timer }

  document.addEventListener('input', function(e) {
    const el = e.target;
    if (!['INPUT','TEXTAREA'].includes(el.tagName)) return;
    const t = (el.type||'').toLowerCase();
    if (['submit','button','reset','file','hidden','checkbox','radio'].includes(t)) return;
    if (el.closest?.('ng-select')) return;
    const s = sel(el);
    const v = el.value || '';
    // Debounce — update value, send after 600ms of no typing
    if (typing.has(s)) clearTimeout(typing.get(s).timer);
    const timer = setTimeout(() => {
      const current = el.value || '';
      if (!current.trim()) { typing.delete(s); return; }
      send({ action:'type', selector:s, label:lbl(el), value:current, fieldType:t||'text' });
      typing.delete(s);
    }, 600);
    typing.set(s, { value: v, timer });
  }, true);

  // Also send on blur (catches fast tabbing through fields)
  document.addEventListener('blur', function(e) {
    const el = e.target;
    if (!['INPUT','TEXTAREA'].includes(el.tagName)) return;
    const t = (el.type||'').toLowerCase();
    if (['submit','button','reset','file','hidden','checkbox','radio'].includes(t)) return;
    if (el.closest?.('ng-select')) return;
    const s = sel(el);
    if (!typing.has(s)) return; // not being tracked
    clearTimeout(typing.get(s).timer);
    typing.delete(s);
    const v = (el.value||'').trim();
    if (!v) return;
    send({ action:'type', selector:s, label:lbl(el), value:v, fieldType:t||'text' });
  }, true);

  // ── CLICK events ──────────────────────────────────────────────────────────
  let lastSel = '', lastTs = 0;

  document.addEventListener('click', function(e) {
    // ng-select option — highest priority
    const opt = e.target.closest?.('.ng-option');
    if (opt) {
      const ng = opt.closest('ng-select') || document.querySelector('ng-select.ng-select-opened');
      send({ action:'search_select', selector: ng?sel(ng):'ng-select', label: ng?lbl(ng):'Dropdown',
        value: (opt.innerText||'').trim(), fieldType:'ng-select' });
      return;
    }

    // Skip input/textarea/select — handled by input listener
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

    // Walk up to best element
    let best = e.target, node = e.target;
    for (let i = 0; i < 10; i++) {
      if (!node || node === document.body) break;
      if (node.id && /^[a-zA-Z][\w-]*$/.test(node.id) && !/^ng-/.test(node.id)) { best = node; break; }
      if (node.tagName === 'BUTTON') { best = node; break; }
      if (node.tagName === 'A') { best = node; break; }
      if (node.getAttribute?.('role') === 'button') { best = node; break; }
      if (node.getAttribute?.('role') === 'menuitem') { best = node; break; }
      if (node.getAttribute?.('routerlink') || node.getAttribute?.('routerLink')) { best = node; break; }
      node = node.parentElement;
    }

    const s = sel(best);
    const now = Date.now();
    if (s === lastSel && now - lastTs < 800) return; // dedup
    lastSel = s; lastTs = now;

    const rect = best.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;

    const label = lbl(best) || (best.innerText||best.textContent||'').trim().replace(/\s+/g,' ').slice(0,60) ||
      best.querySelector?.('[title]')?.getAttribute('title') || 'click';

    send({ action:'click', selector:s, label, value:'', fieldType:best.tagName.toLowerCase() });
    lastClickTs = Date.now();
  }, true);

  // mousedown for javascript:void(0) links (logout)
  document.addEventListener('mousedown', function(e) {
    const a = e.target.closest?.('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('javascript') && href !== '#' && href !== '') return;
    const s = sel(a);
    const now = Date.now();
    if (s === lastSel && now - lastTs < 800) return;
    lastSel = s; lastTs = now;
    send({ action:'click', selector:s, label:lbl(a)||(a.innerText||'').trim().slice(0,60), value:'', fieldType:'a' });
    lastClickTs = Date.now();
  }, true);

  // Native select
  document.addEventListener('change', function(e) {
    const el = e.target;
    if (el.tagName === 'SELECT') {
      const v = (el.options[el.selectedIndex]?.text||el.value||'').trim();
      send({ action:'select', selector:sel(el), label:lbl(el), value:v, fieldType:'select' });
    }
    if (el.tagName === 'INPUT' && (el.type||'').toLowerCase() === 'checkbox')
      send({ action:el.checked?'check':'uncheck', selector:sel(el), label:lbl(el), value:'', fieldType:'checkbox' });
  }, true);

  // ── NAVIGATION ────────────────────────────────────────────────────────────
  let lastUrl = location.href;
  let lastClickTs = 0; // timestamp of last click — used to detect click-triggered navigation

  function checkNav() {
    if (location.href === lastUrl) return;
    const prev = lastUrl; lastUrl = location.href;
    // Flush any pending typing events immediately on navigation
    typing.forEach(({ timer }, s) => clearTimeout(timer));
    typing.clear();
    // If a click happened within the last 2 seconds, this nav was triggered by a click
    // → record as wait_for_url (not navigate)
    const clickTriggered = (Date.now() - lastClickTs) < 2000;
    setTimeout(() => send({
      action: clickTriggered ? 'wait_for_url' : 'navigate',
      selector: '',
      label: document.title,
      value: location.href,
      pageTitle: document.title,
      fromUrl: prev
    }), 150);
  }

  window.addEventListener('popstate', checkNav);
  window.addEventListener('hashchange', checkNav);
  const navPoll = setInterval(checkNav, 600);

  // Flush pending typing on unload
  window.addEventListener('beforeunload', function() {
    typing.forEach(({ timer }, s) => {
      clearTimeout(timer);
      const el = document.querySelector(s);
      if (el && el.value?.trim()) send({ action:'type', selector:s, label:lbl(el), value:el.value.trim(), fieldType:el.type||'text' });
    });
  }, true);

  // ── STOP ──────────────────────────────────────────────────────────────────
  window.__athmaSmartStudyStop = function() {
    // Flush any pending typing
    typing.forEach(({ timer }, s) => {
      clearTimeout(timer);
      const el = document.querySelector(s);
      if (el && el.value?.trim()) send({ action:'type', selector:s, label:lbl(el), value:el.value.trim(), fieldType:el.type||'text' });
    });
    typing.clear();
    clearInterval(navPoll);
    clearTimeout(bannerRetry1);
    clearTimeout(bannerRetry2);
    window.__athmaSmartStudyStopped = true;
    window.__athmaSmartStudyActive = false;
    document.getElementById('__athma_ss_banner')?.remove();
    console.log('[SmartStudy] Stopped. Events:', (window.__athmaSmartStudyLocalEvents||[]).length);
  };

  try { chrome.runtime.onMessage.addListener(msg => { if (msg.type==='smart_study_stop'&&msg.sessionId===SESSION) window.__athmaSmartStudyStop?.(); }); } catch(e) {}

  // ── Banner ────────────────────────────────────────────────────────────────
  const sty = document.createElement('style');
  sty.textContent = '@keyframes ss{0%,100%{opacity:1}50%{opacity:.3}} #__athma_ss_banner{all:initial!important;position:fixed!important;top:10px!important;right:10px!important;z-index:2147483647!important;background:#6c5ce7!important;color:#fff!important;padding:8px 16px!important;border-radius:20px!important;font:700 13px/1 Arial,sans-serif!important;display:flex!important;align-items:center!important;gap:8px!important;box-shadow:0 4px 20px rgba(108,92,231,.6)!important;pointer-events:none!important;letter-spacing:0.5px!important;}';
  document.head.appendChild(sty);
  // Remove any existing banner first
  document.getElementById('__athma_ss_banner')?.remove();
  const b = document.createElement('div');
  b.id = '__athma_ss_banner';
  const dot = document.createElement('span');
  dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#fff;display:inline-block;animation:ss 1.2s ease-in-out infinite;flex-shrink:0';
  const txt = document.createTextNode(' 🎬 SMART RECORDING');
  b.appendChild(dot);
  b.appendChild(txt);
  // Append to body with retries (some SPAs replace body)
  let bannerRetry1, bannerRetry2;
  function attachBanner() {
    if (window.__athmaSmartStudyStopped) return; // don't re-attach after stop
    if (!document.getElementById('__athma_ss_banner') && document.body) {
      document.body.appendChild(b);
    }
  }
  attachBanner();
  bannerRetry1 = setTimeout(attachBanner, 500);
  bannerRetry2 = setTimeout(attachBanner, 1500);

  // Initial navigate
  send({ action:'navigate', selector:'', label:document.title, value:location.href, pageTitle:document.title, isStart:true });
  console.log('[SmartStudy] Active on:', location.href);
})();
