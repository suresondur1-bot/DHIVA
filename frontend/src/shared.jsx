import React, { useState, useEffect, useRef, useCallback } from "react";
// ── Dynamic API URL ────────────────────────────────────────────────────
// When served from the backend (port 6001), window.location.origin IS the API.
// When running Vite dev server (port 5176), fall back to localhost:6001.
const API = window.location.port === "5176"
  ? "http://10.8.7.176:6001"
  : window.location.origin;   // e.g. http://10.8.7.176:6001
const WS = API.replace(/^http/, "ws");

// ── Date/time formatting — locale driven by VITE_DATE_LOCALE ────────────────
// Previously every page hardcoded its own locale string (or omitted one
// entirely, which silently falls back to the browser/OS default — that's how
// dates ended up showing MM/DD/YYYY for some users). Now it's one setting in
// frontend/.env; change VITE_DATE_LOCALE there and every page picks it up on
// the next build. Defaults to "en-IN" (DD/MM/YYYY) if the .env var is unset.
const DATE_LOCALE = import.meta.env.VITE_DATE_LOCALE || "en-IN";

// Default to zero-padded numeric fields when the caller doesn't specify their
// own options — some locales (e.g. "ja-JP", used for YYYY/MM/DD) don't
// zero-pad single-digit months/days by default, so "2026/8/7" instead of
// "2026/08/07". Callers that pass their own opts (e.g. {month:"short"} for a
// compact display) are left exactly as they asked — this only fills the gap
// when nothing was specified at all.
const DEFAULT_DATE_OPTS = { year: "numeric", month: "2-digit", day: "2-digit" };

function formatDate(value, opts) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(DATE_LOCALE, opts || DEFAULT_DATE_OPTS);
}

function formatDateTime(value, opts) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(DATE_LOCALE, opts || { ...DEFAULT_DATE_OPTS, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatTime(value, opts) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(DATE_LOCALE, { hour12: false, ...opts });
}

// Page size helpers — kept for backward compatibility
const APP_PAGE_SIZE = 10;
const _cfg = { pageSize: parseInt(localStorage.getItem("athma_page_size") || "10") };
const getAppPageSize = () => _cfg.pageSize;
const setAppPageSize = (n) => {
  if (n > 0) { _cfg.pageSize = n; localStorage.setItem("athma_page_size", String(n)); }
};




// ─── THEME ────────────────────────────────────────────────────────────────────
const C = {
  bg:       "#f0f2f5",
  surface:  "#ffffff",
  card:     "#ffffff",
  card2:    "#f8f9fc",
  border:   "#e2e6ed",
  border2:  "#cdd3dc",
  accent:   "#1a6fc4",
  accent2:  "#6c5ce7",
  green:    "#00a86b",
  red:      "#e53935",
  yellow:   "#f59e0b",
  orange:   "#f97316",
  text:     "#1a2332",
  textDim:  "#8a96a8",
  textMid:  "#4a5568",
  mono:     "'IBM Plex Mono', monospace",
};

// ─── API HELPER ───────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("autoqa_token");
const getUser  = () => { try { return JSON.parse(localStorage.getItem("autoqa_user")); } catch { return null; } };

async function api(path, opts = {}) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { localStorage.clear(); window.location.reload(); }
  // Try JSON first — if server returned HTML (e.g. unhandled Express error), show raw text
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    const preview = text.slice(0, 200).replace(/<[^>]+>/g, "").trim();
    throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${preview}`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── STATUS COLORS ────────────────────────────────────────────────────────────
const statusColor = {
  passed:    "#00a86b",
  failed:    "#e53935",
  running:   "#1a6fc4",
  queued:    "#f59e0b",
  error:     "#f97316",
  cancelled: "#8a96a8",
};
const statusBg = {
  passed:    "#e6f7f1",
  failed:    "#fdecea",
  running:   "#e3f0fb",
  queued:    "#fef9e7",
  error:     "#fff3e0",
  cancelled: "#f5f6f8",
};
const priorityColor = { low: "#64748b", medium: "#f59e0b", high: "#f97316", critical: "#e53935" };

// ─── STYLES ───────────────────────────────────────────────────────────────────
// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { box-sizing: border-box; }
    body { margin: 0; background: #f0f2f5; font-family: 'Inter','Segoe UI',sans-serif; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #f0f2f5; }
    ::-webkit-scrollbar-thumb { background: #cdd3dc; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #b0bac8; }
    input:focus, select:focus, textarea:focus {
      border-color: #1a6fc4 !important;
      box-shadow: 0 0 0 2px rgba(26,111,196,0.15) !important;
      outline: none !important;
    }
    button:hover { opacity: 0.9; }
    tr:hover td { background: #f8f9fc !important; }
    @keyframes spin { to { transform: rotate(360deg) } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes poweredBlink { 0%,100% { opacity:1; } 50% { opacity:0.15; } }
  `}</style>
);

