// QAVYA Recorder Content Script

(function () {
  if (window.__athmaRecorderActive) return;
  window.__athmaRecorderActive = true;

  let isRecording = true;
  let lastInputEl  = null;
  let lastInputVal = "";
  let lastInputTs  = 0;
  let lastInputSel = "";

  // ── Selector builder ──────────────────────────────────────────────────
  function buildSelector(el) {
    if (!el || el === document.body) return "body";

    // Priority 1: data-test attributes (HIGHEST - never change)
    for (const attr of ["data-testid","data-cy","data-qa","data-test","data-id","data-key"]) {
      if (el.getAttribute(attr)) return `[${attr}="${el.getAttribute(attr)}"]`;
    }

    // Priority 2: Stable ID (not auto-generated)
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !el.id.match(/^(ng-|ember|react-|vue-|w-node|\d)/i)) {
      return "#" + el.id;
    }

    // Priority 3: Angular formControlName (very stable in Angular apps)
    const fcn = el.getAttribute("formcontrolname") || el.getAttribute("formArrayName");
    if (fcn) return `[formcontrolname="${fcn}"]`;

    // Priority 4: ARIA label (accessibility-based, stable)
    if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;

    // Priority 5: Name attribute for form fields
    if (el.name && ["INPUT","SELECT","TEXTAREA"].includes(el.tagName))
      return `${el.tagName.toLowerCase()}[name="${el.name}"]`;

    // Priority 6: Placeholder (stable for inputs)
    if (el.getAttribute("placeholder")) return `[placeholder="${el.getAttribute("placeholder")}"]`;

    // Priority 7: Label 'for' attribute (for <label> elements)
    const forAttr = el.getAttribute("for");
    if (el.tagName === "LABEL" && forAttr) return `label[for="${forAttr}"]`;

    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList);

    // ATHMA sidebar module icon — each module has a unique athma-*-module-icon class
    const moduleIcon = classes.find(c => /^athma-.+-module-icon$/.test(c));
    if (moduleIcon) return `.${moduleIcon}`;

    // Sidebar submenu links — use href which is unique and stable
    if (tag === "a" && el.getAttribute("href")) {
      const href = el.getAttribute("href");  // always relative in Angular
      if (href.startsWith("/")) {
        return `a[href="${href}"]`;  // relative: /phrweb/dispense
      }
    }

    // ATHMA tab header buttons (li.si-container > button with athma-btn-priamry-outline class)
    if (tag === "button" && el.closest && el.closest("li.si-container")) {
      // Record exact text match — works like: buttons.find(b => b.textContent.trim() === text)
      const txt2 = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (txt2) return `button:has-text("${txt2}")`;
    }

    // Buttons and links with visible text — stable for tabs, nav items
    const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50);
    if ((tag === "button" || tag === "a") && txt && txt.length > 1 && txt.length < 50) {
      try {
        if (document.querySelectorAll(tag).length < 30) return `${tag}:has-text("${txt}")`;
      } catch(e) {}
    }

    // Class-based selector — skip noisy/dynamic/state classes
    const cls = classes
      .filter(c => c.length > 2
        && !/^(ng-|_ng|col-|row|d-|m-|p-|text-|btn-|is-|has-)/.test(c)
        && !/^(active|selected|open|show|focus|hover|disabled)$/.test(c))
      .slice(0, 2).join(".");
    if (cls) {
      const sel = `${tag}.${cls}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }

    return getCssSelectorPath(el);
  }

  function getCssSelectorPath(el) {
    const parts = [];
    // Stop at Angular component boundaries to keep selectors short
    const STOP_TAGS = new Set(["jhi-sidebar","jhi-main","app-root","ng-scrollbar","perfect-scrollbar"]);
    while (el && el.nodeType === 1 && el !== document.body) {
      let part = el.tagName.toLowerCase();
      if (STOP_TAGS.has(part)) {
        parts.unshift(part);
        break;
      }
      const sibs = el.parentNode
        ? Array.from(el.parentNode.children).filter(c => c.tagName === el.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      parts.unshift(part);
      el = el.parentNode;
    }
    return parts.join(" > ");
  }

  function getLabel(el) {
    const t = (el.innerText || el.textContent || "").trim().slice(0, 40);
    if (t) return t;
    if (el.getAttribute("aria-label"))  return el.getAttribute("aria-label");
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder");
    if (el.getAttribute("name"))        return el.getAttribute("name");
    return el.tagName.toLowerCase();
  }

  function send(step, ts) {
    if (!isRecording) return;
    try {
      chrome.runtime.sendMessage({ type: "recorder_step", step: { ...step, _ts: ts || Date.now() } });
    } catch(e) {}
  }

  // ── Track input typing in real time ──────────────────────────────────
  document.addEventListener("input", function(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!["INPUT","TEXTAREA"].includes(el.tagName)) return;
    const t = (el.type || "").toLowerCase();
    if (["submit","button","reset","image","file","checkbox","radio"].includes(t)) return;
    lastInputEl  = el;
    lastInputVal = el.value || "";
    lastInputTs  = Date.now();
    lastInputSel = buildSelector(el);
  }, true);

  // ── Flush pending type step BEFORE any click lands ───────────────────
  document.addEventListener("mousedown", function(e) {
    if (!isRecording || !lastInputEl || !lastInputVal.trim()) return;
    const clickedEl = e.target;
    if (clickedEl === lastInputEl || lastInputEl.contains(clickedEl)) return;
    send({
      action:   "type",
      selector: lastInputSel,
      value:    lastInputVal,
      label:    `Type "${lastInputVal.slice(0, 30)}"`,
      timeout:  30000,
    }, lastInputTs);
    lastInputEl  = null;
    lastInputVal = "";
    lastInputTs  = 0;
    lastInputSel = "";
  }, true);

  // ── Blur — catch type steps not followed by a click ──────────────────
  document.addEventListener("blur", function(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!["INPUT","TEXTAREA"].includes(el.tagName)) return;
    const t = (el.type || "").toLowerCase();
    if (["submit","button","reset","image","file","checkbox","radio"].includes(t)) return;
    if (lastInputEl === el && lastInputVal.trim()) {
      send({
        action:   "type",
        selector: lastInputSel,
        value:    lastInputVal,
        label:    `Type "${lastInputVal.slice(0, 30)}"`,
        timeout:  30000,
      }, lastInputTs);
      lastInputEl = null; lastInputVal = ""; lastInputTs = 0; lastInputSel = "";
    }
  }, true);

  // ── Click ─────────────────────────────────────────────────────────────
  document.addEventListener("click", function(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    if (["INPUT","TEXTAREA","SELECT"].includes(el.tagName)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    send({
      action:   "click",
      selector: buildSelector(el),
      value:    "",
      label:    `Click: ${getLabel(el)}`,
      timeout:  30000,
    });
  }, true);

  // ── Select ────────────────────────────────────────────────────────────
  document.addEventListener("change", function(e) {
    if (!isRecording) return;
    const el = e.target;
    if (el.tagName !== "SELECT") return;
    const text = el.options[el.selectedIndex]?.text || el.value;
    send({
      action:   "select",
      selector: buildSelector(el),
      value:    el.value,
      label:    `Select "${text}"`,
      timeout:  30000,
    });
  }, true);

  // ── Checkbox / Radio ──────────────────────────────────────────────────
  document.addEventListener("change", function(e) {
    if (!isRecording) return;
    const el = e.target;
    if (el.tagName !== "INPUT") return;
    const t = (el.type || "").toLowerCase();
    if (t !== "checkbox" && t !== "radio") return;
    send({
      action:   el.checked ? "check" : "uncheck",
      selector: buildSelector(el),
      value:    "",
      label:    `${el.checked ? "Check" : "Uncheck"} ${buildSelector(el)}`,
      timeout:  30000,
    });
  }, true);

  // ── Stop ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.type === "stop_recording") {
      if (lastInputEl && lastInputVal.trim()) {
        send({
          action:   "type",
          selector: lastInputSel,
          value:    lastInputVal,
          label:    `Type "${lastInputVal.slice(0, 30)}"`,
          timeout:  30000,
        }, lastInputTs);
      }
      isRecording = false;
      window.__athmaRecorderActive = false;
      const ind = document.getElementById("__athma_rec_indicator");
      if (ind) ind.remove();
    }
  });

  // ── Visual indicator ──────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = "@keyframes __athmaRec{0%,100%{opacity:1}50%{opacity:0.2}}";
  document.head.appendChild(style);
  const indicator = document.createElement("div");
  indicator.id = "__athma_rec_indicator";
  indicator.style.cssText = [
    "position:fixed","top:12px","right:12px","z-index:999999",
    "background:#dc2626","color:#fff","padding:6px 14px","border-radius:20px",
    "font-size:12px","font-weight:700","font-family:Arial,sans-serif",
    "display:flex","align-items:center","gap:7px",
    "box-shadow:0 4px 16px rgba(220,38,38,0.4)","pointer-events:none",
  ].join(";");
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#fff;animation:__athmaRec 1s ease-in-out infinite;";
  indicator.appendChild(dot);
  indicator.appendChild(document.createTextNode(" ATHMA RECORDING"));
  document.body.appendChild(indicator);

  console.log("[QAVYA Recorder] Active on", location.href);
})();
