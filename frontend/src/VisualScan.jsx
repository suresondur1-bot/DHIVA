import React, { useState } from "react";
import { api, s, C } from "./shared.jsx";

// Extension ID (same one Quick Scan / Smart Record message directly).
const EXT_ID = 'kjcdbdllalehljpjdfljcekgikompmkf';

// -----------------------------------------------------------------------------
// Visual Scan -- NEW, ISOLATED feature.
// User opens their app page in another Chrome tab, pastes a Figma frame link +
// token, picks a match level, and clicks Compare. The extension screenshots the
// active tab; the backend compares it to the Figma design and returns a report.
// Does not touch Quick Scan / Smart Study / Visual Testing.
// -----------------------------------------------------------------------------

const MATCH_LEVELS = [
  { key: "ai",      label: "AI (smart)", desc: "Lenient - flags only missing sections / major structure" },
  { key: "layout",  label: "Layout",     desc: "Structure & positions only - ignores text" },
  { key: "content", label: "Content",    desc: "Headings & labels must match (critical + minor)" },
  { key: "strict",  label: "Strict",     desc: "Most sensitive - text, colour, layout, pixel diff" },
];

const SEV = {
  CRITICAL: { icon: "\u{1F534}", color: "#e53935", bg: "#fdecea" },
  MINOR:    { icon: "\u{1F7E1}", color: "#f59e0b", bg: "#fef9e7" },
  COSMETIC: { icon: "\u{1F535}", color: "#1a6fc4", bg: "#e3f0fb" },
};

