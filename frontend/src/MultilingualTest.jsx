import React, { useState, useEffect, useRef } from "react";
import { api, s } from "./shared.jsx";

const LANGUAGES = [
  { code: "en", label: "English",  flag: "🇬🇧" },
  { code: "el", label: "Greek",    flag: "🇬🇷" },
  { code: "ar", label: "Arabic",   flag: "🇸🇦" },
  { code: "hi", label: "Hindi",    flag: "🇮🇳" },
  { code: "fr", label: "French",   flag: "🇫🇷" },
  { code: "de", label: "German",   flag: "🇩🇪" },
  { code: "es", label: "Spanish",  flag: "🇪🇸" },
];

const LANG_MAP = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));

const scoreColor = s => s >= 90 ? "#10b981" : s >= 70 ? "#f59e0b" : "#ef4444";
const scoreLabel = s => s >= 90 ? "Excellent" : s >= 70 ? "Partial" : "Poor";

export default function MultilingualTest() {
  const [projects,     setProjects]     = useState([]);
  const [projectId,    setProjectId]    = useState("");
  const [testCases,    setTestCases]    = useState([]);
  const [testCaseId,   setTestCaseId]   = useState("");
  const [baseLang,     setBaseLang]     = useState("en");
  const [targetLang,   setTargetLang]   = useState("el");
  const [baselines,    setBaselines]    = useState([]);
  const [results,      setResults]      = useState([]);
  const [comparing,    setComparing]    = useState(false);
  const [activeResult, setActiveResult] = useState(null);
  const [expandedPage, setExpandedPage] = useState(null);
  const [tab,          setTab]          = useState("setup"); // setup | results

  useEffect(() => {
    api("/api/projects").then(r => setProjects(r || []));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api(`/api/tests?project_id=${projectId}&limit=200`)
       .then(r => setTestCases(Array.isArray(r) ? r : (r?.rows || r?.tests || [])));
  }, [projectId]);

  useEffect(() => {
    if (!testCaseId) return;
    loadBaselines();
    loadResults();
  }, [testCaseId]);

  function loadBaselines() {
    api(`/api/multilingual/baselines/${testCaseId}`)
       .then(r => setBaselines(r || []));
  }

  function loadResults() {
    api(`/api/multilingual/results/${testCaseId}`)
       .then(r => setResults(r || []));
  }

  async function runComparison() {
    if (!testCaseId) return alert("Please select a test case");
    const hasBase   = baselines.some(b => b.language === baseLang);
    const hasTarget = baselines.some(b => b.language === targetLang);
    if (!hasBase)   return alert(`No ${LANG_MAP[baseLang]?.label} baseline found. Run the test in ${LANG_MAP[baseLang]?.label} first with capture_page_text steps.`);
    if (!hasTarget) return alert(`No ${LANG_MAP[targetLang]?.label} baseline found. Change language to ${LANG_MAP[targetLang]?.label} in ATHMA, run the test again.`);
    setComparing(true);
    try {
      const r = await api("/api/multilingual/compare", { method:'POST', body: {
        test_case_id:    testCaseId,
        base_language:   baseLang,
        target_language: targetLang
      } });
      setActiveResult(r);
      setTab("results");
      loadResults();
    } catch(e) {
      alert("Comparison failed: " + (e.response?.data?.error || e.message));
    } finally {
      setComparing(false);
    }
  }

  async function deleteBaseline(lang) {
    if (!confirm(`Delete ${LANG_MAP[lang]?.label} baseline?`)) return;
    await api(`/api/multilingual/baseline/${testCaseId}/${lang}`, { method:'DELETE' });
    loadBaselines();
  }

  async function viewResult(id) {
    const r = await api(`/api/multilingual/result/${id}`);
    setActiveResult(r);
    setTab("results");
  }

  function downloadPDF() {
    const style = document.createElement('style');
    style.innerHTML = `
      @media print {
        body * { visibility: hidden; }
        #ml-report, #ml-report * { visibility: visible; }
        #ml-report { position: absolute; left: 0; top: 0; width: 100%; }
        .no-print { display: none !important; }
        table { border-collapse: collapse; width: 100%; font-size: 11px; }
        th, td { border: 1px solid #e2e8f0; padding: 5px 8px; text-align: left; }
        th { background: #f8fafc !important; font-weight: 600; }
      }
    `;
    document.head.appendChild(style);
    window.print();
    document.head.removeChild(style);
  }

  const tc = testCases.find(t => String(t.id) === String(testCaseId));

  return (
    <div style={{ padding: "24px", maxWidth: 1100, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#1e293b", display: "flex", alignItems: "center", gap: 10 }}>
          🌐 Multilingual Testing
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
          Verify UI labels, buttons and text are correctly translated across languages
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #e2e8f0" }}>
        {["setup", "results"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "8px 20px", border: "none", background: "none", cursor: "pointer",
            fontWeight: tab === t ? 700 : 400, color: tab === t ? "#6366f1" : "#64748b",
            borderBottom: tab === t ? "2px solid #6366f1" : "2px solid transparent",
            marginBottom: -2, fontSize: 13, textTransform: "capitalize"
          }}>{t === "setup" ? "⚙️ Setup & Run" : "📊 Results"}</button>
        ))}
      </div>

      {/* SETUP TAB */}
      {tab === "setup" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Step 1 — Select Test */}
          <div style={cardStyle}>
            <div style={stepHeader}>1️⃣ Select Test Case</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <select value={projectId} onChange={e => { setProjectId(e.target.value); setTestCaseId(""); }}
                style={selectStyle}>
                <option value="">— Select Project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={testCaseId} onChange={e => setTestCaseId(e.target.value)}
                style={{ ...selectStyle, flex: 2 }} disabled={!projectId}>
                <option value="">— Select Test Case —</option>
                {testCases.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {/* Step 2 — Baselines */}
          {testCaseId && (
            <div style={cardStyle}>
              <div style={stepHeader}>2️⃣ Language Baselines</div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
                Run the test case with <code style={codeStyle}>capture_page_text</code> steps
                added — once per language to capture text snapshots.
              </div>

              {/* Baseline status */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                {LANGUAGES.map(lang => {
                  const bl = baselines.filter(b => b.language === lang.code);
                  const hasIt = bl.length > 0;
                  return (
                    <div key={lang.code} style={{
                      padding: "8px 14px", borderRadius: 8, fontSize: 12,
                      background: hasIt ? "#f0fdf4" : "#f8fafc",
                      border: `1px solid ${hasIt ? "#86efac" : "#e2e8f0"}`,
                      display: "flex", alignItems: "center", gap: 6
                    }}>
                      <span>{lang.flag}</span>
                      <span style={{ fontWeight: 600 }}>{lang.label}</span>
                      <span style={{ fontSize: 10, color: "#94a3b8", background: "#f1f5f9", 
                        padding: "1px 5px", borderRadius: 4, fontFamily: "monospace" }}>
                        {lang.code}
                      </span>
                      {hasIt ? (
                        <>
                          <span style={{ color: "#10b981" }}>✅</span>
                          <span style={{ color: "#64748b" }}>
                            {bl.length} page{bl.length > 1 ? "s" : ""},&nbsp;
                            {bl[0]?.element_count} elements
                          </span>
                          <button onClick={() => deleteBaseline(lang.code)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", fontSize: 11 }}>
                            🗑
                          </button>
                        </>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>Not captured</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Instructions */}
              <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 14, fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: "#1d4ed8", marginBottom: 8 }}>📋 How to capture baselines:</div>
                <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 2, color: "#1e40af" }}>
                  <li>Add <code style={codeStyle}>capture_page_text</code> step after each <code style={codeStyle}>navigate</code> in your test</li>
                  <li>Set <b>value</b> = <code style={codeStyle}>en</code> for English run</li>
                  <li>Run the test — English baseline is captured automatically</li>
                  <li>Change language to Greek in ATHMA app</li>
                  <li>Change <b>value</b> = <code style={codeStyle}>el</code> in capture steps</li>
                  <li>Run again — Greek baseline is captured</li>
                </ol>
              </div>
            </div>
          )}

          {/* Step 3 — Compare */}
          {testCaseId && (
            <div style={cardStyle}>
              <div style={stepHeader}>3️⃣ Run Comparison</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Base:</span>
                  <select value={baseLang} onChange={e => setBaseLang(e.target.value)} style={selectStyle}>
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
                  </select>
                </div>
                <span style={{ fontSize: 18, color: "#94a3b8" }}>→</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Target:</span>
                  <select value={targetLang} onChange={e => setTargetLang(e.target.value)} style={selectStyle}>
                    {LANGUAGES.filter(l => l.code !== baseLang).map(l => (
                      <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
                    ))}
                  </select>
                </div>
                <button onClick={runComparison} disabled={comparing} style={{
                  padding: "10px 24px", background: comparing ? "#94a3b8" : "#6366f1",
                  color: "#fff", border: "none", borderRadius: 8, cursor: comparing ? "not-allowed" : "pointer",
                  fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8
                }}>
                  {comparing ? "⏳ Comparing..." : "▶ Run Comparison"}
                </button>
              </div>

              {/* Baseline status indicators */}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {[baseLang, targetLang].map(lang => {
                  const hasIt = baselines.some(b => b.language === lang);
                  const l = LANG_MAP[lang];
                  return (
                    <div key={lang} style={{
                      fontSize: 11, padding: "4px 10px", borderRadius: 6,
                      background: hasIt ? "#f0fdf4" : "#fef2f2",
                      color: hasIt ? "#15803d" : "#b91c1c",
                      border: `1px solid ${hasIt ? "#86efac" : "#fca5a5"}`
                    }}>
                      {l?.flag} {l?.label}: {hasIt ? "✅ Ready" : "❌ No baseline"}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Past results list */}
          {results.length > 0 && (
            <div style={cardStyle}>
              <div style={stepHeader}>📊 Past Comparison Runs</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {["Languages", "Score", "Translated", "Not Translated", "Overflow", "Run At", ""].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#64748b", fontWeight: 600, borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "8px 12px" }}>
                        {LANG_MAP[r.base_language]?.flag} {LANG_MAP[r.base_language]?.label}
                        {" → "}
                        {LANG_MAP[r.target_language]?.flag} {LANG_MAP[r.target_language]?.label}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ color: scoreColor(r.overall_score), fontWeight: 700 }}>
                          {r.overall_score}%
                        </span>
                      </td>
                      <td style={{ padding: "8px 12px", color: "#10b981" }}>✅ {r.translated}</td>
                      <td style={{ padding: "8px 12px", color: "#ef4444" }}>❌ {r.not_translated}</td>
                      <td style={{ padding: "8px 12px", color: "#f59e0b" }}>⚠️ {r.overflow}</td>
                      <td style={{ padding: "8px 12px", color: "#94a3b8" }}>
                        {new Date(r.run_at).toLocaleString()}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <button onClick={() => viewResult(r.id)} style={{
                          fontSize: 11, padding: "3px 10px", borderRadius: 5,
                          background: "#eff6ff", border: "1px solid #bfdbfe",
                          color: "#1d4ed8", cursor: "pointer"
                        }}>View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* RESULTS TAB */}
      {tab === "results" && activeResult && (
        <div id="ml-report" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* PDF Download Button */}
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }} className="no-print">
            <button onClick={downloadPDF} style={{
              padding:"8px 20px", background:"#dc2626", color:"#fff",
              border:"none", borderRadius:8, cursor:"pointer",
              fontWeight:700, fontSize:13, display:"flex", alignItems:"center", gap:8
            }}>
              📥 Download PDF Report
            </button>
          </div>

          {/* Overall Score */}
          <div style={{ ...cardStyle, background: "linear-gradient(135deg, #1e293b, #334155)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
              <div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>
                  {tc?.name || "Test Case"} &nbsp;|&nbsp;
                  {LANG_MAP[activeResult.base_language]?.flag} {LANG_MAP[activeResult.base_language]?.label}
                  {" → "}
                  {LANG_MAP[activeResult.target_language]?.flag} {LANG_MAP[activeResult.target_language]?.label}
                </div>
                <div style={{ fontSize: 32, fontWeight: 900, color: scoreColor(activeResult.overall_score) }}>
                  {activeResult.overall_score}%
                  <span style={{ fontSize: 14, marginLeft: 8, color: "#94a3b8" }}>
                    {scoreLabel(activeResult.overall_score)}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 24 }}>
                {[
                  { label: "Total",          value: activeResult.total_elements || activeResult.total, color: "#fff" },
                  { label: "Translated",     value: activeResult.translated,     color: "#34d399" },
                  { label: "Not Translated", value: activeResult.not_translated, color: "#f87171" },
                  { label: "Wrong Translation", value: activeResult.pages?.reduce((s,p) => s + (p.wrong_translation||0), 0) || 0, color: "#fbbf24" },
                  { label: "Overflow",       value: activeResult.overflow,       color: "#fbbf24" },
                ].map(stat => (
                  <div key={stat.label} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 24, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Page by page */}
          {(activeResult.pages || []).map((page, pi) => (
            <div key={pi} style={cardStyle}>
              {/* Page header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
                onClick={() => setExpandedPage(expandedPage === pi ? null : pi)}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#1e293b" }}>
                    📄 {page.page_title || page.url}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{page.url}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {/* Mini stats */}
                  <span style={{ fontSize: 11, color: "#10b981" }}>✅ {page.translated}</span>
                  <span style={{ fontSize: 11, color: "#ef4444" }}>❌ {page.not_translated}</span>
                  {page.overflow > 0 && <span style={{ fontSize: 11, color: "#f59e0b" }}>⚠️ {page.overflow}</span>}
                  {/* Score badge */}
                  <div style={{
                    padding: "4px 12px", borderRadius: 20, fontWeight: 700, fontSize: 12,
                    background: scoreColor(page.score) + "20", color: scoreColor(page.score),
                    border: `1px solid ${scoreColor(page.score)}40`
                  }}>{page.score}%</div>
                  {/* Progress bar */}
                  <div style={{ width: 80, height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${page.score}%`, height: "100%", background: scoreColor(page.score), borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 14, color: "#94a3b8" }}>{expandedPage === pi ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Element details */}
              {expandedPage === pi && (
                <div style={{ marginTop: 16, borderTop: "1px solid #f1f5f9", paddingTop: 16 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {["Type", "Selector", `Value (${(LANG_MAP[activeResult.base_language]?.label || activeResult.base_language || "EN").toUpperCase()})`, `Value (${(LANG_MAP[activeResult.target_language]?.label || activeResult.target_language || "EL").toUpperCase()})`, "Status", "AI Reason / Suggestion", "Overflow"].map(h => (
                          <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: "#64748b", fontWeight: 600, borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(page.elements || []).map((el, ei) => (
                        <tr key={ei} style={{
                          borderBottom: "1px solid #f8fafc",
                          background: el.status === "not_translated" ? "#fff5f5" : el.overflow ? "#fffbeb" : "transparent"
                        }}>
                          <td style={{ padding: "6px 10px" }}>
                            <span style={{
                              fontSize: 10, padding: "2px 6px", borderRadius: 4, fontWeight: 600,
                              background: el.type === "button" ? "#eff6ff" : el.type === "label" ? "#f0fdf4" : el.type === "th" ? "#fdf4ff" : "#f8fafc",
                              color: el.type === "button" ? "#1d4ed8" : el.type === "label" ? "#15803d" : el.type === "th" ? "#7e22ce" : "#64748b"
                            }}>{el.type}</span>
                          </td>
                          <td style={{ padding: "6px 10px", color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>
                            {el.selector?.slice(0, 40)}{el.selector?.length > 40 ? "..." : ""}
                          </td>
                          <td style={{ padding: "6px 10px", color: "#1e293b" }}>{el.base_text}</td>
                          <td style={{ padding: "6px 10px", color: "#1e293b" }}>{el.target_text}</td>
                          <td style={{ padding: "6px 10px" }}>
                            {el.status === "translated"
                              ? <span style={{ color: "#10b981", fontWeight: 600 }}>✅ Correct</span>
                              : el.status === "wrong_translation"
                              ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>⚠️ Wrong</span>
                              : <span style={{ color: "#ef4444", fontWeight: 600 }}>❌ Not translated</span>}
                          </td>
                          <td style={{ padding: "6px 10px", fontSize: 11, color: "#64748b" }}>
                            {/* Only show reason/suggestion for wrong or not translated */}
                            {el.status !== "translated" && el.ai_reason && (
                              <div style={{ color: "#64748b", marginBottom: 4 }}>{el.ai_reason}</div>
                            )}
                            {el.status !== "translated" && el.suggested && el.suggested !== el.base_text && (
                              <div style={{ 
                                color: el.status === "not_translated" ? "#dc2626" : "#d97706", 
                                fontWeight: 600,
                                background: el.status === "not_translated" ? "#fef2f2" : "#fffbeb",
                                padding: "3px 8px", borderRadius: 6, display: "inline-block",
                                marginTop: 2
                              }}>
                                💡 Should be: <b>{el.suggested}</b>
                              </div>
                            )}
                            {(el.status === "translated" || (!el.ai_reason && !el.suggested) || el.suggested === el.base_text) && 
                              el.status === "translated" && <span style={{ color: "#d1d5db" }}>—</span>}
                            {el.status !== "translated" && !el.ai_reason && !el.suggested && <span style={{ color: "#d1d5db" }}>—</span>}
                          </td>
                          <td style={{ padding: "6px 10px" }}>
                            {el.overflow
                              ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>⚠️ Overflow</span>
                              : <span style={{ color: "#94a3b8" }}>—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          {/* No pages */}
          {(!activeResult.pages || activeResult.pages.length === 0) && (
            <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>
              No page data available in this result.
            </div>
          )}
        </div>
      )}

      {tab === "results" && !activeResult && (
        <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🌐</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No results yet</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Run a comparison from the Setup tab</div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const cardStyle = {
  background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
  padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
};
const stepHeader = {
  fontSize: 14, fontWeight: 800, color: "#1e293b", marginBottom: 14
};
const selectStyle = {
  padding: "7px 10px", borderRadius: 7, border: "1px solid #e2e8f0",
  fontSize: 13, background: "#fff", cursor: "pointer", minWidth: 180
};
const codeStyle = {
  background: "#f1f5f9", padding: "1px 6px", borderRadius: 4,
  fontFamily: "monospace", fontSize: 11, color: "#0f172a"
};
