import React, { useState, useEffect } from "react";
import { api, s, C } from "./shared.jsx";

// -----------------------------------------------------------------------------
// Custom Controls (ISOLATED, additive) — let users teach Qavya how to recognize
// and operate a control it doesn't natively support. Pure data: recognition +
// per-keyword recipes built from a fixed, safe primitive set. No code.
// -----------------------------------------------------------------------------

// Keywords Qavya can map to a custom control. User fills only the ones that apply.
const KEYWORDS = ["click", "type", "clear", "select", "search_select", "check", "uncheck", "hover", "get_value"];

// The only allowed primitive "do" verbs — must match backend + custom_controls.py.
const PRIMITIVES = ["click", "type", "clear", "wait", "press", "click_option", "read_text", "wait_for"];

// Which fields each primitive needs (for the small form per step).
const PRIM_FIELDS = {
  click:        ["target"],
  type:         ["target", "text"],
  clear:        ["target"],
  wait:         ["ms"],
  press:        ["target", "key"],
  click_option: ["within", "matching"],
  read_text:    ["target"],
  wait_for:     ["target", "ms"],
};

const blankStep = () => ({ do: "click", target: "self" });

export default function CustomControls({ user, projects }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  // form state
  const [editing, setEditing] = useState(false);
  const [controlId, setControlId] = useState("");
  const [name, setName] = useState("");
  const [recMatches, setRecMatches] = useState("");
  const [recClosest, setRecClosest] = useState("");
  const [recRole, setRecRole] = useState("");
  const [recipes, setRecipes] = useState({}); // keyword -> [steps]

  async function loadList() {
    setLoading(true); setError("");
    try {
      const r = await api("/api/controls", { method: "GET" });
      if (!r?.ok) throw new Error(r?.error || "Failed to load");
      setList(r.controls || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { loadList(); }, []);

  function resetForm() {
    setEditing(false); setControlId(""); setName("");
    setRecMatches(""); setRecClosest(""); setRecRole(""); setRecipes({});
  }

  function startNew() {
    resetForm(); setEditing(true);
  }

  function startEdit(c) {
    setEditing(true);
    setControlId(c.control_id); setName(c.name);
    const rec = c.recognition || {};
    setRecMatches(rec.matches || ""); setRecClosest(rec.closest || ""); setRecRole(rec.role || "");
    setRecipes(c.keywords || {});
  }

  // toggle a keyword on/off
  function toggleKeyword(kw) {
    setRecipes(prev => {
      const next = { ...prev };
      if (next[kw]) delete next[kw];
      else next[kw] = [blankStep()];
      return next;
    });
  }
  function addStep(kw) {
    setRecipes(prev => ({ ...prev, [kw]: [...(prev[kw] || []), blankStep()] }));
  }
  function removeStep(kw, i) {
    setRecipes(prev => ({ ...prev, [kw]: (prev[kw] || []).filter((_, idx) => idx !== i) }));
  }
  function updateStep(kw, i, field, value) {
    setRecipes(prev => ({
      ...prev,
      [kw]: (prev[kw] || []).map((st, idx) => idx === i ? { ...st, [field]: value } : st),
    }));
  }

  async function save() {
    setError(""); setMsg("");
    if (!controlId.trim() || !name.trim()) { setError("Control id and name are required."); return; }
    if (!recMatches.trim() && !recClosest.trim() && !recRole.trim()) {
      setError("Give at least one recognition rule (matches, closest, or role)."); return;
    }
    const recognition = {};
    if (recMatches.trim()) recognition.matches = recMatches.trim();
    if (recClosest.trim()) recognition.closest = recClosest.trim();
    if (recRole.trim()) recognition.role = recRole.trim();
    try {
      const r = await api("/api/controls", { method: "POST", body: {
        control_id: controlId.trim(), name: name.trim(), recognition, keywords: recipes,
      }});
      if (!r?.ok) throw new Error(r?.error || "Save failed");
      setMsg(`Saved "${name}"`);
      resetForm();
      loadList();
    } catch (e) { setError(e.message); }
  }

  async function del(c) {
    if (!window.confirm(`Delete control "${c.name}"?`)) return;
    try {
      const r = await api(`/api/controls/${c.id}`, { method: "DELETE" });
      if (!r?.ok) throw new Error(r?.error || "Delete failed");
      loadList();
    } catch (e) { setError(e.message); }
  }

  async function exportAll() {
    try {
      const r = await api("/api/controls-export", { method: "GET" });
      if (!r?.ok) throw new Error(r?.error || "Export failed");
      const blob = new Blob([JSON.stringify({ version: 1, controls: r.controls }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "qavya_controls.json"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  async function importFile(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const controls = Array.isArray(data) ? data : (data.controls || []);
      const r = await api("/api/controls-import", { method: "POST", body: { controls } });
      if (!r?.ok) throw new Error(r?.error || "Import failed");
      setMsg(`Imported ${r.imported} control(s)` + (r.errors?.length ? `, ${r.errors.length} skipped` : ""));
      loadList();
    } catch (e) { setError(e.message); }
    ev.target.value = "";
  }

  return (
    <div style={{ padding: "20px 24px", minHeight: "80vh" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#1a2332", marginBottom: 4 }}>🧩 Custom Controls</div>
        <div style={{ fontSize: 13, color: C.textDim }}>
          Teach Qavya how to recognize and operate a control it doesn't support out of the box.
          Define how it's recognized, and what each keyword does — using safe building blocks.
        </div>
      </div>

      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#c53030" }}>
          ❌ {error} <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#c53030", float: "right" }}>×</button>
        </div>
      )}
      {msg && (
        <div style={{ background: "#e6f7f1", border: "1px solid #a7e8cf", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#00855a" }}>
          ✅ {msg} <button onClick={() => setMsg("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#00855a", float: "right" }}>×</button>
        </div>
      )}

      {!editing && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <button onClick={startNew} style={{ ...s.btn("primary") }}>+ Define New Control</button>
            <button onClick={exportAll} style={s.btn("ghost")}>⬇ Export all</button>
            <label style={{ ...s.btn("ghost"), cursor: "pointer", display: "inline-block" }}>
              ⬆ Import
              <input type="file" accept="application/json" onChange={importFile} style={{ display: "none" }} />
            </label>
          </div>

          {loading ? (
            <div style={{ fontSize: 13, color: C.textDim }}>Loading…</div>
          ) : list.length === 0 ? (
            <div style={{ ...s.card, fontSize: 13, color: C.textDim }}>
              No custom controls defined yet. Click “Define New Control” to add one.
            </div>
          ) : (
            list.map(c => (
              <div key={c.id} style={{ ...s.card, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1a2332" }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: C.textDim, fontFamily: "monospace" }}>
                    {c.control_id} · recognizes: {Object.entries(c.recognition || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} ·
                    keywords: {Object.keys(c.keywords || {}).join(", ") || "none"}
                  </div>
                </div>
                <button onClick={() => startEdit(c)} style={s.btn("ghost", true)}>Edit</button>
                <button onClick={() => del(c)} style={{ ...s.btn("ghost", true), color: "#c53030" }}>Delete</button>
              </div>
            ))
          )}
        </div>
      )}

      {editing && (
        <div style={{ ...s.card }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1a2332", marginBottom: 14 }}>Define Control</div>

          <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={s.label}>Control id (no spaces)</label>
              <input style={s.input} placeholder="fancy_dropdown" value={controlId}
                onChange={e => setControlId(e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase())} />
            </div>
            <div style={{ flex: 2, minWidth: 220 }}>
              <label style={s.label}>Display name</label>
              <input style={s.input} placeholder="Fancy Dropdown" value={name} onChange={e => setName(e.target.value)} />
            </div>
          </div>

          {/* Recognition */}
          <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 700, color: C.textMid, textTransform: "uppercase" }}>
            How is this control recognized? (fill at least one)
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={s.label}>CSS it matches</label>
              <input style={s.input} placeholder=".fancy-select" value={recMatches} onChange={e => setRecMatches(e.target.value)} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={s.label}>Inside ancestor (closest)</label>
              <input style={s.input} placeholder=".fancy-container" value={recClosest} onChange={e => setRecClosest(e.target.value)} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={s.label}>ARIA role</label>
              <input style={s.input} placeholder="combobox" value={recRole} onChange={e => setRecRole(e.target.value)} />
            </div>
          </div>

          {/* Keywords */}
          <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 700, color: C.textMid, textTransform: "uppercase" }}>
            Which keywords does it support? Tick one, then add the steps.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            {KEYWORDS.map(kw => {
              const on = !!recipes[kw];
              return (
                <button key={kw} onClick={() => toggleKeyword(kw)}
                  style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid", cursor: "pointer", fontSize: 13,
                    background: on ? "#1a6fc4" : "#fff", color: on ? "#fff" : "#1a2332",
                    borderColor: on ? "#1a6fc4" : "#e2e6ed", fontWeight: on ? 600 : 400 }}>
                  {on ? "✓ " : ""}{kw}
                </button>
              );
            })}
          </div>

          {/* Recipe builders for each enabled keyword */}
          {Object.keys(recipes).map(kw => (
            <div key={kw} style={{ border: "1px solid #e2e6ed", borderRadius: 8, padding: 12, marginBottom: 12, background: "#fafbfc" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1a6fc4", marginBottom: 8 }}>{kw} — steps</div>
              {(recipes[kw] || []).map((st, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: C.textDim, minWidth: 18 }}>{i + 1}</span>
                  <select value={st.do} onChange={e => updateStep(kw, i, "do", e.target.value)} style={{ ...s.input, width: 130, padding: "4px 8px", fontSize: 12 }}>
                    {PRIMITIVES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {(PRIM_FIELDS[st.do] || []).map(f => (
                    <input key={f} placeholder={f + (f === "text" || f === "matching" ? " (use {{value}})" : "")}
                      value={st[f] || ""} onChange={e => updateStep(kw, i, f, e.target.value)}
                      style={{ ...s.input, width: f === "ms" ? 80 : 150, padding: "4px 8px", fontSize: 12 }} />
                  ))}
                  <button onClick={() => removeStep(kw, i)} style={{ ...s.btn("ghost", true), color: "#c53030", padding: "2px 8px" }}>✕</button>
                </div>
              ))}
              <button onClick={() => addStep(kw)} style={{ ...s.btn("ghost", true), fontSize: 12 }}>+ add step</button>
            </div>
          ))}

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button onClick={save} style={s.btn("success")}>💾 Save Control</button>
            <button onClick={resetForm} style={s.btn("ghost")}>Cancel</button>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
            <b>Tips:</b> target <code>self</code> = the control itself; <code>self input</code> = an inner input;
            or any CSS selector. Use <code>{"{{value}}"}</code> where the test's value should go (e.g. in <i>type</i> text or <i>click_option</i> matching).
          </div>
        </div>
      )}
    </div>
  );
}