export default function VisualScan({ user }) {
  const [figmaUrl,   setFigmaUrl]   = useState("");
  const [figmaToken, setFigmaToken] = useState("");
  const [matchLevel, setMatchLevel] = useState("ai");
  const [threshold,  setThreshold]  = useState(5);
  const [phase,      setPhase]      = useState("idle"); // idle | scanning | done
  const [report,     setReport]     = useState(null);
  const [error,      setError]      = useState("");
  const [shot,       setShot]       = useState(null);   // captured screenshot (for JIRA attach)
  const [selected,   setSelected]   = useState({});     // index -> true
  const [jiraMsg,    setJiraMsg]    = useState("");
  const [jiraBusy,   setJiraBusy]   = useState(false);
  const [hovered,    setHovered]    = useState(null);  // index of difference being hovered/focused

  // Ask the extension in THE USER'S OWN browser to screenshot the active tab,
  // exactly like Quick Scan / Smart Record. No backend poll queue, so it can
  // never capture the server's screen.
  function captureViaExtension() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
          return resolve({ ok: false, error: "Chrome extension not available in this browser." });
        }
        chrome.runtime.sendMessage(EXT_ID, { type: "nat_visual_capture" }, (r) => {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: "Could not reach the extension. Is it installed and enabled?" });
          }
          resolve(r || { ok: false, error: "No response from extension" });
        });
        setTimeout(() => resolve({ ok: false, error: "Screenshot timed out" }), 20000);
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  async function runScan() {
    setError("");
    if (!figmaUrl.trim() || !figmaToken.trim()) {
      setError("Please paste both the Figma frame link and your Figma token.");
      return;
    }
    setReport(null);
    setSelected({});
    setJiraMsg("");
    setShot(null);
    setPhase("scanning");
    try {
      // 1) Capture the active tab directly from the user's own browser.
      const cap = await captureViaExtension();
      if (!cap || !cap.ok || !cap.screenshot) {
        throw new Error(cap?.error || "Could not capture the active screen.");
      }
      setShot(cap.screenshot);
      // 2) Send the screenshot + Figma details to the compare endpoint.
      const resp = await api("/api/visual/compare", {
        method: "POST",
        body: {
          screenshot: cap.screenshot,
          figmaUrl: figmaUrl.trim(),
          figmaToken: figmaToken.trim(),
          matchLevel,
          threshold: Number(threshold) || 5,
        },
      });
      if (!resp?.ok) throw new Error(resp?.error || "Compare failed");
      setReport(resp.report);
      setPhase("done");
    } catch (e) {
      setError(e.message);
      setPhase("idle");
    }
  }

  const sortedDiffs = (report?.differences || []).slice().sort((a, b) => {
    const order = { CRITICAL: 0, MINOR: 1, COSMETIC: 2 };
    return (order[String(a.severity).toUpperCase()] ?? 1) - (order[String(b.severity).toUpperCase()] ?? 1);
  });

  function toggle(i) {
    setSelected(prev => ({ ...prev, [i]: !prev[i] }));
  }
  function toggleAll() {
    const allOn = sortedDiffs.length > 0 && sortedDiffs.every((_, i) => selected[i]);
    const next = {};
    if (!allOn) sortedDiffs.forEach((_, i) => { next[i] = true; });
    setSelected(next);
  }
  const selectedIdx = sortedDiffs.map((_, i) => i).filter(i => selected[i]);

  function diffToText(d, n) {
    const sev = String(d.severity || "MINOR").toUpperCase();
    return `Issue #${n} [${sev}] ${d.element}\nExpected: ${d.expected}\nActual: ${d.actual}`;
  }
  // Map the difference severity to a JIRA severity value.
  function jiraSeverity(d) {
    const sev = String(d.severity || "MINOR").toUpperCase();
    if (sev === "CRITICAL") return "Critical";
    if (sev === "MINOR") return "Medium";
    return "Low";
  }

  async function postOne(d, n) {
    const summary = `[Visual Scan] ${d.element} - ${String(d.severity||"").toUpperCase()}`;
    const description =
      `Visual difference found by Visual Scan.\n\n` +
      diffToText(d, n) +
      (report?.match_level ? `\n\nMatch level: ${report.match_level}` : "") +
      (report?.diff_pct != null ? `\nPixel diff: ${report.diff_pct}%` : "");
    return api("/api/jira/post-visual", {
      method: "POST",
      body: { summary, description, severity: jiraSeverity(d), screenshot: shot },
    });
  }

  async function postSeparately() {
    if (!selectedIdx.length) { setJiraMsg("Select at least one difference first."); return; }
    setJiraBusy(true); setJiraMsg("");
    const created = [];
    try {
      for (const i of selectedIdx) {
        const r = await postOne(sortedDiffs[i], i + 1);
        if (!r?.ok) throw new Error(r?.error || "JIRA post failed");
        created.push(r.ticket_key);
      }
      setJiraMsg(`Created ${created.length} ticket(s): ${created.join(", ")}`);
    } catch (e) {
      setJiraMsg("Error: " + e.message + (created.length ? ` (already created: ${created.join(", ")})` : ""));
    } finally { setJiraBusy(false); }
  }

  async function postTogether() {
    if (!selectedIdx.length) { setJiraMsg("Select at least one difference first."); return; }
    setJiraBusy(true); setJiraMsg("");
    try {
      const body = selectedIdx.map((i, k) => diffToText(sortedDiffs[i], i + 1)).join("\n\n");
      // Highest severity among the selected drives the ticket severity.
      const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      const sev = selectedIdx
        .map(i => jiraSeverity(sortedDiffs[i]))
        .sort((a, b) => order[a] - order[b])[0] || "Medium";
      const summary = `[Visual Scan] ${selectedIdx.length} difference(s) found`;
      const description =
        `Visual differences found by Visual Scan.\n\n` + body +
        (report?.match_level ? `\n\nMatch level: ${report.match_level}` : "") +
        (report?.diff_pct != null ? `\nPixel diff: ${report.diff_pct}%` : "");
      const r = await api("/api/jira/post-visual", {
        method: "POST",
        body: { summary, description, severity: sev, screenshot: shot },
      });
      if (!r?.ok) throw new Error(r?.error || "JIRA post failed");
      setJiraMsg(`Created 1 combined ticket: ${r.ticket_key}`);
    } catch (e) {
      setJiraMsg("Error: " + e.message);
    } finally { setJiraBusy(false); }
  }

  return (
    <div style={{ padding: "20px 24px", minHeight: "80vh" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#1a2332", marginBottom: 4 }}>{"\u{1F3A8}"} Visual Scan</div>
        <div style={{ fontSize: 13, color: C.textDim }}>
          Compare the page you currently have open in Chrome against a Figma design - on demand.
        </div>
      </div>

      {/* How it works */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          { n: "1", icon: "\u{1F310}", title: "Open your page", desc: "Open the app screen you want to check in a separate Chrome tab" },
          { n: "2", icon: "\u{1F517}", title: "Paste Figma link", desc: "Paste the Figma frame URL (with node-id) and your Figma token" },
          { n: "3", icon: "\u{1F50D}", title: "Click Compare", desc: "The extension captures your active tab and compares it" },
          { n: "4", icon: "\u{1F4CB}", title: "Read the report", desc: "Differences are listed by severity with expected vs actual" },
        ].map(item => (
          <div key={item.n} style={{ flex: 1, minWidth: 150, background: "#fff", border: "1px solid #e2e6ed", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{item.icon}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#1a6fc4", letterSpacing: "0.08em", marginBottom: 3 }}>STEP {item.n}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332", marginBottom: 4 }}>{item.title}</div>
            <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.5 }}>{item.desc}</div>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#c53030" }}>
          {"\u274C"} {error}
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#c53030", float: "right" }}>{"\u00D7"}</button>
        </div>
      )}

      {/* Form */}
      <div style={{ ...s.card, marginBottom: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Figma frame link (must include node-id)</label>
          <input
            style={s.input}
            placeholder="https://www.figma.com/design/<key>/<name>?node-id=123-456"
            value={figmaUrl}
            onChange={e => setFigmaUrl(e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Figma API token (X-Figma-Token)</label>
          <input
            style={s.input}
            type="password"
            placeholder="figd_..."
            value={figmaToken}
            onChange={e => setFigmaToken(e.target.value)}
          />
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
            Get a token from Figma {"\u2192"} Settings {"\u2192"} Security {"\u2192"} Personal access tokens.
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Match level</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {MATCH_LEVELS.map(m => {
              const sel = matchLevel === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setMatchLevel(m.key)}
                  title={m.desc}
                  style={{
                    padding: "8px 16px", borderRadius: 8, border: "1px solid",
                    cursor: "pointer", fontSize: 13,
                    background: sel ? "#1a6fc4" : "#fff",
                    color: sel ? "#fff" : "#1a2332",
                    borderColor: sel ? "#1a6fc4" : "#e2e6ed",
                    fontWeight: sel ? 600 : 400,
                  }}>
                  {m.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
            {MATCH_LEVELS.find(m => m.key === matchLevel)?.desc}
          </div>
        </div>

        {matchLevel === "strict" && (
          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Pixel-diff threshold (%) - strict mode only</label>
            <input
              style={{ ...s.input, width: 120 }}
              type="number" min="0" max="100"
              value={threshold}
              onChange={e => setThreshold(e.target.value)}
            />
          </div>
        )}

        <button
          onClick={runScan}
          disabled={phase === "scanning"}
          style={{
            fontSize: 14, padding: "11px 30px", borderRadius: 10, border: "none",
            cursor: phase === "scanning" ? "default" : "pointer",
            background: phase === "scanning" ? "#9bb8d6" : "linear-gradient(135deg,#1a6fc4,#6c5ce7)",
            color: "#fff", fontWeight: 700,
          }}>
          {phase === "scanning" ? "\u23F3 Comparing..." : "\u{1F50D} Compare Active Page"}
        </button>
        {phase === "scanning" && (
          <div style={{ fontSize: 12, color: C.textDim, marginTop: 10 }}>
            Capturing your active Chrome tab and comparing with Figma... this can take up to a minute.
          </div>
        )}
      </div>

      {/* Report */}
      {phase === "done" && report && (
        <div style={{ ...s.card }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap",
            paddingBottom: 12, borderBottom: "1px solid #f0f2f5",
          }}>
            <span style={{
              background: report.failed ? "#fdecea" : "#e6f7f1",
              color: report.failed ? "#e53935" : "#00a86b",
              padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 700,
            }}>
              {report.failed ? "\u274C Differences found" : "\u2705 Matches design"}
            </span>
            <span style={{ fontSize: 12, color: C.textDim }}>
              Mode: <b>{report.match_level}</b> {"\u00B7"} Pixel diff: <b>{report.diff_pct}%</b>
              {report.match_level === "strict" ? ` (threshold ${report.threshold}%)` : ""}
            </span>
            <span style={{ fontSize: 12, color: C.textDim, marginLeft: "auto" }}>
              {"\u{1F534}"} {report.critical_count || 0} {"\u00B7"} {"\u{1F7E1}"} {report.minor_count || 0} {"\u00B7"} {"\u{1F535}"} {report.cosmetic_count || 0}
            </span>
          </div>

          {report.summary && (
            <div style={{ fontSize: 13, color: "#4a5568", marginBottom: 16, lineHeight: 1.6 }}>
              {report.summary}
            </div>
          )}

          {/* Side-by-side: Expected (Figma) vs Actual (live screenshot) */}
          <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6c5ce7", marginBottom: 6 }}>
                {"\u{1F3A8}"} Expected (Figma design)
              </div>
              <div style={{ border: "1px solid #e2e6ed", borderRadius: 8, overflow: "hidden", background: "#f8f9fc", minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {report.figma_image
                  ? <img alt="Figma design" src={`data:image/png;base64,${report.figma_image}`} style={{ width: "100%", display: "block" }} />
                  : <span style={{ fontSize: 12, color: C.textDim, padding: 24 }}>Figma image not available</span>}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#1a6fc4", marginBottom: 6 }}>
                {"\u{1F5A5}\uFE0F"} Actual (your live screen) {report.marked_actual ? "\u2014 numbered markers show each issue" : ""}
              </div>
              <div style={{ border: "1px solid #e2e6ed", borderRadius: 8, overflow: "hidden", background: "#f8f9fc", minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {(report.marked_actual || shot)
                  ? <img alt="Live screen" src={report.marked_actual ? `data:image/png;base64,${report.marked_actual}` : shot} style={{ width: "100%", display: "block" }} />
                  : <span style={{ fontSize: 12, color: C.textDim, padding: 24 }}>Screenshot not available</span>}
              </div>
            </div>
          </div>

          {sortedDiffs.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textDim }}>No specific differences reported.</div>
          ) : (
            sortedDiffs.map((d, i) => {
              const sev = String(d.severity || "MINOR").toUpperCase();
              const meta = SEV[sev] || SEV.MINOR;
              return (
                <div key={i} style={{
                  border: "1px solid #f0f2f5", borderLeft: `3px solid ${meta.color}`,
                  borderRadius: 8, padding: "10px 14px", marginBottom: 8,
                  background: hovered === i ? meta.bg : "#fff",
                  display: "flex", gap: 10, alignItems: "flex-start",
                  transition: "background 0.12s",
                }}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}>
                  <input
                    type="checkbox"
                    checked={!!selected[i]}
                    onChange={() => toggle(i)}
                    style={{ marginTop: 3, width: 16, height: 16, cursor: "pointer", flexShrink: 0 }}
                    title="Select to post to JIRA"
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332", marginBottom: 6 }}>
                      {meta.icon} Issue #{i + 1}{" "}
                      <span style={{ fontSize: 11, color: meta.color, background: meta.bg, padding: "1px 8px", borderRadius: 10, marginLeft: 4 }}>
                        {sev}
                      </span>{" "}
                      {d.element}
                    </div>
                    <div style={{ fontSize: 12, color: "#4a5568", marginBottom: 3 }}>
                      <b>Expected:</b> {d.expected}
                    </div>
                    <div style={{ fontSize: 12, color: "#4a5568" }}>
                      <b>Actual:</b> {d.actual}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* JIRA posting controls */}
          {sortedDiffs.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #f0f2f5" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: "#4a5568", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={sortedDiffs.length > 0 && sortedDiffs.every((_, i) => selected[i])}
                    onChange={toggleAll}
                    style={{ width: 16, height: 16, cursor: "pointer" }}
                  />
                  Select all
                </label>
                <span style={{ fontSize: 12, color: C.textDim }}>{selectedIdx.length} selected</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={postSeparately}
                  disabled={jiraBusy || !selectedIdx.length}
                  style={{ ...s.btn("primary"), opacity: (jiraBusy || !selectedIdx.length) ? 0.5 : 1 }}>
                  {jiraBusy ? "Posting..." : "Post selected separately"}
                </button>
                <button
                  onClick={postTogether}
                  disabled={jiraBusy || !selectedIdx.length}
                  style={{ ...s.btn("purple"), opacity: (jiraBusy || !selectedIdx.length) ? 0.5 : 1 }}>
                  {jiraBusy ? "Posting..." : "Post selected together"}
                </button>
              </div>
              {jiraMsg && (
                <div style={{ marginTop: 10, fontSize: 12,
                  color: jiraMsg.startsWith("Error") ? "#c53030" : "#00a86b" }}>
                  {jiraMsg}
                </div>
              )}
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
                “Separately” creates one JIRA ticket per selected difference. “Together” creates a single ticket listing all selected. The captured screenshot is attached.
              </div>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button onClick={() => { setPhase("idle"); setReport(null); setSelected({}); setJiraMsg(""); setShot(null); setHovered(null); }} style={s.btn("ghost")}>
              {"\u2190"} New Scan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