const s = {
  app: { minHeight: "100vh", background: "#f0f2f5", color: "#1a2332", fontFamily: "'Inter','Segoe UI',sans-serif", display: "flex" },
  sidebar: {
    width: 240,
    height: "100vh",
    background: "#ffffff",
    borderRight: "1px solid #e8eaf0",
    display: "flex", flexDirection: "column",
    position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 100,
    boxShadow: "2px 0 8px rgba(0,0,0,0.04)",
    overflow: "hidden",
  },
  logo: { padding: "16px 20px 14px", borderBottom: "1px solid #f0f2f5" },
  logoText: { fontSize: 14, fontWeight: 800, color: "#8B0000", fontFamily: "'Inter','Segoe UI',sans-serif", lineHeight: 1.3 },
  logoSub: { fontSize: 9, color: "#cc5500", marginTop: 2, letterSpacing: "0.14em", textTransform: "uppercase" },
  nav: (active) => ({
    display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
    cursor: "pointer",
    color: active ? "#1a56db" : "#374151",
    fontWeight: active ? 600 : 400,
    fontSize: 13,
    background: active ? "#eff6ff" : "transparent",
    borderRadius: 8,
    margin: "1px 8px",
    transition: "all 0.12s",
  }),
  main: { marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh", background: "#f3f4f6" },
  topbar: {
    height: 60, background: "#ffffff",
    borderBottom: "1px solid #e2e6ed",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 24px", position: "sticky", top: 0, zIndex: 50,
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
  },
  content: { padding: "24px", flex: 1 },
  card: { background: "#ffffff", border: "1px solid #e2e6ed", borderRadius: 8, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  row: { display: "flex", gap: 16, flexWrap: "wrap" },
  col: { display: "flex", flexDirection: "column", gap: 16 },
  input: {
    background: "#ffffff", border: "1px solid #cdd3dc", borderRadius: 5,
    padding: "8px 12px", color: "#1a2332", fontSize: 13, width: "100%",
    outline: "none", fontFamily: "'Inter','Segoe UI',sans-serif", boxSizing: "border-box",
  },
  pageTitle: { fontSize: 22, fontWeight: 800, color: "#8B0000", fontFamily: "'Inter','Segoe UI',sans-serif" },
  label: { fontSize: 12, color: "#4a5568", marginBottom: 5, display: "block", fontWeight: 600 },
  btn: (v = "primary", sm) => ({
    padding: sm ? "5px 12px" : "7px 16px",
    borderRadius: 5, cursor: "pointer",
    fontSize: sm ? 12 : 13, fontWeight: 600, transition: "all 0.15s",
    fontFamily: "'Inter','Segoe UI',sans-serif",
    border: v === "ghost" ? "1px solid #cdd3dc" : "none",
    background:
      v === "primary" ? "#1a6fc4" :
      v === "success" ? "#00a86b" :
      v === "danger"  ? "#e53935" :
      v === "warn"    ? "#f59e0b" :
      v === "purple"  ? "#6c5ce7" :
      v === "ghost"   ? "#ffffff" : "#e2e6ed",
    color: v === "ghost" ? "#4a5568" : "#ffffff",
    boxShadow: v !== "ghost" ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
  }),
  modal: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 },
  modalBox: {
    background: "#ffffff", border: "1px solid #e2e6ed", borderRadius: 10,
    padding: 28, width: "100%", maxWidth: 640, maxHeight: "90vh", overflowY: "auto",
    boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 14px", fontSize: 12, fontWeight: 600, color: "#4a5568", background: "#f8f9fc", borderBottom: "2px solid #e2e6ed", borderTop: "1px solid #e2e6ed" },
  td: { padding: "11px 14px", fontSize: 13, borderBottom: "1px solid #f0f2f5", verticalAlign: "middle", color: "#1a2332" },
  badge: (color, bg) => ({ display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, color, background: bg }),
  tag: { background: "#ede9fe", color: "#5b21b6", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 },
};

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────
const Spinner = ({ size = 28 }) => (
  <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
    <div style={{ width: size, height: size, border: "2px solid #e2e6ed", borderTop: "2px solid #1a6fc4", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>
);

const Badge = ({ status }) => (
  <span style={s.badge(statusColor[status] || "#4a5568", statusBg[status] || "#f5f6f8")}>{status}</span>
);

const Empty = ({ msg }) => (
  <div style={{ textAlign: "center", padding: "48px 24px", color: "#8a96a8", fontSize: 14 }}>
    <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>{msg}
  </div>
);


function Pagination({ page, pages, total, pageSize, onPage }) {
  if (!pages || pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to   = Math.min(page * pageSize, total);
  const nums  = [];
  // Build unique sorted page numbers — use Set to avoid duplicates
  const showSet = new Set([1, pages, page-2, page-1, page, page+1, page+2]
    .filter(p => p >= 1 && p <= pages));
  let prev = 0;
  [...showSet].sort((a,b)=>a-b).forEach(p => {
    if (prev && p - prev > 1) nums.push({ type:"ellipsis", id:`e-${prev}-${p}` });
    nums.push({ type:"page", n:p, id:`p-${p}` });
    prev = p;
  });
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
      padding:"10px 4px", flexWrap:"wrap", gap:8 }}>
      <div style={{ fontSize:12, color:"#8a96a8" }}>
        Showing <b>{from}–{to}</b> of <b>{total}</b> records
      </div>
      <div style={{ display:"flex", gap:4, alignItems:"center" }}>
        <button onClick={()=>onPage(page-1)} disabled={page===1}
          style={{ ...s.btn("ghost",true), fontSize:12, padding:"4px 10px", opacity:page===1?0.4:1 }}>
          ← Prev
        </button>
        {nums.map(item => item.type==="ellipsis"
          ? <span key={item.id} style={{ padding:"4px 6px", color:"#8a96a8" }}>…</span>
          : <button key={item.id} onClick={()=>onPage(item.n)}
              style={{ ...s.btn(item.n===page?"primary":"ghost",true), fontSize:12,
                padding:"4px 10px", minWidth:32 }}>
              {item.n}
            </button>
        )}
        <button onClick={()=>onPage(page+1)} disabled={page===pages}
          style={{ ...s.btn("ghost",true), fontSize:12, padding:"4px 10px", opacity:page===pages?0.4:1 }}>
          Next →
        </button>
      </div>
    </div>
  );
}


// ── Smart Selector Simplifier ───────────────────────────────────────────────────────────────
const _SMART_KNOWN = [
  [/app-root[^"']*form[^"']*button/,                               'button[type="submit"]'],
  [/athma-tabs-header[^"']*ul[^"']*li[^"']*>\s*button/,           'athma-tabs-header li.si-container > button'],
  [/athma-page-header[^"']*ul[^"']*li[^"']*>\s*button/,           'athma-tabs-header li > button'],
  [/jhi-dispense-patient-search[^"']*tbody[^"']*td[^"']*>\s*span/, 'jhi-dispense-patient-search tbody tr td span'],
  [/jhi-dispense-patient-search[^"']*tbody[^"']*td/,              'jhi-dispense-patient-search tbody tr td'],
  [/ng-select[^"']*input/,                                        'ng-select input'],
  [/ng-dropdown-panel[^"']*span/,                                 '.ng-dropdown-panel .ng-option'],
  [/ng-dropdown-panel[^"']*div/,                                  '.ng-dropdown-panel .ng-option'],
];
const _SMART_STRIP = [
  /^app-root\s*>\s*div\s*>\s*section\s*>\s*[^>]+>\s*jhi-home\s*>\s*/,
  /^app-root\s*>\s*div\s*>\s*section\s*>\s*[^>]+>\s*jhi-sidebar\s*>\s*/,
  /^app-root\s*>\s*div\s*>\s*section\s*>\s*[^>]+>\s*/,
  /^app-root\s*>\s*div\s*>\s*section\s*>\s*/,
  /^jhi-main\s*>\s*div\s*>\s*section\s*>\s*[^>]+>\s*/,
  /^jhi-main\s*>\s*div\s*>\s*section\s*>\s*/,
  /^body\s*>\s*/,
];
const _SIDEBAR_MODULES = [
  null,
  'athma-my-dashboard-module-icon',
  'athma-inventory-module-icon',
  'athma-pharmacy-module-icon',
  'athma-ambulatory-module-icon',
  'athma-hsm-module-icon',
  'athma-ehr-module-icon',
  'athma-adt-module-icon',
  'athma-billing-module-icon',
  'athma-ot-module-icon',
  'athma-medical-record-module-icon',
  'athma-blood-bank-module-icon',
  'athma-lis-module-icon',
  'athma-asetu-module-icon',
  'athma-ris-module-icon',
  'athma-srm-module-icon',
  'athma-prm-module-icon',
  'athma-hcx-module-icon',
  'athma-purchase-module-icon',
  'athma-sales-module-icon',
  'athma-clinical-research-module-icon',
  'athma-ims-module-icon',
  'athma-dms-module-icon',
  'athma-dietary-module-icon',
  'athma-sms-module-icon',
  'athma-spm-module-icon',
  'athma-cpm-module-icon',
  'athma-administration-module-icon',
];
const _INTERACTIVE = new Set(['button','input','select','textarea','a','td','th','tr','span','li']);

function smartSel(sel) {
  if (!sel) return sel;
  if (/^#[\w-]+$/.test(sel)) return sel;
  if (sel.startsWith('[') || sel.startsWith('get_by')) return sel;
  if (!sel.includes('>')) return sel;
  const hasNth = sel.includes('nth-of-type') || sel.includes('nth-child');

  // ── Sidebar module icon span (various recorder formats) ──────────────────
  // Format 1: ng-scrollbar > span  (extension recorder via ng-scrollbar parent)
  if (/^ng-scrollbar\s*>\s*span$/.test(sel)) return sel; // too generic, can't map without nth
  // Format 2: ng-scrollbar > div:nth-of-type(N) > span
  // Format 3: div > div:nth-of-type(N) > span
  const nthSpan = sel.match(/(?:ng-scrollbar\s*>\s*)?div:nth-of-type\((\d+)\)\s*>\s*span$/) ||
                  sel.match(/^div\s*>\s*div:nth-of-type\((\d+)\)\s*>\s*span$/);
  if (nthSpan) {
    const icon = _SIDEBAR_MODULES[+nthSpan[1]];
    if (icon) return `.${icon}`;
    return sel;
  }

  // ── Sidebar submenu links — convert to direct navigate (links are hidden/collapsed in DOM)
  // Any path ending in li > a from sidebar — use page.goto() instead of click
  if (sel.endsWith('> a') && sel.includes('li')) {
    // Can't click hidden links — smartSel converts to navigate action instead
    // This is handled at step level by Pages1.jsx when saving
    const liNth = sel.match(/li:nth-of-type\((\d+)\)\s*>\s*a$/);
    if (liNth) return `jhi-sidebar ul li:nth-of-type(${liNth[1]}) > a`;
  }
  const nthLink = sel.match(/(?:ng-scrollbar\s*>\s*)?(?:ul\s*>\s*)?li:nth-of-type\((\d+)\)\s*>\s*a$/) ||
                  sel.match(/^ul\s*>\s*li:nth-of-type\((\d+)\)\s*>\s*a$/);
  if (nthLink) return `jhi-sidebar ul li:nth-of-type(${nthLink[1]}) > a`;

  // ── Tabs header button ───────────────────────────────────────────────────
  if (/li:nth-of-type\(\d+\)\s*>\s*button$/.test(sel)) return 'athma-tabs-header li.si-container > button';

  if (sel.split('>').length <= 3 && !hasNth) return sel;
  for (const [re, replacement] of _SMART_KNOWN) { if (re.test(sel)) return replacement; }
  let s = sel;
  for (const re of _SMART_STRIP) s = s.replace(re, '');
  const segs = s.split('>').map(p => p.trim().replace(/:nth-of-type\(\d+\)/g,'').replace(/:nth-child\(\d+\)/g,'').trim()).filter(Boolean);
  const meaningful = segs.filter(seg => { const base = seg.split(/[.#[:/]/)[0].trim(); return seg.includes('.') || seg.includes('#') || seg.includes('[') || base.includes('-') || _INTERACTIVE.has(base); });
  if (meaningful.length) return meaningful.slice(-3).join(' > ');
  return segs.slice(-3).join(' > ') || sel;
}

export { API, WS, APP_PAGE_SIZE, C, s, api, getToken, getUser, GlobalStyle,
         Spinner, Badge, Empty, Pagination,
         statusColor, statusBg, priorityColor,
         getAppPageSize, setAppPageSize, smartSel,
         formatDate, formatDateTime, formatTime,
};
